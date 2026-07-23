import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { briefs, jobs } from '@/db/schema';
import { Brief } from '@/lib/schemas/persisted';
import { Rehearse, RehearseQuestion, type Intel } from '@/lib/schemas/pipeline';

// PRP-02 Deliverable 2 — the ONLY write path to `briefs`, and the read path
// 06-prep/PRP-04's server code will call (`getBrief`) to render a
// previously-produced rehearsal brief from a React Server Component.
//
// PRD ANCHORS
//   §5.4  REHEARSE persists questions[5] + askThem[3] + positioning as the Brief's
//         `rehearse`, alongside the optional RESEARCH `intel`; this module is where
//         that result lands and is read back.
//   §5.6  Brief.rehearse REQUIRED, Brief.intel nullable; "写操作留 updatedAt" — every
//         write bumps `updatedAt` (via db/schema.ts's `.$onUpdate`, never set by hand),
//         and `createdAt` is never touched on the update path.
//   §5.5 layer 1  the route drops questions whose projectId is not in the library
//         BEFORE calling upsertBrief, so `rehearse` handed in here may already have
//         FEWER than 5 questions — see the D5 note below.
//   §8.3  "全部查询以 session userId 约束、无跨用户查询路径" — `briefs` has NO direct
//         `userId` column (db/schema.ts), so `getBrief` enforces ownership by JOINING
//         THROUGH `jobs.userId`. `upsertBrief` takes no `userId`: see its LOAD-BEARING
//         PRECONDITION below.
//
// BUILD-TIME SAFETY — copied verbatim from lib/db/queries/tailored-resumes.ts,
// including the reasoning, because this module has the same consumer class. db/index.ts
// THROWS at import time when DATABASE_URL is unset (an intentional, tested FND-05
// fail-fast) and `next build`'s "Collecting page data" phase statically imports every
// route module AND every page module. PRP-04's server component (app/(app)/jobs/[id]/
// prep/**) will import this module DIRECTLY. So: NO top-level `@/db/index` import —
// every function resolves its client through `dbIndex()` at call time, and this module
// is import-safe with no environment at all (guarded by a test). `@/db/schema` (table
// objects, no connection), `drizzle-orm`, `zod` and `@/lib/schemas/**` are
// connection-free and safe to import statically.
//
// `dbIndex()` MEMOIZES the import promise, load-bearing for Vitest testability exactly
// as lib/db/queries/tailored-resumes.ts documents in full: the mocker re-resolves a
// `vi.doMock`-ed specifier on every `import()`, so two concurrent `import()`s race and
// one loads the real module and dies on the DATABASE_URL fail-fast. A rejected import is
// deliberately NOT cached. Do not "simplify" this back.
//
// CONCURRENCY — accepted for v1, recorded rather than silently assumed (same posture
// tailored-resumes.ts documents): there is NO UNIQUE constraint on `briefs.jobId`
// (db/migrations/0000_legal_pandemic.sql creates a plain btree index only), so
// `onConflictDoUpdate` is unavailable and two SIMULTANEOUS REHEARSE runs for the same
// job could both read "no row" and both INSERT (two rows). SHARPER than TLR-01's caveat
// because PRP-02's route charges NOTHING per call (the `prep` unit was charged upstream
// at PRP-01/RESEARCH), so a re-run is free — but the org-wide breaker plus the
// single-flight UI instruction (route header) bound it, and both reads below use
// `ORDER BY updatedAt DESC LIMIT 1` so the outcome is deterministic (newest wins). The
// real fix — a UNIQUE constraint + migration — is FND-05's file-scope
// (docs/plans/PRP-02.md §4 R4); escalated, NOT added here.

