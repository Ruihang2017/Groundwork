import { and, count, countDistinct, eq, gte, isNull, sql, sum } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from '@/db/schema';
import {
  briefs,
  jobs,
  libraries,
  tailoredResumes,
  usageEvents,
  usageOpEnum,
  users,
} from '@/db/schema';
import type { UsageOp } from '@/lib/schemas/persisted';

// -----------------------------------------------------------------------------
// PLT-03 — /admin observability aggregations (PRD §8.4: "`/admin` 页汇总周成本、
// p50/p95、dropped 率、漏斗转化。不上 APM——一张表加一页汇总就是这个量级
// observability 的全部").
//
// READ THIS HEADER BEFORE ADDING ANYTHING TO THIS FILE.
//
// 1. THIS MODULE IS THE ONE DELIBERATE EXCEPTION TO PRD §8.3's "全部查询以
//    session userId 约束" — the rule lib/db/queries/library.ts's header restates
//    and every route enforces via requireUserId(). Every query below is
//    intentionally CROSS-USER. That is safe only because every caller is
//    admin-gated (middleware.ts's /admin 403 plus app/(admin)/admin/page.tsx's
//    own isAdminEmail() check, which runs BEFORE any of these functions).
//    NEVER import this module from a user-facing route, page, or component —
//    lib/db/queries/admin.test.ts enforces the single-importer rule mechanically.
//
// 2. NO FUNCTION HERE TAKES A `userId`, EVER, and every one returns scalars or
//    ratios only — never a row, never an id, never an email, never a company or
//    job title. Those two properties are the STRUCTURAL guarantee that this
//    module cannot become the per-user drill-down the ticket's Non-goals forbid
//    ("show me user X's usage history"). Resumes are PII and PRD §8.3/§12 name
//    PII leakage as a top-2 risk: a future "just add the user id for debugging"
//    edit is a privacy regression needing a product decision, not a refactor.
//
// 3. BUILD-TIME SAFETY: no top-level `@/db/index` import — see dbIndex() below.
//
// 4. READS ONLY. Nothing here writes; FND-10's lib/usage/record.ts write path and
//    the usage_events columns are untouched (ticket File-scope: read/import only).
//
// 5. COERCION RULE, stated once and applied at EVERY numeric read: values leave
//    this module through `Number(x ?? 0)`. drizzle's sum() maps its result with
//    String (drizzle-orm/sql/functions/aggregate.js) while count() maps with
//    Number, and Postgres bigint parsing differs between the two drivers this
//    code runs on — PGlite in tests, neon-http in production. This rule is what
//    makes that substitution safe; a miss produces string concatenation or NaN
//    that PGlite-backed tests may not catch.
// -----------------------------------------------------------------------------

// db/index.ts THROWS at import time when DATABASE_URL is unset (an intentional,
// tested FND-05 fail-fast), and `next build`'s "Collecting page data" phase
// statically imports every page module — including app/(admin)/admin/page.tsx,
// which imports this file. A top-level `import { db } from '@/db/index'` here
// would therefore break `pnpm build` on any checkout or CI runner with no
// DATABASE_URL — the exact failure FND-08 shipped and had to bounce-fix.
// (lib/config/quota.ts and lib/usage/record.ts DO import it statically; that is
// safe only because nothing under app/** imports them.)
//
// The promise is MEMOIZED so one module instance issues EXACTLY ONE
// import('@/db/index') and concurrent callers await the same in-flight promise.
// Load-bearing, not a micro-optimization (verbatim the reason
// lib/db/queries/library.ts:96-118 records): vitest's mocker re-resolves a
// vi.doMock-ed specifier on EVERY import() call, and two import()s issued in the
// same tick race — one gets the mock, the other loads the REAL module and dies on
// the DATABASE_URL fail-fast. app/(admin)/admin/page.tsx calls all four functions
// inside ONE Promise.all, which is precisely that same-tick concurrency. Do not
// "simplify" this back. A REJECTED import is deliberately not cached, so one
// transient failure does not poison the module for the process lifetime.
let dbIndexPromise: Promise<typeof import('@/db/index')> | null = null;

function dbIndex(): Promise<typeof import('@/db/index')> {
  dbIndexPromise ??= import('@/db/index').catch((err: unknown) => {
    dbIndexPromise = null;
    throw err;
  });
  return dbIndexPromise;
}

/** The read-only neon-http client. Never `dbTx` — nothing in this module writes. */
async function defaultDb(): Promise<Executor> {
  const { db } = await dbIndex();
  return db;
}

