import { and, count, countDistinct, eq, gte, isNull, sql, sum } from 'drizzle-orm';

import {
  briefs,
  jobs,
  libraries,
  tailoredResumes,
  usageEvents,
  users,
} from '@/db/schema';
import { UsageOp } from '@/lib/schemas/persisted';

// -----------------------------------------------------------------------------
// PLT-03 — /admin observability aggregations over usage_events (PRD §8.4:
// "/admin 页汇总周成本、p50/p95、dropped 率、漏斗转化。不上 APM").
//
// Read this header before adding anything to this file.
//
// 1. THIS MODULE IS THE ONE DELIBERATE EXCEPTION TO PRD §8.3's "全部查询以
//    session userId 约束". Every query below is intentionally CROSS-USER. That
//    is safe only because every caller is admin-gated (middleware.ts's /admin
//    403 plus app/(admin)/admin/page.tsx's own isAdminEmail() check, which runs
//    before any of these functions are called). NEVER import this module from a
//    user-facing route, page, or component.
//
// 2. AGGREGATES ONLY. No function here returns a row, an email, a name, a
//    userId, a company, or a job title — only counts, sums and ratios. A
//    per-user drill-down ("who is burning the budget?") is new privacy surface
//    the ticket's Non-goals forbid without a product decision (resumes are PII;
//    PRD §8.3/§12 name PII leakage as a top-2 risk). Adding one is not a
//    refactor.
//
// 3. BUILD-TIME SAFETY: no top-level `@/db/index` import — see dbIndex() below.
//
// 4. READS ONLY. This module never writes; it does not touch FND-10's
//    lib/usage/record.ts write path or any usage_events column.
// -----------------------------------------------------------------------------

// db/index.ts throws at IMPORT time when DATABASE_URL is unset (an intentional,
// tested FND-05 fail-fast), and `next build`'s "Collecting page data" phase
// statically imports every page module — including app/(admin)/admin/page.tsx,
// which imports this file. A top-level `import { db } from '@/db/index'` here
// would therefore break `pnpm build` on any checkout or CI runner without a
// DATABASE_URL. (lib/config/quota.ts and lib/usage/record.ts *do* import it
// statically; that is safe only because nothing under app/** imports them.)
//
// Memoized so ONE module instance issues EXACTLY ONE import('@/db/index') and
// concurrent callers await the same promise. Load-bearing, not a
// micro-optimization: vitest's mocker re-resolves a vi.doMock-ed specifier on
// every import() call, and two import()s issued in the same tick race — one gets
// the mock, the other loads the REAL module and dies on the DATABASE_URL
// fail-fast. The page calls all four functions inside one Promise.all, which is
// exactly that same-tick concurrency. A REJECTED import is not cached, so a
// transient failure does not poison the module for its lifetime.
let dbIndexPromise: Promise<typeof import('@/db/index')> | null = null;

function dbIndex(): Promise<typeof import('@/db/index')> {
  dbIndexPromise ??= import('@/db/index').catch((err: unknown) => {
    dbIndexPromise = null;
    throw err;
  });
  return dbIndexPromise;
}