// ---------------------------------------------------------------------------
// D5 (docs/plans/PRP-02.md §0.1) — THE LOAD-BEARING DECISION of this ticket.
//
// FND-03's `Rehearse.questions` is `.length(5)` EXACTLY. But PRD §5.5 layer 1 drops a
// question whose projectId is not in the library (the route's filterByReferentialIntegrity
// step), and the ticket's acceptance item 5 requires that dropped question to be REMOVED
// from the persisted rehearse and counted. So a persisted Brief can legitimately carry
// 0–5 questions — which is NOT a valid FND-03 `Rehearse`.
//
// This module cannot relax FND-03 (`lib/schemas/**` is 01-foundation's file-scope). So it
// defines a MODULE-LOCAL relaxed persisted shape (allowed by breakdown-plan.md §3: "任何
// 模块新增的 Zod 类型必须落在自己模块目录下"; FIT-02 defines `CrossOutput` locally the same
// way). It reuses FND-03/FND-04's shapes via `.extend()` so the persisted contract is a
// SUPERSET of `Brief` with exactly one relaxed constraint (questions .length(5) → .max(5))
// and cannot drift from them. The strict FND-03 `Rehearse.length(5)` still applies to the
// route's PRE-FILTER model-output parse; only the persistence round-trip uses this relaxed
// shape.
//
// The durable fix — relaxing FND-03 itself, or redefining the drop behaviour — is a schema
// + product decision for Horace / 01-foundation (plan §5 Q1 / §6 ADR-A), coordinated with
// EVL-02's assertQ1Questions (which FAILS on < 5) and PRP-04's read path. NOT this ticket's
// to change in FND-03.
// ---------------------------------------------------------------------------
const PersistedRehearse = Rehearse.extend({
  questions: z.array(RehearseQuestion).max(5),
});
const PersistedBrief = Brief.extend({ rehearse: PersistedRehearse });
type PersistedBrief = z.infer<typeof PersistedBrief>;

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
 * Validates a row read back from Postgres against the relaxed `PersistedBrief` (D5).
 *
 * THROWS on mismatch, same loud-failure policy and reasoning as `getTailoredResume` /
 * `parseRow` in tailored-resumes.ts: db/schema.ts's `.$type<T>()` is compile-time only —
 * Postgres validates "is valid JSON", NOT "matches the Zod shape" — so a row drifted by a
 * future FND-03/FND-04 field change must fail LOUDLY here rather than flow into PRP-04's
 * viewer as a half-shaped object. Returning null was the alternative and is rejected: it
 * would present a real brief as "not found".
 *
 * `PersistedBrief` has no `id` field, so Zod strips the `id` column that
 * `.select()`/`.returning()` includes — the parsed value is exactly the persistence + API
 * contract.
 *
 * LOGGING: issue PATHS only. `intel`/`rehearse` carry the user's company research and
 * project-anchored questions (user-linked content) — never log the row, the values, or
 * the raw Zod error object.
 */
function parseRow(jobId: string, row: unknown): PersistedBrief {
  const parsed = PersistedBrief.safeParse(row);
  if (!parsed.success) {
    console.error('[briefs] stored row does not match the Brief schema', {
      jobId,
      issues: parsed.error.issues.map((i) => i.path.join('.')),
    });
    throw new Error('Stored briefs row does not match the Brief schema');
  }
  return parsed.data;
}