/**
 * The common supertype of every Drizzle client these queries can run against: the
 * neon-http `db` and the PGlite client the tests inject.
 *
 * Defined LOCALLY, mirroring lib/db/queries/library.ts:85-89, rather than
 * imported from that 03-library-owned file: a 4-line type alias is cheaper than a
 * cross-module coupling between two modules with opposite scoping rules. The
 * duplication is deliberate.
 */
export type Executor = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * `executor` and `now` are ADDITIVE and optional — the ticket's stated signatures
 * (`getWeeklyCost(): Promise<number>` etc.) still hold when called with no
 * arguments, which is how the page calls them. Same precedent LIB-02 set with
 * `upsertLibrary(..., executor?)`.
 *
 * `now` exists so window-boundary tests are exact instead of racing the wall
 * clock, without fake timers (PGlite drives a WASM runtime through async
 * scheduling; its interaction with faked timers is unverified in this repo).
 * `executor` exists so tests can hand in a PGlite client directly.
 */
export type AdminQueryOptions = { executor?: Executor };
export type WindowedQueryOptions = AdminQueryOptions & { now?: number };

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Inclusive lower bound of the window (ticket: "createdAt >= <7 days ago>"), a
 * ROLLING 7 days — deliberately NOT a calendar week. Do not "fix" this into
 * date_trunc('week', ...): PRD §8.4 says "周成本" and the ticket spells the
 * window out as a relative offset.
 *
 * usage_events.createdAt is bigint(mode:'number') epoch-ms (db/schema.ts
 * convention #1), so this is plain number arithmetic — no Date objects, no
 * timezone. Same shape lib/config/quota.ts already uses.
 */
function windowStart(opts?: WindowedQueryOptions): number {
  return (opts?.now ?? Date.now()) - WEEK_MS;
}

/**
 * Total cost in USD (not cents) of every usage event in the last 7 days, across
 * all users. Returns 0 — never NaN, never null, never a string — for an empty
 * window.
 */
export async function getWeeklyCost(opts?: WindowedQueryOptions): Promise<number> {
  const db = opts?.executor ?? (await defaultDb());

  const [row] = await db
    .select({ total: sum(usageEvents.costUsd) }) // SQL<string | null>, see header rule 5
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, windowStart(opts)));

  // SUM over zero matching rows returns one row holding NULL (not zero rows), and
  // drizzle preserves that NULL rather than mapping it — `Number(null ?? 0)` is 0.
  return Number(row?.total ?? 0);
}

export type OpLatency = { p50: number; p95: number };

/**
 * p50/p95 of `durationMs` per `usage_events.op` over the last 7 days, as a
 * COMPLETE record over every UsageOp value.
 *
 * `{ p50: 0, p95: 0 }` MEANS "no events for this op in the window" — a GROUP BY
 * returns no row at all for such an op, so the record is seeded first and the
 * returned rows overlaid. The page renders that case as an em dash, never as
 * "0 ms" (which would be an affirmatively false claim — PRD §5.5's "宁可暴露不
 * 完整，不静默吞掉"). Widening the return type to carry a sample count would
 * break the ticket's stated signature; if that ambiguity ever proves unacceptable
 * it is a ticket-text change to raise, not a silent one to make.
 *
 * percentile_cont (linear interpolation), not percentile_disc (nearest rank): it
 * is the standard reading of a latency p50/p95 and the one PRD §7's "p50 延迟"
 * targets imply. Postgres's formula over N sorted values x[0..N-1]:
 *
 *     pos = p * (N - 1);  result = x[⌊pos⌋] + (pos - ⌊pos⌋) * (x[⌈pos⌉] - x[⌊pos⌋])
 *
 * so [10, 20, 30, 40] ⇒ p50 = 25, p95 = 38.5 (the test's hand-computed
 * expectations are only checkable against this formula — keep it written down).
 * Being an interpolation it can land on float noise (e.g. 954.9999999999999);
 * the page ROUNDS for display rather than this module lying about the value.
 *
 * VOCABULARY WARNING for any caller rendering this: `usage_events.op` is the
 * pipeline-STAGE vocabulary (parse|read|cross|tailor|research|rehearse). PRD §7's
 * latency budgets (Fit ≤30s / Tailor ≤45s / Prep ≤90s) are USER-FACING-ACTION
 * vocabulary and are not the same thing — lib/config/quota.ts documents the
 * mapping and why it is lossy (one Fit is `read` + `cross`, two rows). Do not
 * label an op's p50 as a Fit/Prep budget, and do not sum ops into actions.
 */
