import { and, count, eq, gte, sum } from 'drizzle-orm';

import { db } from '@/db/index';
import { usageEvents } from '@/db/schema';
import type { UsageOp } from '@/lib/schemas/persisted';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Start of "today" in UTC, as an epoch-ms number — matches usage_events'
// bigint(epoch-ms) createdAt column with zero conversion (PRD §8.1 "配额用
// Postgres 计数器"; the day boundary itself is not PRD-specified beyond
// "每日" — UTC is this ticket's choice, consistent with every other
// timestamp in the schema already being UTC-implicit epoch-ms with no
// timezone field anywhere in FND-02/03/04's schemas).
function startOfTodayUtcMs(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// PRD §8.3: "配额：per-user 每日 10 fit / 5 tailor / 3 prep". Keyed by the
// three product-level quota buckets PRD names — NOT by UsageOp (see the
// mapping table below for why those are different vocabularies). No `parse`
// key: PARSE has no stated quota (01-foundation/README.md's decisions table)
// — do not add one here; a future PARSE quota is a PRD change, not a silent
// addition to this file.
export const DAILY_QUOTA = {
  fit: 10,
  tailor: 5,
  prep: 3,
} as const;

export type QuotaOp = keyof typeof DAILY_QUOTA; // 'fit' | 'tailor' | 'prep'

// --- Quota-bucket -> usage_events.op mapping -------------------------------
// DAILY_QUOTA's three keys are product-level "user-facing operation" names
// (PRD §8.3); usage_events.op is UsageOp, a pipeline-STAGE vocabulary (FND-04)
// with no 'fit'/'prep' values at all. Each quota bucket is charged exactly
// ONCE per user-facing action, at that action's FIRST internal call — the
// second internal call of the same action does NOT re-check quota (confirmed
// by direct read of the downstream tickets that implement this, since none of
// 03-library/04-fit/05-tailor/06-prep is built yet as of this plan):
//   fit    -> 'read'     FIT-01 charges `fit` quota once, before READ, and
//                        calls recordUsage(op:'read'). FIT-02's later
//                        recordUsage(op:'cross') does NOT re-check quota
//                        (FIT-02 ticket, Non-goals). Counting 'cross' here
//                        would double-count against 'read'.
//   tailor -> 'tailor'   TLR-01: 1:1 name match, single call, no ambiguity.
//   prep   -> 'research' PRP-01 charges `prep` quota once, before RESEARCH,
//                        and calls recordUsage(op:'research') on success.
//                        PRP-02's later recordUsage(op:'rehearse') does NOT
//                        re-check quota (PRP-02 ticket, Non-goals). Counting
//                        'rehearse' here would double-count against
//                        'research'.
//
// CROSS-TICKET COORDINATION RISK: this mapping is FND-06's own reading of
// FIT-01/TLR-01/PRP-01's ticket text as currently drafted — those tickets are
// not yet built. If any of their Builders implement a different op value for
// the FIRST recordUsage() call of their multi-call action, this mapping
// silently breaks (quota under- or over-counts) with no compile-time signal,
// since UsageOp's type alone cannot express "the first op of a given
// multi-call action". Each of FIT-01/TLR-01/PRP-01's own Architect pass MUST
// re-confirm this table against the actually-merged quota.ts before that
// ticket is built; if it needs to change, update this table AND this comment
// in the same commit, do not silently diverge (same escalation discipline as
// this ticket's own Feedback obligations).
const QUOTA_OP_TO_USAGE_OP: Record<QuotaOp, UsageOp> = {
  fit: 'read',
  tailor: 'tailor',
  prep: 'research',
};

/**
 * Checks (does NOT insert a row — see the KNOWN RACE note below) whether
 * `userId` has remaining `op` quota for "today" (UTC). Queries usage_events
 * for COUNT(*) WHERE userId = ? AND op = <mapped op> AND createdAt >= <start
 * of today, UTC>, compares against DAILY_QUOTA[op].
 *
 * KNOWN RACE (ticket Feedback obligation #2, documented here per that
 * obligation's own instruction, not silently assumed): this function only
 * CHECKS; the stage route calls FND-10's recordUsage() separately, AFTER its
 * operation succeeds, to actually persist the counted row. Two concurrent
 * requests from the same user can both pass this check before either's
 * usage_events row exists, letting the user momentarily exceed quota by 1.
 * Accepted for v1: the per-user quota numbers are low enough (max 10/day)
 * that the financial exposure is negligible (worst case ~1 extra ~$0.10
 * call). If this acceptance is ever revisited (e.g. via a DB-level advisory
 * lock or an atomic check-and-increment), that is a deliberate hardening
 * decision requiring Horace's sign-off, not a silent fix.
 *
 * Trust boundary: this function trusts its caller for `userId`'s authenticity
 * — it performs no authentication. Its own query IS correctly userId-scoped,
 * so it introduces no cross-user leak, but every call site (FIT-01, TLR-01,
 * PRP-01) MUST pass a session-derived `userId` (FND-08's requireUserId()),
 * never a client-supplied one (PRD §8.3 "无跨用户查询路径").
 */
export async function checkAndIncrementQuota(
  userId: string,
  op: QuotaOp,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const startOfDay = startOfTodayUtcMs();
  const usageOp = QUOTA_OP_TO_USAGE_OP[op];

  const [row] = await db
    .select({ used: count() })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        eq(usageEvents.op, usageOp),
        gte(usageEvents.createdAt, startOfDay),
      ),
    );

  const used = Number(row?.used ?? 0);
  const limit = DAILY_QUOTA[op];

  return {
    allowed: used < limit,
    remaining: Math.max(limit - used, 0),
    resetAt: startOfDay + ONE_DAY_MS,
  };
}

