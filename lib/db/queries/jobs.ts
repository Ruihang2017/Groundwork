import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { jobs } from '@/db/schema';
import { Job, type JobStatus } from '@/lib/schemas/persisted';
// FitReport / Ledger / JdExtract are each a Zod schema AND (via `export type`) the
// inferred type of the same name — the value import serves both uses below.
import { FitReport, JdExtract, Ledger } from '@/lib/schemas/pipeline';

// FIT-01 Deliverable 2 — the ONLY write path to `jobs`, and the shared read path
// every other module's server code calls (04-fit/FIT-02 needs `getJob` +
// `attachLedgerAndFit`; 04-fit/FIT-03 needs `getJob` and will append `listJobs`;
// 05-tailor and 06-prep need `getJob` + `updateJobStatus`).
//
// PRD ANCHORS
//   §5.6  "写操作留 `updatedAt`" — every write bumps `updatedAt` via db/schema.ts's
//         `.$onUpdate`, NEVER set by hand here. `jobs` has no `deletedAt`: FND-05
//         deliberately gave it no soft-delete column, and v1 exposes no delete
//         endpoint at all.
//   §5.6  Job.status ∈ screening|applied|interviewing|closed. A new job starts at
//         'screening' — the funnel's first state (§4 "建库（一次）→ 筛（每个 JD）").
//   §8.3  "全部查询以 session userId 约束、无跨用户查询路径" — EVERY statement below
//         carries `eq(jobs.userId, userId)`, including the UPDATEs that already have
//         the primary key in their WHERE (defense in depth: no statement in this
//         module can touch another user's row even if an id were somehow wrong).
//         Ownership failure is a `null` return, never a distinguishable error — the
//         caller cannot tell "no such job" from "not your job" (ticket Deliverable
//         2: a different response for the two would itself leak existence).
//
// THE PersistedJob / Job SPLIT (docs/plans/FIT-01.md §0.1 resolution R-A)
//
// FND-04's Zod `Job` requires `jd`, `ledger` AND `fit`. That is the COMPLETE-Job
// API contract and it is deliberately left alone. But "Fit" is one user-facing
// operation delivered as TWO server calls: FIT-01's POST /api/jobs creates the row
// with `jd` only, and FIT-02's POST /api/jobs/[id]/fit fills `ledger` + `fit`
// together. So the PERSISTENCE contract is weaker than the API contract, and this
// module owns it: `PersistedJob` = `Job` with `ledger`/`fit` nullable. Migration
// 0003 relaxed the two columns to match. `jd` stays required on both sides.
// The amendment is recorded in FND-04's and FND-05's changelogs and requires
// Horace's sign-off at the merge gate.
//
// `ledger` and `fit` must always be written TOGETHER — there is no legitimate
// "ledger but no fit" state. Nothing in the database enforces that pairing; this
// module does, by only ever setting the two in one statement (`attachLedgerAndFit`).
//
// BUILD-TIME SAFETY — copied verbatim from lib/db/queries/library.ts, including
// its reasoning, because this module has the same two consumers-classes it does.
// db/index.ts THROWS at import time when DATABASE_URL is unset (an intentional,
// tested FND-05 fail-fast) and `next build`'s "Collecting page data" phase
// statically imports every route module AND every page module. FIT-03's server
// components (app/(app)/jobs/**) will import this module DIRECTLY. So: NO top-level
// `@/db/index` import — every function resolves its client through `dbIndex()` at
// call time, and this module is import-safe with no environment at all (guarded by
// a test). `@/db/schema` (table objects, no connection), `drizzle-orm`, `zod` and
// `@/lib/schemas/**` are connection-free and safe to import statically.
//
// CONCURRENCY — accepted for v1, recorded rather than silently assumed:
//   * `updateJobStatus` is LAST-WRITE-WINS. No version column, no If-Match. Two
//     concurrent status PATCHes leave whichever committed last; `updatedAt` tells
//     you when, not who.
//   * `attachLedgerAndFit` is an UNCONDITIONAL OVERWRITE — a second call replaces an
//     existing ledger/fit. There is deliberately NO "already fitted" guard in v1, so
//     that FIT-02's Architect pass can choose its own replay policy (docs/plans/
//     FIT-01.md §5 Q4). If FIT-02 wants idempotency, it adds the guard THERE or asks
//     for one here — do not add one speculatively.
//   * Nothing dedupes job creation: two POSTs with the same JD create two jobs. No
//     PRD requirement says otherwise.
//
// `attachLedgerAndFit` is exported for FIT-02 and is NOT called by any FIT-01 code
// path except this module's own tests — same-lane sequential reuse, per the ticket's
// Deliverable 2.

/**
 * The DB-facing Job contract: FND-04's `Job` with `ledger`/`fit` nullable. See the
 * PersistedJob / Job split note above. Module-local by breakdown-plan.md §3 ("此后
 * 任何模块新增的 Zod 类型必须落在自己模块目录下") — do NOT move this into
 * lib/schemas/**, and do NOT relax FND-04's `Job` to match it.
 */
export const PersistedJob = Job.extend({
  ledger: Ledger.nullable(),
  fit: FitReport.nullable(),
});
export type PersistedJob = z.infer<typeof PersistedJob>;