export async function getLatencyPercentiles(
  opts?: WindowedQueryOptions,
): Promise<Record<UsageOp, OpLatency>> {
  const db = opts?.executor ?? (await defaultDb());

  const rows = await db
    .select({
      op: usageEvents.op,
      // .mapWith(Number) is NOT optional on a hand-written sql<T>: it carries no
      // runtime decoder of its own (drizzle's count()/sum() do), and drivers
      // disagree about how they hand numerics back. Header rule 5's Number()
      // below is the second belt.
      p50: sql<number>`percentile_cont(0.5) within group (order by ${usageEvents.durationMs})`.mapWith(
        Number,
      ),
      p95: sql<number>`percentile_cont(0.95) within group (order by ${usageEvents.durationMs})`.mapWith(
        Number,
      ),
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, windowStart(opts)))
    .groupBy(usageEvents.op);

  // Record<UsageOp, ...> is TOTAL: seed all six ops, then overlay what came back.
  // usageOpEnum.enumValues is the source of truth for "all the ops" — six, never
  // five or seven ('score' is deliberately excluded: pure code, folded into
  // 'cross'; db/schema.ts:71-81 and db/schema.test.ts pin that).
  const out = Object.fromEntries(
    usageOpEnum.enumValues.map((op) => [op, { p50: 0, p95: 0 }]),
  ) as Record<UsageOp, OpLatency>;

  for (const row of rows) {
    out[row.op] = { p50: Number(row.p50 ?? 0), p95: Number(row.p95 ?? 0) };
  }
  return out;
}

/**
 * The ticket's `SUM(droppedCount) / COUNT(*)` over the last 7 days — i.e.
 * DROPPED ITEMS PER USAGE EVENT, not a percentage.
 *
 * NAME IT HONESTLY WHEREVER IT IS RENDERED (the page does). PRD §6/§7's Q1 gate
 * ("dropped < 15%") and eval/assertions/q1.ts compute a genuinely DIFFERENT
 * number: droppedCount / total candidate items. usage_events has no
 * candidate-items column, so that true rate is not computable here. Rendering
 * this as "dropped rate: 55%" would invite a direct false comparison against the
 * 15% gate. The fix, if Horace wants the real rate, is EXTENDING usage_events
 * (FND-10 Feedback obligation #2 + this ticket's #3) — never a parallel
 * aggregation table, and not in this ticket (plan §5 Q3).
 *
 * The two aggregates are selected and DIVIDED IN JS on purpose. Writing the
 * formula literally as SQL is a silent-wrong-answer bug twice over:
 * `sum(dropped)/count(*)` is bigint/bigint, which Postgres TRUNCATES toward zero,
 * and an empty window would divide by zero, which Postgres RAISES.
 */
export async function getDroppedRate(opts?: WindowedQueryOptions): Promise<number> {
  const db = opts?.executor ?? (await defaultDb());

  const [row] = await db
    .select({ dropped: sum(usageEvents.droppedCount), events: count() })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, windowStart(opts)));

  const events = Number(row?.events ?? 0);
  return events === 0 ? 0 : Number(row?.dropped ?? 0) / events; // 0/0 ⇒ 0, never NaN
}

export type FunnelConversion = {
  signupToLibrary: number;
  fitToTailor: number;
  interviewingToBrief: number;
};

/**
 * Zero-denominator branch, kept in one place so no call site forgets it. Same
 * convention as eval/assertions/q1.ts. Consequence worth knowing: an empty
 * production database renders 0%, which looks like failure rather than "no data
 * yet" (plan §5 Q4 — the page's labels carry the caveat).
 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * The three PRD §7 funnel ratios, as raw fractions in [0, 1] (the page formats
 * the percentages):
 *
 *   signupToLibrary     — 注册 → 库建成, target ≥ 50%
 *   fitToTailor         — fit → tailor 转化, target ≥ 25%
 *   interviewingToBrief — interviewing 状态 job 中生成 brief 的比例, target ≥ 60%
 *
 * ALL-TIME, not windowed — deliberately asymmetric with the three 7-day metrics
 * above. The ticket's definitions carry no window and PRD §8.4 says "周成本"
 * (weekly COST) only. The page states the asymmetry so no reader has to guess
 * which number covers which period. Whether the funnel should be windowed too is
 * plan §5 Q2, for Horace — a follow-up ticket, not a silent change here.
 *
 * Six scalar counts, one `Promise.all` after a single client resolution; every
 * one returns a plain number — nothing identifying, per header rule 2.
 */
