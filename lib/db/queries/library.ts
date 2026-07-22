import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from '@/db/schema';
import { libraries, resumes } from '@/db/schema';
import { Library, type Resume } from '@/lib/schemas/entities';

// LIB-02 Deliverable 1 — the ONLY write path to `libraries` and `resumes`, and the
// shared read path every other module's server code calls (04-fit/FIT-01 and
// FIT-03 need `hasLibrary`; 05-tailor/TLR-01 needs `getLibrary` + `getResume`;
// 03-library/LIB-03 needs both from a React Server Component).
//
// PRD ANCHORS
//   §5.1  "草稿必须经用户确认才成为库" — LIB-01's PARSE route persists nothing;
//         `confirmLibraryImport` is where a confirmed draft becomes a library.
//         Library and Resume.sourceMd are ONE confirmation unit (both or neither),
//         because 05-tailor/TLR-01's number-integrity check (FND-07's
//         `filterNumberIntegrity`) is only sound when the two are in sync.
//   §5.6  "库为资产：写操作留 `updatedAt`，删除为软删防手滑" — every write bumps
//         `updatedAt` (via db/schema.ts's `.$onUpdate`, never set by hand here),
//         and `libraries.deletedAt` is filtered on every read/upsert lookup.
//   §8.1  "原始文件解析后即弃、不落盘——只存 markdown 与结构化库" — this module
//         persists markdown and structured JSON only. Never a file byte, a path,
//         or a blob reference. Do not add one.
//   §8.3  Every statement below is `WHERE userId = ?`, including the UPDATEs that
//         already have the primary key in their WHERE (defense in depth: no
//         statement in this module can touch another user's row even if an id
//         were somehow wrong).
//
// BUILD-TIME SAFETY — deliberate, documented divergence from lib/config/quota.ts
// and lib/usage/record.ts, which both `import { db } from '@/db/index'` statically
// and rely on every caller being a route handler that imports THEM lazily.
// db/index.ts THROWS at import time when DATABASE_URL is unset (an intentional,
// tested FND-05 fail-fast), and `next build`'s "Collecting page data" phase
// statically imports every route module AND every page module. This module is
// different from quota/record: two future React Server Components
// (03-library/LIB-03's app/(app)/library/page.tsx and 04-fit/FIT-03's
// app/(app)/jobs/page.tsx) import it DIRECTLY. Requiring each of four future
// consumers to remember the lazy-import trick is exactly the foot-gun FND-08
// shipped and had to bounce-fix. So: NO top-level `@/db/index` import — each
// function resolves its client through `dbIndex()` at call time, and this module is
// import-safe with no environment at all. `@/db/schema` (table objects, no
// connection) and `drizzle-orm` are connection-free and safe to import statically.
//
// `dbIndex()` MEMOIZES the import promise, and that is load-bearing rather than a
// micro-optimization — see its own comment. docs/plans/LIB-02.md §2.1 said not to
// cache; that instruction is deviated from deliberately, with the reason recorded
// there and here.
//
// db/index.ts's comment says "ONLY the account-delete route uses `dbTx`; every
// other call site keeps `db`". This module makes that sentence stale
// (`confirmLibraryImport` needs real transactions, which the neon-http `db`
// cannot do). db/index.ts is 01-foundation-owned file-scope (breakdown-plan.md
// §3), so it is left untouched on purpose rather than edited from this ticket.
//
// CONCURRENCY — recorded verbatim per LIB-02 Feedback obligation #2:
//
//   Accepted for v1: last-write-wins on `POST /api/library`, single-user
//   single-session usage pattern assumed, no PRD requirement for concurrent-edit
//   protection.
//
// No version column, no ETag, no If-Match. Separately from that accepted content
// risk, there is NO UNIQUE constraint on `libraries.userId` / `resumes.userId`
// (db/migrations/0000_legal_pandemic.sql creates plain btree indexes only), so
// `onConflictDoUpdate` is unavailable and two simultaneous confirms could both
// read "no row" and both INSERT — which is worse than last-write-wins, because
// reads would then flip between two versions. Three in-file mitigations:
// (i) `pg_advisory_xact_lock` at the head of the confirm transaction;
// (ii) duplicate-tolerant reads (ORDER BY updatedAt DESC LIMIT 1 — newest wins);
// (iii) upserts that UPDATE by primary key. The real fix is a UNIQUE constraint +
// migration in 01-foundation's file-scope — escalated (docs/plans/LIB-02.md §5
// Q1), not done here.
//
// v1 CALL SHAPE: the app's only write entry point is `confirmLibraryImport`
// (POST /api/library). `upsertLibrary`/`upsertResume` are exported per the
// ticket's Deliverable 1 but nothing in v1 calls them standalone.

