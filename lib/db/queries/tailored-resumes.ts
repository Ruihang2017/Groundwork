import { and, desc, eq } from 'drizzle-orm';

import { jobs, tailoredResumes } from '@/db/schema';
import { TailoredResume } from '@/lib/schemas/persisted';
import type { Alignment, Edit } from '@/lib/schemas/pipeline';

// TLR-01 Deliverable 2 — the ONLY write path to `tailored_resumes`, and the
// read path 05-tailor/TLR-02's server code calls (it needs `getTailoredResume`
// from a React Server Component to render a previously-produced draft).
//
// PRD ANCHORS
//   §5.3  TAILOR persists an alignment table + per-edit rewrites + a full draft
//         markdown; this module is where that result lands and is read back.
//   §5.6  "写操作留 `updatedAt`" — every write bumps `updatedAt` (via
//         db/schema.ts's `.$onUpdate`, never set by hand here), and `createdAt`
//         is never touched on the update path.
//   §8.3  "全部查询以 session userId 约束、无跨用户查询路径" — `tailored_resumes`
//         has NO direct `userId` column (db/schema.ts's own note), so
//         `getTailoredResume` enforces ownership by JOINING THROUGH `jobs.userId`.
//         `upsertTailoredResume` takes no `userId` (Deliverable 2 signature): see
//         its LOAD-BEARING PRECONDITION below.
//
// BUILD-TIME SAFETY — copied verbatim from lib/db/queries/library.ts and
// lib/db/queries/jobs.ts, including the reasoning, because this module has the
// same consumer class they do. db/index.ts THROWS at import time when
// DATABASE_URL is unset (an intentional, tested FND-05 fail-fast) and
// `next build`'s "Collecting page data" phase statically imports every route
// module AND every page module. TLR-02's server component (app/(app)/jobs/[id]/
// resume/**) will import this module DIRECTLY. So: NO top-level `@/db/index`
// import — every function resolves its client through `dbIndex()` at call time,
// and this module is import-safe with no environment at all (guarded by a test).
// `@/db/schema` (table objects, no connection), `drizzle-orm` and
// `@/lib/schemas/**` are connection-free and safe to import statically.
//
// `dbIndex()` MEMOIZES the import promise, load-bearing for Vitest testability
// exactly as lib/db/queries/library.ts documents in full: the mocker re-resolves
// a `vi.doMock`-ed specifier on every `import()`, so two concurrent `import()`s
// race and one loads the real module and dies on the DATABASE_URL fail-fast. A
// rejected import is deliberately NOT cached (one transient failure must not
// poison the module for the process lifetime). Do not "simplify" this back.
//
// CONCURRENCY — accepted for v1, recorded rather than silently assumed (same
// posture LIB-02 documents for `libraries`/`resumes`): there is NO UNIQUE
// constraint on `tailored_resumes.jobId` (db/migrations/0000_legal_pandemic.sql
// creates a plain btree index only), so `onConflictDoUpdate` is unavailable and
// two SIMULTANEOUS Tailor runs for the same job could both read "no row" and both
// INSERT (two rows). Accepted: single-user single-session usage pattern assumed,
// and TLR-01's route charges `tailor` quota (max 5/day) on EVERY call so the
// blast radius is tiny. Both reads below use `ORDER BY updatedAt DESC LIMIT 1`,
// so the outcome is deterministic (newest wins) even if a duplicate slips in. The
// real fix — a UNIQUE constraint + migration — is FND-05's file-scope
// (docs/plans/TLR-01.md §4 R3); escalated, NOT added here.

/**
 * The single lazy `@/db/index` resolution point for this module (see BUILD-TIME
 * SAFETY above for why it is lazy at all, and why the promise is memoized).
 */
let dbIndexPromise: Promise<typeof import('@/db/index')> | null = null;

function dbIndex(): Promise<typeof import('@/db/index')> {
  dbIndexPromise ??= import('@/db/index').catch((err: unknown) => {
    dbIndexPromise = null;
    throw err;
  });
  return dbIndexPromise;
}

async function defaultDb() {
  const { db } = await dbIndex();
  return db;
}

/**
 * Validates a row read back from Postgres against `TailoredResume`.
 *
 * THROWS on mismatch, same loud-failure policy and reasoning as `getLibrary` /
 * `parseRow` in jobs.ts: db/schema.ts's `.$type<T>()` is compile-time only —
 * Postgres validates "is valid JSON", NOT "matches the Zod shape" — so a row
 * drifted by a future FND-03 field change must fail LOUDLY here rather than flow
 * into TLR-02's editor as a half-shaped object. Returning null was the
 * alternative and is rejected: it would present a real draft as "not found".
 *
 * The `TailoredResume` schema has no `id` field, so Zod strips the `id` column
 * that `.select()`/`.returning()` includes — the parsed value is exactly the
 * persistence + API contract.
 *
 * LOGGING: issue PATHS only. `alignment`/`edits`/`fullDraftMd` carry the user's
 * résumé data (PII) — never log the row, the values, or the raw Zod error object.
 */