export async function getFunnelConversion(
  opts?: AdminQueryOptions,
): Promise<FunnelConversion> {
  const db = opts?.executor ?? (await defaultDb());

  const [
    [registered],
    [withLibrary],
    [totalJobs],
    [tailoredJobs],
    [interviewingJobs],
    [interviewingWithBrief],
  ] = await Promise.all([
    // --- 1. signup → library -------------------------------------------------
    // users.id is the primary key, so COUNT(*) is already distinct. Note the
    // denominator SHRINKS after an account deletion: PLT-01's hard delete removes
    // the users row (PRD §5.6 "删号 = 硬删该用户全部数据"), so post-deletion this
    // ratio describes surviving accounts only. Labelled on the page.
    db.select({ total: count() }).from(users),

    db
      .select({ total: countDistinct(libraries.userId) })
      .from(libraries)
      .where(
        and(
          // isNull(deletedAt) + non-empty projects together are exactly LIB-02's
          // hasLibrary() (lib/db/queries/library.ts:177-180): a soft-deleted
          // tombstone is not a built library (PRD §5.6), and an existing-but-
          // EMPTY library does not count (PRD §5.7's "无库时禁止新建 job"). The
          // ticket text omits deletedAt; matching the repo's one existing
          // definition of "has a library" is the right call, and is why this
          // comment exists.
          isNull(libraries.deletedAt),
          // A CASE, not `jsonb_typeof(...) = 'array' AND jsonb_array_length(...)
          // > 0`: SQL's AND does not short-circuit and Postgres may reorder the
          // quals, so the conjunct form can still evaluate jsonb_array_length on
          // a non-array row and RAISE — the very failure the guard exists to
          // prevent. CASE has defined evaluation order. The column is NOT NULL
          // defaulting to [] and only ever written as an array, so this is
          // defense in depth against a drifted row turning the page into a 500.
          sql`(case when jsonb_typeof(${libraries.projects}) = 'array' then jsonb_array_length(${libraries.projects}) else 0 end) > 0`,
        ),
      ),
    // countDistinct, NOT count: libraries.userId carries only a plain btree
    // index, no UNIQUE constraint (LIB-02's recorded gap), so two concurrent
    // confirms can produce duplicate rows for one user. Counting rows would
    // overstate the numerator and could push the ratio above 1.0.

    // --- 2. fit → tailor -----------------------------------------------------
    // The denominator is EVERY job. jobs.fit is NOT NULL in db/schema.ts:174 —
    // FND-04's Job-atomicity invariant (a Job only exists once READ+CROSS+SCORE
    // produced jd+ledger+fit) mirrored at the DB level — so the ticket's "jobs
    // with fit populated" IS all jobs. Deliberately NO isNotNull(jobs.fit)
    // filter: it would read like a real filter, is a tautology, and would invite
    // a future reader to believe fit-less jobs exist.
    db.select({ total: count() }).from(jobs),

    // tailored_resumes.jobId is an onDelete:'cascade' FK, so every row points at
    // a live job — no join needed to exclude orphans. countDistinct because a job
    // may be re-tailored (several rows, one job).
    db.select({ total: countDistinct(tailoredResumes.jobId) }).from(tailoredResumes),

    // --- 3. interviewing → brief --------------------------------------------
    // POINT-IN-TIME SNAPSHOT by design: jobs.status is current state, not
    // history, so a job that got a brief while interviewing and later moved to
    // 'closed' leaves BOTH the numerator and the denominator. This measures "of
    // jobs CURRENTLY interviewing, how many have a brief" — the literal reading
    // of PRD §7 and the only thing computable without a status-transition log.
    // If it reads low for that reason it is a product-signal finding (ticket
    // Feedback obligation #2), not a bug here. Labelled on the page.
    db.select({ total: count() }).from(jobs).where(eq(jobs.status, 'interviewing')),

    // The status filter MUST sit on the jobs side: counting briefs alone would
    // include briefs whose job has since moved to 'closed'.
    db
      .select({ total: countDistinct(jobs.id) })
      .from(jobs)
      .innerJoin(briefs, eq(briefs.jobId, jobs.id))
      .where(eq(jobs.status, 'interviewing')),
  ]);

  return {
    signupToLibrary: ratio(Number(withLibrary?.total ?? 0), Number(registered?.total ?? 0)),
    fitToTailor: ratio(Number(tailoredJobs?.total ?? 0), Number(totalJobs?.total ?? 0)),
    interviewingToBrief: ratio(
      Number(interviewingWithBrief?.total ?? 0),
      Number(interviewingJobs?.total ?? 0),
    ),
  };
}