/**
 * The single lazy `@/db/index` resolution point for this module (see BUILD-TIME
 * SAFETY above for why it is lazy at all).
 *
 * The promise is MEMOIZED, and that is load-bearing for testability rather than a
 * micro-optimization: Vitest's mocker re-resolves a `vi.doMock`-ed specifier on
 * EVERY `import()` call, so two `import()`s issued in the same tick race and one
 * gets the REAL module — which then dies on db/index.ts's DATABASE_URL fail-fast.
 * FIT-03's server components will read several jobs concurrently. Do not
 * "simplify" this back to a bare dynamic import; lib/db/queries/library.ts carries
 * the full write-up of the failure mode.
 *
 * A rejected import is deliberately NOT cached — one transient failure must not
 * poison the module for the process lifetime.
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
 * Validates a row read back from Postgres against `PersistedJob`.
 *
 * THROWS on mismatch, same policy and same reasoning as `getLibrary`: db/schema.ts's
 * `.$type<T>()` is compile-time only — Postgres validates "is valid JSON", NOT
 * "matches the Zod shape" — so a row drifted by a future FND-03 field change must
 * fail LOUDLY here rather than flow into FIT-02's CROSS or FIT-03's report as a
 * half-shaped object. Returning null was the alternative and is rejected: it would
 * present a real job as "not found" and invite the user to re-run a paid Fit.
 *
 * LOGGING: issue PATHS only. A `jd` jsonb holds the user's pasted JD (often with
 * their own annotations) — never log the row, the values, or the raw Zod error.
 */
function parseRow(userId: string, row: unknown): PersistedJob {
  const parsed = PersistedJob.safeParse(row);
  if (!parsed.success) {
    console.error('[jobs] stored jobs row does not match the PersistedJob schema', {
      userId,
      jobId: (row as { id?: unknown } | null)?.id,
      issues: parsed.error.issues.map((i) => i.path.join('.')),
    });
    throw new Error('Stored job row does not match the PersistedJob schema');
  }
  return parsed.data;
}

/**
 * Creates the user's job row from READ's output. `status` is always 'screening'
 * (PRD §5.6 / §4's funnel — a caller cannot choose the initial state), and
 * `ledger`/`fit` are left NULL for FIT-02 to fill.
 *
 * `id`, `createdAt` and `updatedAt` come from db/schema.ts's `$defaultFn` — never
 * set by hand, and never accepted from a caller.
 */
export async function createJob(
  userId: string,
  company: string,
  role: string,
  jdRaw: string,
  jd: JdExtract,
): Promise<PersistedJob> {
  const db = await defaultDb();
  const [row] = await db
    .insert(jobs)
    .values({ userId, company, role, status: 'screening', jdRaw, jd })
    .returning();
  return parseRow(userId, row);
}

/**
 * One job, scoped to its owner. `null` when the id does not exist OR when it
 * belongs to another user — the two are INDISTINGUISHABLE to the caller by design
 * (PRD §8.3; the routes turn both into an identical 404 body).
 */
export async function getJob(userId: string, jobId: string): Promise<PersistedJob | null> {
  const db = await defaultDb();
  const [row] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
    .limit(1);
  return row ? parseRow(userId, row) : null;
}

/**
 * Moves a job to `status`. Returns the updated row, or `null` when no row matched
 * (unknown id, or another user's job — again indistinguishable).
 *
 * DELIBERATE DEVIATION from the ticket's literal Deliverable 5 wording ("verifies
 * the job belongs to the caller (via `getJob`), calls `updateJobStatus`"): ownership
 * is enforced INSIDE this single scoped `UPDATE ... RETURNING` rather than by a
 * preceding read. Strictly safer (no read-then-write TOCTOU window in which
 * ownership could change) and one round-trip instead of two, with the same
 * observable behavior — another user's job still yields a 404. Recorded in the
 * ticket's Changelog / Deviations.
 *
 * NO STATE-MACHINE ORDERING is enforced beyond enum validity: PRD names no
 * ordering rule (it specifies only the `interviewing` trigger, §5.4), and inventing
 * one here would silently break TLR-02's "mark as applied" and PRP-03's "I got an
 * interview" buttons. Any of the four values is reachable from any other.
 *
 * `updatedAt` is bumped by `$onUpdate`, never set here.
 */
export async function updateJobStatus(
  userId: string,
  jobId: string,
  status: JobStatus,
): Promise<PersistedJob | null> {
  const db = await defaultDb();
  const [row] = await db
    .update(jobs)
    .set({ status }) // updatedAt via $onUpdate
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
    .returning();
  return row ? parseRow(userId, row) : null;
}

/**
 * FIT-02's write: fills `ledger` and `fit` TOGETHER in one statement (see the
 * "written together" rule in the header — the database does not enforce it, this
 * function does). Returns the completed row, or `null` when no row matched.
 *
 * CONTRACT FIT-02 INHERITS: this is an UNCONDITIONAL OVERWRITE. Calling it twice on
 * one job replaces the first result; there is no "already fitted" guard in v1 (§5
 * Q4 — deliberately left for FIT-02's Architect pass to decide, since it is the
 * ticket that owns the replay surface). Nothing in FIT-01 calls this except tests.
 */
export async function attachLedgerAndFit(
  userId: string,
  jobId: string,
  ledger: Ledger,
  fit: FitReport,
): Promise<PersistedJob | null> {
  const db = await defaultDb();
  const [row] = await db
    .update(jobs)
    .set({ ledger, fit }) // updatedAt via $onUpdate
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
    .returning();
  return row ? parseRow(userId, row) : null;
}
