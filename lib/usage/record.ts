import { db } from '@/db/index';
import { usageEvents } from '@/db/schema';
import { estimateCostUsd } from '@/lib/config/pricing';
import type { UsageOp } from '@/lib/schemas/persisted';

// PRD §5.6/§8.4: the single write-path every stage-owning route (LIB-01,
// FIT-01, FIT-02, TLR-01, PRP-01, PRP-02) calls once per user-facing
// operation, after that operation completes, to persist one usage_events
// row. See the FND-10 ticket's Background for why this is ONE row per
// user-facing action, not per internal LLM call (e.g. FIT-01 records
// op:'read' and FIT-02 later separately records op:'cross' for one
// completed Fit) — this function has no opinion on that; it writes exactly
// the one row its caller asks for, once, and does not call UsageEvent.parse
// on its input (this is an internal trusted write path downstream of
// FND-07's four validation layers, not a request-body boundary).

export type RecordUsageEvent = {
  userId: string;
  op: UsageOp;
  tokensIn: number;
  tokensOut: number;
  searches: number;
  durationMs: number;
  droppedCount?: number;
  status?: 'success' | 'failure';
};

// Hardcoded to the PRE-8/31 intro Sonnet rate. Every currently-drafted
// caller of recordUsage() (LIB-01/FIT-01/FIT-02/TLR-01/PRP-01/PRP-02) calls
// PRIMARY_MODEL ('claude-sonnet-5', lib/config/models.ts) exclusively —
// JUDGE_MODEL ('claude-haiku-4-5') is only used by 02-evaluation's
// not-yet-built judge harness, which this ticket's Goal does not list as a
// recordUsage() caller. This is an explicit, non-calendar-computed choice
// (lib/config/pricing.ts's own Feedback obligation #1 forbids silent
// date-branching) — NOT automatically resolved from Date.now(). See the
// plan's Open Questions: if recordUsage() ever needs to price a non-sonnet5
// call, or needs to flip to 'sonnet5PostIntro' after 2026-08-31, this
// function's signature has no `model` parameter to receive that (literal
// per the ticket's own Deliverable 2 text) — that is a signature change to
// make deliberately, not a silent internal fix.
const RECORD_USAGE_PRICING_MODEL = 'sonnet5' as const;

export async function recordUsage(event: RecordUsageEvent): Promise<void> {
  // Deliberately OUTSIDE the try/catch below: estimateCostUsd is a pure
  // function over four numeric inputs with no throwing code path in its
  // current implementation (lib/config/pricing.ts, verified by direct read
  // at planning time) — only the DB write itself is the failure mode
  // Deliverable 3 asks this function to swallow.
  const costUsd = estimateCostUsd({
    model: RECORD_USAGE_PRICING_MODEL,
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    searches: event.searches,
  });

  try {
    await db.insert(usageEvents).values({
      userId: event.userId,
      op: event.op,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      searches: event.searches,
      costUsd,
      durationMs: event.durationMs,
      droppedCount: event.droppedCount ?? 0,
      status: event.status ?? 'success',
    });
  } catch (err) {
    // PRD §8.4 explicitly rejects standing up an APM ("不上 APM") —
    // console.error is the entire error-observability budget for this path.
    // A usage-logging outage must never fail the parent request (ticket
    // Deliverable 3; this repo's P3 "degrade, don't block" spirit applied to
    // observability logging, an explicit extension documented here per the
    // ticket's own instruction, since P3 is literally scoped to RESEARCH).
    console.error('[recordUsage] failed to write a usage_events row', {
      userId: event.userId,
      op: event.op,
      err,
    });
  }
}