/**
 * The common supertype of every Drizzle client this module can run against: the
 * neon-http `db`, the neon-serverless `dbTx`, the `tx` handed to `.transaction()`,
 * and the PGlite client the tests inject. Exported so a caller can pass its own
 * transaction handle in (see `confirmLibraryImport`).
 */
export type Executor = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * The single lazy `@/db/index` resolution point for this module (see BUILD-TIME
 * SAFETY above for why it is lazy at all).
 *
 * The promise is MEMOIZED so that one module instance issues EXACTLY ONE
 * `import('@/db/index')`, and concurrent callers await the same in-flight promise.
 * This is not a micro-optimization — the native ESM loader already dedupes — it is
 * required for this module to be testable at all:
 *
 *   Vitest's mocker re-resolves a `vi.doMock`-ed specifier on EVERY `import()`
 *   call rather than serving it from a module cache, and two `import()`s issued
 *   in the same tick race: one gets the mock, the other loads the REAL module
 *   (verified against vitest 3.2.7 with a standalone reproduction). The route's
 *   `GET` deliberately runs `getLibrary` and `getResume` concurrently, and
 *   03-library/LIB-03's and 04-fit/FIT-03's server components will do the same, so
 *   without this memo every concurrent-read test loads the real db/index.ts and
 *   dies on its DATABASE_URL fail-fast. Sequential calls happen to work, which is
 *   exactly what makes the failure mode confusing — do not "simplify" this back.
 *
 * A rejected import is deliberately NOT cached: caching it would poison the module
 * for the process lifetime after one transient failure.
 *
 * The memo is per-module-instance, so `vi.resetModules()` (which every test in this
 * repo's DB-backed suites calls before swapping `@/db/index`) discards it — a test
 * cannot inherit the previous test's PGlite instance through it. A test that swaps
 * the mock WITHOUT resetting modules would see the stale client; that is not a
 * pattern used anywhere here, and it is the tradeoff being made.
 */
let dbIndexPromise: Promise<typeof import('@/db/index')> | null = null;

function dbIndex(): Promise<typeof import('@/db/index')> {
  dbIndexPromise ??= import('@/db/index').catch((err: unknown) => {
    dbIndexPromise = null;
    throw err;
  });
  return dbIndexPromise;
}

async function defaultDb(): Promise<Executor> {
  const { db } = await dbIndex();
  return db;
}

/**
 * The user's current library, or `null` if they have none (or only a soft-deleted
 * tombstone). `ORDER BY updatedAt DESC LIMIT 1` makes the read deterministic even
 * if a duplicate row ever slipped in past the missing UNIQUE constraint.
 *
 * THROWS (rather than returning null) when the stored jsonb does not match the
 * `Library` shape. db/schema.ts's own convention note says `.$type<T>()` is
 * compile-time only — "Postgres validates 'is valid JSON', NOT 'matches the Zod
 * shape'" — so a row drifted by a future FND-02 field change must fail loudly
 * here rather than flow into TLR-01's tailoring as a half-shaped object.
 * Returning `null` was the alternative and is deliberately rejected: it would tell
 * the user "you have no library" and invite them to import a second one.
 */
export async function getLibrary(userId: string): Promise<Library | null> {
  const db = await defaultDb();
  const [row] = await db
    .select()
    .from(libraries)
    .where(and(eq(libraries.userId, userId), isNull(libraries.deletedAt)))
    .orderBy(desc(libraries.updatedAt))
    .limit(1);
  if (!row) return null;

  const parsed = Library.safeParse({ profile: row.profile, projects: row.projects });
  if (!parsed.success) {
    // PATHS ONLY — a jsonb value here is a real person's resume data (PII). Never
    // log the row, the values, or the raw Zod error object.
    console.error('[library] stored libraries row does not match the Library schema', {
      userId,
      issues: parsed.error.issues.map((i) => i.path.join('.')),
    });
    throw new Error('Stored library row does not match the Library schema');
  }
  return parsed.data;
}

/**
 * PRD §5.7 gating ("无库时禁止新建 job"): an existing-but-EMPTY library does not
 * count as having a library. Reuses `getLibrary` rather than a bespoke COUNT so
 * there is exactly one definition of "the user's current library row" — at one row
 * per user the cost difference is irrelevant. Inherits `getLibrary`'s throw on
 * shape drift by design (loud beats silently-wrong).
 */
export async function hasLibrary(userId: string): Promise<boolean> {
  const library = await getLibrary(userId);
  return library !== null && library.projects.length > 0;
}

/**
 * The user's persisted source resume markdown, or `null`.
 *
 * Deliberately does NOT Zod-parse, unlike `getLibrary`: `sourceMd` and `updatedAt`
 * are NOT NULL scalar columns whose Drizzle types already guarantee
 * `string`/`number`. There is no jsonb shape that can drift here, so a re-validation
 * would assert nothing. The asymmetry is a decision, not an oversight.
 */
export async function getResume(userId: string): Promise<Resume | null> {
  const db = await defaultDb();
  const [row] = await db
    .select({ sourceMd: resumes.sourceMd, updatedAt: resumes.updatedAt })
    .from(resumes)
    .where(eq(resumes.userId, userId))
    .orderBy(desc(resumes.updatedAt))
    .limit(1);
  return row ? { sourceMd: row.sourceMd, updatedAt: row.updatedAt } : null;
}

/**
 * Insert the user's library row, or update it in place if one already exists.
 *
 * `executor` is ADDITIVE and optional — the ticket's Deliverable 1 signature still
 * holds. It exists so `confirmLibraryImport` can run this inside its transaction,
 * which is what lets one implementation serve both the standalone and the
 * transactional path. Called standalone (no `executor`) this does NOT take the
 * per-user advisory lock `confirmLibraryImport` takes; nothing in v1 does that, but
 * a future caller should know what it is opting out of.
 *
 * `updatedAt` is never set by hand — `.$onUpdate(() => Date.now())` in
 * db/schema.ts owns it (and `$defaultFn` owns it on insert), and `createdAt` is
 * never touched on the update path.
 *
 * `isNull(deletedAt)` in the lookup means a soft-deleted row is never resurrected
 * or overwritten: a confirm after a (future) soft delete inserts a fresh active row
 * and leaves the tombstone alone. v1 exposes NO delete endpoint at all, so this is
 * forward-compatibility for a future delete ticket, not live behavior.
 */
export async function upsertLibrary(
  userId: string,
  library: Library,
  executor?: Executor,
): Promise<void> {
  const db = executor ?? (await defaultDb());
  const [existing] = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(and(eq(libraries.userId, userId), isNull(libraries.deletedAt)))
    .orderBy(desc(libraries.updatedAt))
    .limit(1);

  if (existing) {
    await db
      .update(libraries)
      .set({ profile: library.profile, projects: library.projects }) // updatedAt via $onUpdate
      // `eq(userId)` alongside the primary key — PRD §8.3 defense in depth.
      .where(and(eq(libraries.id, existing.id), eq(libraries.userId, userId)));
    return;
  }
  await db
    .insert(libraries)
    .values({ userId, profile: library.profile, projects: library.projects });
}

/**
 * Insert the user's resume row, or overwrite `sourceMd` in place if one exists.
 * Same `executor` contract as `upsertLibrary`.
 *
 * `resumes` has no `deletedAt` by design (FND-05): a resume has no lifecycle
 * independent of its owning user's library, so rows are overwritten on re-import
 * rather than soft-deleted.
 */
export async function upsertResume(
  userId: string,
  sourceMd: string,
  executor?: Executor,
): Promise<void> {
  const db = executor ?? (await defaultDb());
  const [existing] = await db
    .select({ id: resumes.id })
    .from(resumes)
    .where(eq(resumes.userId, userId))
    .orderBy(desc(resumes.updatedAt))
    .limit(1);

  if (existing) {
    await db
      .update(resumes)
      .set({ sourceMd }) // updatedAt via $onUpdate
      .where(and(eq(resumes.id, existing.id), eq(resumes.userId, userId)));
    return;
  }
  await db.insert(resumes).values({ userId, sourceMd });
}

/**
 * PRD §5.1's confirmation step: persist the confirmed `Library` and the source
 * `Resume.sourceMd` together, atomically. Both writes or neither — a confirmation
 * must never leave the library updated but the source resume stale (or vice
 * versa), because 05-tailor/TLR-01's number-integrity guardrail reads both and is
 * only sound when they agree.
 *
 * Uses `dbTx` (neon-serverless): the neon-http `db` CANNOT do multi-statement
 * transactions — its `.transaction()` throws unconditionally (see db/index.ts).
 */
export async function confirmLibraryImport(
  userId: string,
  library: Library,
  resumeMd: string,
): Promise<void> {
  const { dbTx } = await dbIndex(); // lazy + memoized — see dbIndex()
  await dbTx.transaction(async (tx) => {
    // Serializes concurrent confirmations for THIS user only. Not optimistic
    // locking and NOT a change to last-write-wins semantics (that stays accepted,
    // see the header): it exists solely to defend this ticket's "exactly one row
    // per user" acceptance item, because there is no UNIQUE constraint on userId
    // to stop two simultaneous confirms from both finding "no row" and both
    // INSERTing (docs/plans/LIB-02.md §4 R1 / §5 Q1). Transaction-scoped: released
    // on COMMIT or ROLLBACK, and it is always the same single lock, so it cannot
    // deadlock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
    await upsertLibrary(userId, library, tx);
    await upsertResume(userId, resumeMd, tx);
  });
}
