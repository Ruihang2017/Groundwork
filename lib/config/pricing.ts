// PRD §9 raw unit prices (定价基准 2026-07 核对), quoted verbatim: "Sonnet 5 =
// $2 in / $10 out per MTok（8/31 前介绍价；之后 $3/$15…）；web search $10 /
// 1,000 次；Haiku 4.5（judge）$1/$5。" The intro-price / post-8-31-price
// distinction is carried as two named, independent rate sets — this module
// does NOT resolve which one is "current" based on today's date (that would be
// date-branching logic the ticket's Feedback obligation #1 explicitly asks to
// flag to Horace before adding, since PRD names an exact cutover date this
// ticket cannot resolve on 2026-07-18). Every caller of estimateCostUsd must
// pass `model` explicitly.
export const PRICING = {
  sonnet5: { inPerMTok: 2, outPerMTok: 10 },
  sonnet5PostIntro: { inPerMTok: 3, outPerMTok: 15 },
  haiku45: { inPerMTok: 1, outPerMTok: 5 },
  webSearchPer1000: 10,
} as const;

// The three rate-set keys in PRICING (excludes webSearchPer1000, which is a
// single shared per-1000-searches rate, not a per-model rate set). NOTE: these
// are PRICING-table keys, distinct from models.ts's PRIMARY_MODEL/JUDGE_MODEL
// string values ('claude-sonnet-5' / 'claude-haiku-4-5') — callers translate
// "which model did I call" to "which PRICING key applies" themselves; this
// module does not provide that translation (not requested by any Deliverable).
export type PricingModel = 'sonnet5' | 'sonnet5PostIntro' | 'haiku45';

/**
 * Pure function: computes actual cost in USD from real per-call token/search
 * counts, using the raw per-token/per-search rates above — NOT the rough
 * per-operation estimates in PRD §9's illustrative table (~$0.03/~$0.04/etc.),
 * which are only ballpark guidance, not something this function reproduces.
 * Used identically by FND-10's recordUsage() (real usage recording) and
 * (indirectly, via FND-10) by EVL-02 (judge-call cost tracking).
 *
 * No rounding is applied — plain floating-point arithmetic, so values like
 * 0.049999999999999996 instead of an exact 0.05 are possible. The ticket
 * specifies no rounding rule, so none is imposed here; a future fixed-precision
 * need (admin-UI display, exact-cent accounting) is a follow-up decision.
 */
export function estimateCostUsd(params: {
  model: PricingModel;
  tokensIn: number;
  tokensOut: number;
  searches: number;
}): number {
  const rate = PRICING[params.model];
  const tokenCostUsd =
    (params.tokensIn / 1_000_000) * rate.inPerMTok +
    (params.tokensOut / 1_000_000) * rate.outPerMTok;
  const searchCostUsd = (params.searches / 1_000) * PRICING.webSearchPer1000;
  return tokenCostUsd + searchCostUsd;
}