function parseRow(jobId: string, row: unknown): TailoredResume {
  const parsed = TailoredResume.safeParse(row);
  if (!parsed.success) {
    console.error('[tailored-resumes] stored row does not match the TailoredResume schema', {
      jobId,
      issues: parsed.error.issues.map((i) => i.path.join('.')),
    });
    throw new Error('Stored tailored_resumes row does not match the TailoredResume schema');
  }
  return parsed.data;
}

/**
 * Insert the job's tailored résumé, or overwrite it in place if one already
 * exists — ONE row per `jobId` (docs/plans/TLR-01.md §0.1 D5).
 *
 * INTENTIONAL OVERWRITE, not a bug: re-running Tailor for a job REPLACES the
 * prior draft (PRD frames Tailor as a per-job, re-runnable action, not a
 * versioned history). This is sound here precisely because it is NOT sound in
 * FIT-02: TLR-01's route calls `checkAndIncrementQuota(userId, 'tailor')` on
 * EVERY request before the paid call, so each re-run consumes one of the 5/day
 * `tailor` units — there is no "one charge → unlimited paid calls" abuse vector
 * that forced FIT-02's `already_fitted` guard. So there is deliberately NO replay
 * guard.
 *
 * LOAD-BEARING PRECONDITION: this function takes NO `userId` and performs NO
 * ownership check. The caller (TLR-01's route) MUST have already verified job
 * ownership via `getJob(userId, jobId)` before calling this. There is no
 * `userId` column on `tailored_resumes` to scope by; ownership is the route's
 * responsibility. Do not call this with an unverified `jobId`.
 *
 * No UNIQUE constraint on `jobId` ⇒ `onConflictDoUpdate` is unavailable ⇒ the
 * select-then-update/insert pattern (identical to LIB-02's `upsertResume`).
 * `updatedAt` is bumped by `$onUpdate`, never set by hand; `createdAt` is never
 * touched on the update path.
 */
export async function upsertTailoredResume(
  jobId: string,
  alignment: Alignment,
  edits: Edit[],
  fullDraftMd: string,
): Promise<TailoredResume> {
  const db = await defaultDb();

  const [existing] = await db
    .select({ id: tailoredResumes.id })
    .from(tailoredResumes)
    .where(eq(tailoredResumes.jobId, jobId))
    .orderBy(desc(tailoredResumes.updatedAt))
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(tailoredResumes)
      .set({ alignment, edits, fullDraftMd }) // updatedAt via $onUpdate
      .where(eq(tailoredResumes.id, existing.id))
      .returning();
    return parseRow(jobId, row);
  }

  const [row] = await db
    .insert(tailoredResumes)
    .values({ jobId, alignment, edits, fullDraftMd })
    .returning();
  return parseRow(jobId, row);
}

/**
 * The job's tailored résumé, scoped to its owner by JOINING THROUGH `jobs`.
 *
 * `tailored_resumes` has no `userId` column (db/schema.ts mandates the join), so
 * ownership is enforced by `eq(jobs.userId, userId)` on the joined `jobs` row.
 * `null` covers "no tailored résumé for this job", "unknown job", AND "another
 * user's job" — the three are INDISTINGUISHABLE to the caller by design (PRD
 * §8.3; a distinguishable response would leak existence). `ORDER BY updatedAt
 * DESC LIMIT 1` makes the read deterministic if a duplicate ever slipped past
 * the missing UNIQUE constraint (newest wins).
 *
 * Exported for TLR-02; TLR-01's route does NOT call it (the route returns what
 * `upsertTailoredResume` hands back).
 */
export async function getTailoredResume(
  userId: string,
  jobId: string,
): Promise<TailoredResume | null> {
  const db = await defaultDb();
  const [row] = await db
    .select({
      jobId: tailoredResumes.jobId,
      alignment: tailoredResumes.alignment,
      edits: tailoredResumes.edits,
      fullDraftMd: tailoredResumes.fullDraftMd,
      createdAt: tailoredResumes.createdAt,
      updatedAt: tailoredResumes.updatedAt,
    })
    .from(tailoredResumes)
    .innerJoin(jobs, eq(jobs.id, tailoredResumes.jobId))
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
    .orderBy(desc(tailoredResumes.updatedAt))
    .limit(1);
  return row ? parseRow(jobId, row) : null;
}