/**
 * Checks today's (UTC) total spend across ALL users against
 * process.env.GLOBAL_DAILY_SPEND_LIMIT_USD (PRD §8.3 "全局日花费熔断阈值
 * （env）"). Deliberately NOT userId-scoped — this is a single org-wide cap,
 * not a per-user check; do not add a userId filter here even by analogy with
 * checkAndIncrementQuota.
 *
 * Throws (does not return `tripped: false`) if the env var is unset, empty,
 * or not a finite number — an unset breaker threshold silently disabling the
 * breaker would itself be a cost-control regression (ticket Deliverable 3).
 * Note: `Number('')` is `0`, not `NaN`, in JS — an empty-string env var is
 * checked for explicitly below so it cannot be silently misread as "$0 limit"
 * (which would trip on any spend) or bypass the throw. A genuinely-configured
 * `GLOBAL_DAILY_SPEND_LIMIT_USD=0` is intentionally treated as valid (a legit,
 * if extreme, admin choice — Number('0') is 0 and Number.isFinite(0) is true).
 */
export async function checkGlobalBreaker(): Promise<{
  tripped: boolean;
  spentTodayUsd: number;
  limitUsd: number;
}> {
  const raw = process.env.GLOBAL_DAILY_SPEND_LIMIT_USD;
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(Number(raw))) {
    throw new Error(
      'GLOBAL_DAILY_SPEND_LIMIT_USD is not set (or not numeric). The global ' +
        'daily spend breaker cannot run without it — set it in your ' +
        'environment (see .env.example) before calling checkGlobalBreaker().',
    );
  }
  const limitUsd = Number(raw);

  const startOfDay = startOfTodayUtcMs();
  const [row] = await db
    .select({ total: sum(usageEvents.costUsd) })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, startOfDay));

  // Postgres SUM over a numeric column returns text (SQL<string | null>), and
  // over zero matching rows returns one row with NULL — Number(null ?? 0) → 0,
  // never NaN.
  const spentTodayUsd = Number(row?.total ?? 0);

  return {
    tripped: spentTodayUsd >= limitUsd,
    spentTodayUsd,
    limitUsd,
  };
}