/** The read-only neon-http client. Never `dbTx` — nothing here writes. */
async function defaultDb() {
  const { db } = await dbIndex();
  return db;
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Inclusive lower bound of the 7-day window (ticket: "createdAt >= <7 days
 * ago>"). `usage_events.createdAt` is bigint(mode:'number') epoch-ms
 * (db/schema.ts convention #1), so the window filter is a plain numeric `gte` —
 * the same shape lib/config/quota.ts already uses.
 */
function weekAgo(nowMs: number): number {
  return nowMs - WEEK_MS;
}

// Every windowed function takes an OPTIONAL `nowMs` defaulting to Date.now().
// Additive, so the ticket's zero-argument call shape is unchanged, and boundary
// tests become exact instead of racing the wall clock. (Deliberately NOT
// vi.useFakeTimers(): PGlite drives a WASM runtime through async scheduling and
// its interaction with faked timers is unverified in this repo.)

/**
 * Total cost in USD (not cents) of every usage event in the last 7 days, across
 * all users.
 */
export async function getWeeklyCost(nowMs: number = Date.now()): Promise<number> {
  const db = await defaultDb();

  const [row] = await db
    .select({ total: sum(usageEvents.costUsd) })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, weekAgo(nowMs)));

  // Postgres SUM over a numeric column returns text, and over zero matching rows
  // returns one row with NULL — Number(null ?? 0) is 0, never NaN. Same idiom as
  // lib/config/quota.ts's checkGlobalBreaker().
  return Number(row?.total ?? 0);
}

/**
 * Latency for one pipeline stage over the window. `samples` is an ADDITIVE
 * superset of the ticket's literal `{ p50, p95 }` shape: with zero events in the
 * window there is no honest p50/p95, and reporting `{p50: 0, p95: 0}` would
 * assert "this operation completed in 0 ms" — affirmatively false, and directly
 * against PRD §5.5's "宁可暴露不完整，不静默吞掉". `samples` lets the page render
 * an em dash instead. (Contrast getFunnelConversion, whose shape is deliberately
 * NOT widened — a ratio over a small denominator is still arithmetically
 * correct, only statistically weak, so that gets a page-level caveat instead.)
 */
export type OpLatency = { p50: number; p95: number; samples: number };

/**
 * p50/p95 `durationMs` per `usage_events.op` over the last 7 days, as a COMPLETE
 * record over every UsageOp value (ops with no events in the window come back as
 * `{ p50: 0, p95: 0, samples: 0 }`).
 *
 * VOCABULARY WARNING for any caller rendering this: `usage_events.op` is the
 * pipeline-STAGE vocabulary (parse|read|cross|tailor|research|rehearse). PRD §7's
 * latency budgets (Fit ≤30s / Tailor ≤45s / Prep ≤90s) are USER-FACING-ACTION
 * vocabulary and are not the same thing — lib/config/quota.ts:34-65 documents the
 * mapping and why it is lossy (one Fit is `read` + `cross`, two rows). Do not
 * label an op's p50 as a Fit/Prep budget, and do not sum ops into actions.
 */
export async function getLatencyPercentiles(
  nowMs: number = Date.now(),
): Promise<Record<UsageOp, OpLatency>> {
  const db = await defaultDb();

  const rows = await db
    .select({
      op: usageEvents.op,
      // percentile_disc, NOT percentile_cont. percentile_cont interpolates in
      // double precision and returns float noise (measured: 954.9999999999999
      // for p95 over 100..1000), which would render literally on the page and
      // break exact assertions. percentile_disc returns the value at nearest
      // rank k = ceil(q * n) over the ascending durations — an ACTUALLY OBSERVED
      // latency, in exact integer milliseconds. Honest for a latency metric.
      //
      // .mapWith(Number) is NOT optional: a hand-written sql<number> carries no
      // runtime decoder (drizzle's own count()/sum() do — see
      // drizzle-orm/sql/functions/aggregate.js), and Postgres hands int8/numeric
      // back as STRINGS through node-postgres-style drivers such as
      // @neondatabase/serverless while PGlite hands back numbers. Without the
      // map this passes every test and does string math in production.
      p50: sql<number>`percentile_disc(0.5) within group (order by ${usageEvents.durationMs})`.mapWith(
        Number,
      ),
      p95: sql<number>`percentile_disc(0.95) within group (order by ${usageEvents.durationMs})`.mapWith(
        Number,
      ),
      samples: count(),
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, weekAgo(nowMs)))
    .groupBy(usageEvents.op);

  const byOp = new Map(rows.map((row) => [row.op, row]));

  // Fold into a COMPLETE record: ops with no rows in the window never appear in
  // `rows` at all, and a caller iterating the result must still see them.
  return Object.fromEntries(
    UsageOp.options.map((op) => {
      const row = byOp.get(op);
      return [
        op,
        row
          ? { p50: Number(row.p50), p95: Number(row.p95), samples: Number(row.samples) }
          : { p50: 0, p95: 0, samples: 0 },
      ];
    }),
  ) as Record<UsageOp, OpLatency>;
}

/**
 * The ticket's `SUM(droppedCount) / COUNT(*)` over the last 7 days — i.e.
 * DROPPED ITEMS PER USAGE EVENT, not a percentage.
 *
 * NAME IT HONESTLY WHEREVER IT IS RENDERED. The denominator is the number of
 * usage events, because usage_events has no "items considered" column. PRD §6's
 * Q1 gate ("dropped < 15%") and eval/assertions/q1.ts compute a genuinely
 * different number (droppedCount / items considered). Rendering this as
 * "Dropped rate: 55%" invites a direct false comparison against that 15% gate.
 * Whether Horace wants a true rate — which needs a usage_events column extension,
 * pre-authorized by the ticket's Feedback obligation #3 — is open question Q3.
 *
 * The two aggregates are selected and DIVIDED IN JS on purpose. Writing the
 * ticket's formula literally as SQL is a silent-wrong-answer bug twice over:
 * `sum(dropped)/count(*)` is bigint/bigint, which Postgres TRUNCATES (measured:
 * 6/11 returned 0, while the double-precision cast returned 0.545…), and an
 * empty window would divide by zero, which Postgres RAISES.
 */
export async function getDroppedRate(nowMs: number = Date.now()): Promise<number> {
  const db = await defaultDb();

  const [row] = await db
    .select({ dropped: sum(usageEvents.droppedCount), events: count() })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, weekAgo(nowMs)));

  const events = Number(row?.events ?? 0);
  return events === 0 ? 0 : Number(row?.dropped ?? 0) / events;
}