/**
 * Insert the job's rehearsal brief, or overwrite it in place if one already exists —
 * ONE Brief per `jobId` (docs/plans/PRP-02.md §0.1 D13).
 *
 * INTENTIONAL OVERWRITE, not a bug: re-running Prep REPLACES the prior Brief (the ticket
 * frames REHEARSE as a per-job, re-runnable action after a fresh RESEARCH, not a versioned
 * history), matching TLR-01's `upsertTailoredResume` re-run pattern. So there is
 * deliberately NO `already_rehearsed` replay guard here.
 *
 * COST-ASYMMETRY vs TLR-01 (plan §4 R1 / §5 Q2, flagged not buried): TLR-01's route
 * charges `tailor` quota on EVERY call, so its overwrite is self-limiting. PRP-02's route
 * charges NOTHING per call (the one `prep` unit was charged upstream at PRP-01/RESEARCH),
 * so an unguarded overwriting REHEARSE can be re-POSTed indefinitely per single `prep`
 * unit — the exact vector FIT-02 closed with `409 already_fitted`. The ticket nonetheless
 * SPECIFIES overwrite, so the guard is NOT added here; it is bounded by the org-wide
 * breaker + the single-flight UI instruction (route header) and escalated to Horace.
 *
 * The `rehearse` arg may already be POST-referential-integrity (FEWER than 5 questions) —
 * that is exactly why `PersistedRehearse` relaxes the length (D5 above). Its parameter type
 * is FND-03's strict `Rehearse` because that is the pipeline contract the route holds; the
 * relaxed shape is only for the row round-trip.
 *
 * LOAD-BEARING PRECONDITION: this function takes NO `userId` and performs NO ownership
 * check. The caller (PRP-02's route) MUST have already verified job ownership via
 * `getJob(userId, jobId)` before calling this — that getJob IS the sole ownership gate for
 * the write (plan §4 S2). There is no `userId` column on `briefs` to scope by. Do not call
 * this with an unverified `jobId`.
 *
 * No UNIQUE constraint on `jobId` ⇒ `onConflictDoUpdate` is unavailable ⇒ the
 * select-then-update/insert pattern (identical to tailored-resumes.ts's `upsertTailoredResume`).
 * `updatedAt` is bumped by `$onUpdate`, never set by hand; `createdAt` is never touched on
 * the update path. `intel` is written straight to the nullable `jsonb` column (`null` when
 * the arg is `null` — acceptance item 6).
 */
export async function upsertBrief(
  jobId: string,
  intel: Intel | null,
  rehearse: Rehearse,
): Promise<PersistedBrief> {
  const db = await defaultDb();

  const [existing] = await db
    .select({ id: briefs.id })
    .from(briefs)
    .where(eq(briefs.jobId, jobId))
    .orderBy(desc(briefs.updatedAt))
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(briefs)
      .set({ intel, rehearse }) // updatedAt via $onUpdate
      .where(eq(briefs.id, existing.id))
      .returning();
    return parseRow(jobId, row);
  }

  const [row] = await db.insert(briefs).values({ jobId, intel, rehearse }).returning();
  return parseRow(jobId, row);
}

/**
 * The job's rehearsal brief, scoped to its owner by JOINING THROUGH `jobs`.
 *
 * `briefs` has no `userId` column (db/schema.ts mandates the join), so ownership is
 * enforced by `eq(jobs.userId, userId)` on the joined `jobs` row. `null` covers "no brief
 * for this job", "unknown job", AND "another user's job" — the three are INDISTINGUISHABLE
 * to the caller by design (PRD §8.3; a distinguishable response would leak existence).
 * `ORDER BY updatedAt DESC LIMIT 1` makes the read deterministic if a duplicate ever
 * slipped past the missing UNIQUE constraint (newest wins).
 *
 * Exported for PRP-04; PRP-02's route does NOT call it (the route returns what
 * `upsertBrief` hands back). PRP-04 must consume THIS relaxed value directly and must NOT
 * re-parse it against the strict FND-03 `Brief` (plan §4 R2b).
 */
export async function getBrief(userId: string, jobId: string): Promise<PersistedBrief | null> {
  const db = await defaultDb();
  const [row] = await db
    .select({
      jobId: briefs.jobId,
      intel: briefs.intel,
      rehearse: briefs.rehearse,
      createdAt: briefs.createdAt,
      updatedAt: briefs.updatedAt,
    })
    .from(briefs)
    .innerJoin(jobs, eq(jobs.id, briefs.jobId))
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
    .orderBy(desc(briefs.updatedAt))
    .limit(1);
  return row ? parseRow(jobId, row) : null;
}