export type FunnelConversion = {
  signupToLibrary: number;
  fitToTailor: number;
  interviewingToBrief: number;
};

/** Zero-denominator branch, kept in one place so no call site forgets it. */
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
 * ALL-TIME, not windowed, unlike the other three functions here — the ticket's
 * definitions name no window (they say nothing like the other three's "the same
 * 7-day window") and PRD §7's activation/conversion targets read as cumulative.
 * The page must label this section "all time" so the difference is visible.
 * Whether the funnel should be windowed too is open question Q2.
 *
 * Six scalar sub-queries; every one returns a plain count — nothing identifying,
 * per header rule 2.
 */
export async function getFunnelConversion(): Promise<FunnelConversion> {
  const db = await defaultDb();

  // --- 1. signup → library ---------------------------------------------------
  const [registered] = await db.select({ total: count() }).from(users);

  const [withLibrary] = await db
    .select({ total: countDistinct(libraries.userId) })
    .from(libraries)
    .where(
      and(
        isNull(libraries.deletedAt),
        // A CASE, not `jsonb_typeof(...) = 'array' AND jsonb_array_length(...) >
        // 0`: SQL's AND is not short-circuiting and Postgres is free to reorder
        // the two quals, so the conjunct form can still evaluate
        // jsonb_array_length on a non-array row and RAISE — which is exactly the
        // failure the guard exists to prevent. CASE has defined evaluation order.
        sql`(case when jsonb_typeof(${libraries.projects}) = 'array' then jsonb_array_length(${libraries.projects}) else 0 end) > 0`,
      ),
    );
  // countDistinct, NOT count: libraries.userId carries only a plain btree index,
  // no UNIQUE constraint, so two concurrent confirms can produce duplicate rows
  // for one user. Counting rows would overstate the numerator and could push the
  // ratio above 1.0.
  //
  // isNull(deletedAt): PRD §5.6 soft delete — a tombstoned library is not a
  // built library. Non-empty `projects`: matches the ticket's `projects.length >
  // 0` and PRD §5.7's "无库时禁止新建 job" notion of a usable library. The
  // jsonb_typeof guard comes FIRST because jsonb_array_length raises on a
  // non-array value; the column is NOT NULL defaulting to [] and only ever
  // written as an array, so this is defense in depth against a drifted row.

  // --- 2. fit → tailor -------------------------------------------------------
  // Denominator is EVERY job: jobs.fit is NOT NULL in db/schema.ts (FND-04's
  // atomicity guarantee — a Job only exists once READ+CROSS+SCORE all produced
  // output), so "jobs with fit populated" is all of them. Deliberately no
  // `fit IS NOT NULL` filter, which would imply otherwise.
  const [totalJobs] = await db.select({ total: count() }).from(jobs);

  // tailored_resumes.jobId is an onDelete:'cascade' FK, so every row points at a
  // live job — no join needed to avoid counting orphans.
  const [tailoredJobs] = await db
    .select({ total: countDistinct(tailoredResumes.jobId) })
    .from(tailoredResumes);

  // --- 3. interviewing → brief ----------------------------------------------
  // POINT-IN-TIME SNAPSHOT by design: jobs.status is mutable, so a job that
  // generated a brief and then moved to 'closed' leaves the numerator AND the
  // denominator. This measures "of jobs CURRENTLY in interviewing, how many have
  // a brief" — the literal reading of PRD §7. If it reads low for that reason,
  // that is a product-signal finding (Feedback obligation #2), not a local bug.
  const [interviewingJobs] = await db
    .select({ total: count() })
    .from(jobs)
    .where(eq(jobs.status, 'interviewing'));

  // The status filter MUST sit on the jobs side: counting briefs alone would
  // include briefs belonging to jobs that have since moved to 'closed'.
  const [interviewingWithBrief] = await db
    .select({ total: countDistinct(jobs.id) })
    .from(jobs)
    .innerJoin(briefs, eq(briefs.jobId, jobs.id))
    .where(eq(jobs.status, 'interviewing'));

  return {
    signupToLibrary: ratio(Number(withLibrary?.total ?? 0), Number(registered?.total ?? 0)),
    fitToTailor: ratio(Number(tailoredJobs?.total ?? 0), Number(totalJobs?.total ?? 0)),
    interviewingToBrief: ratio(
      Number(interviewingWithBrief?.total ?? 0),
      Number(interviewingJobs?.total ?? 0),
    ),
  };
}
