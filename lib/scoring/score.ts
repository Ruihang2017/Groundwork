import {
  FitReport,
  type FitTier,
  type Gap,
  type HardRequirementCheck,
  type JdExtract,
  type Ledger,
  type SubScore,
} from '@/lib/schemas/pipeline';

// FIT-02 Deliverable 2 — the SCORE stage. PURE CODE, NO MODEL CALL.
//
// PRD ANCHORS
//   §5.1 SCORE row: "Ledger + weights → FitReport；子分与综合分是 ledger 的确定性
//        函数（strong=1 / partial=0.5 / gap=0，按 requirement weight 加权归一）；
//        **模型不输出分数**". That last clause is why this file exists at all: the
//        model produces evidence, this function produces every number the user sees.
//   §5.2 The Fit Report spec: hard requirements on top, four sub-scores (技术栈匹配 →
//        technical, 经验深度 → experienceDepth, 领域匹配 → domain, 证据强度 →
//        evidenceStrength), 综合分 + 档位 (≥75 Strong / 55–74 Competitive / 35–54
//        Stretch / <35 Long shot), 档位给建议语 + top gaps, and the honest labelling
//        ("分数是启发式匹配度，不是录取概率" — see the `advice` note below for where
//        that disclaimer actually lives).
//
// DETERMINISM IS THE CONTRACT (ticket acceptance item 1): no Date.now(), no
// Math.random(), no I/O, no mutation of any argument, no locale-dependent
// formatting. Byte-identical inputs must produce a byte-identical FitReport. A test
// pins all of it. Do not introduce a "tie-breaking" heuristic that reads anything
// outside the three arguments.
//
// DESIGN RESOLUTIONS (docs/plans/FIT-02.md §0.1 — each one is a decision, not an
// accident; the rejected alternative is recorded with it):
//
//   D3  `SubScore.bindings` / `SubScore.gaps` hold **requirementId strings**, emitted
//       in `jd.requirements` order. FND-03's schema explicitly left the indexing
//       convention to this ticket. requirementId is the one join key both `Binding`
//       and `Gap` carry, so FIT-03 can look the full objects up in `job.ledger` and
//       satisfy PRD §5.2's "分数可下钻到证据". Array indices into `ledger.bindings`
//       were rejected: they break the moment anything re-orders or filters the ledger.
//
//   D4  `evidenceStrength` has no matching `RequirementCategory`. It uses the SAME
//       weighted formula as the other three buckets, applied to the bucket
//       "requirements carrying ≥ 1 binding, regardless of category". Empty bucket (no
//       bindings at all) ⇒ score 0. Rejected: an unweighted (#strong + 0.5·#partial) /
//       #bindings, which double-counts a requirement carrying several bindings and
//       silently drops PRD §5.1's weighting.
//       ⚠️ THIS DEFINITION IS PROTECTED BY THE TICKET'S FEEDBACK OBLIGATION #1:
//       changing it is a scoring-formula reversal needing Horace's sign-off (PRD §13
//       Q1's "没有 ground truth 时调参数是迷信" applies to the FORMULA, not just the
//       weights). Gather dogfood evidence and escalate — do NOT silently retune.
//
//   D5  `category: 'logistics'` requirements join NO category bucket (PRD names four
//       sub-scores and none is "logistics"; they surface as `hardRequirements`
//       instead). A logistics requirement that DOES carry a binding still counts in
//       `evidenceStrength`, because D4's rule is category-blind by the ticket's
//       literal text. Folding logistics into `technical` would corrupt the sub-score
//       users read most.
//
//   D6  A bucket with no member requirement at all (e.g. a JD stating no `domain`
//       requirement) is "NOT ASSESSED": `score: 0`, both arrays empty, and it is
//       EXCLUDED from the composite average. Scoring an unasked-for category 0 and
//       averaging it in would punish a candidate for something the JD never demanded.
//       `SubScore.score` is a non-nullable 0–100, so "not assessed" cannot be encoded
//       in the schema — FIT-03 detects it as `bindings.length === 0 &&
//       gaps.length === 0` (plan §5 Q3). No bucket assessed ⇒ compositeScore 0.
//
//   D8  `topGaps` is capped at TOP_GAPS_CAP = 3, ordered by originating requirement
//       weight desc. PRD states no number for this cap (unlike the 5/3-capped
//       Rehearse fields); 3 is the smallest cap that is plural-plus-one and matches
//       PRD's other "≤ 3" caps, and FIT-03's low-score callout needs at least two.
//       A strict "weight-3 only, else weight-2" reading was rejected: it returns
//       NOTHING when only weight-1 gaps exist, starving that mandatory callout.
//       Ticket Feedback obligation #3 governs any change to the cap.
//
//   D9  `advice` is four fixed ENGLISH templates. PRD §5.8 has Fit output follow the
//       JD's language, but SCORE is pure code with no language signal and no model
//       call ("模型不输出分数"), and §5.8 itself scopes v1 to "官方支持英文 JD".
//       Documented v1 inconsistency (plan §5 Q4): for a non-English JD the
//       bindings/gaps follow the JD while `advice` stays English.

/** D8. Exported so FIT-03 and the tests reference one number, not a literal. */
export const TOP_GAPS_CAP = 3;

/**
 * PRD §5.2's tier thresholds, transcribed exactly: "≥75 Strong / 55–74 Competitive /
 * 35–54 Stretch / <35 Long shot". Exported so the boundary assertions (ticket
 * acceptance item 2) can test the mapping directly rather than through constructed
 * ledgers. Note the space in 'Long shot' — it is FND-03's literal enum value.
 */
export function tierForScore(compositeScore: number): FitTier {
  if (compositeScore >= 75) return 'Strong';
  if (compositeScore >= 55) return 'Competitive';
  if (compositeScore >= 35) return 'Stretch';
  return 'Long shot';
}

/**
 * D9. PRD §5.2: "档位给建议语". These must be actionable and must NEVER state or
 * imply odds of being hired — PRD §5.2's "分数是启发式匹配度，不是录取概率" is a
 * hard constraint on this wording (a test asserts the absence of probability
 * language).
 *
 * The user-facing "this is a heuristic match score, not a probability" DISCLAIMER
 * itself is FIT-03's mandatory UI element (its Deliverable 5), not this string's job.
 * Do not duplicate it here, and do not assume it is missing because it is absent.
 */
const ADVICE_BY_TIER: Record<FitTier, string> = {
  Strong:
    'Strong match. Lead with the bindings below, prepare answers for the few remaining gaps, and tailor your resume before applying.',
  Competitive:
    'Competitive. You cover most of what this posting screens on — close the top gaps below before you apply.',
  Stretch:
    'Stretch. Apply if this role matters to you, and prepare a specific bridge for each gap below.',
  'Long shot':
    'Long shot. Your library does not cover most of what this posting screens on. If you still apply, prioritise the top gaps below.',
};

/** Accumulator for one sub-score. `weightSum === 0` means "not assessed" (D6). */
type Bucket = {
  weightSum: number;
  weightedValue: number;
  bindingIds: string[];
  gapIds: string[];
};

function emptyBucket(): Bucket {
  return { weightSum: 0, weightedValue: 0, bindingIds: [], gapIds: [] };
}

/**
 * PRD §5.1 SCORE row's "按 requirement weight 加权归一", plus D6's not-assessed rule.
 *
 * `Math.round` (half-up) is the rounding contract — no `toFixed`, no `Intl`, nothing
 * locale-dependent. The composite below averages these ROUNDED numbers so that the
 * four figures FIT-03 displays really do reproduce the composite by hand.
 */
function toSubScore(bucket: Bucket): SubScore {
  return {
    score: bucket.weightSum === 0 ? 0 : Math.round((bucket.weightedValue / bucket.weightSum) * 100),
    bindings: [...bucket.bindingIds],
    gaps: [...bucket.gapIds],
  };
}

/**
 * SCORE. `Ledger` + `JdExtract` (which carries the weights) + the hard-requirement
 * classifications CROSS produced → the `FitReport` PRD §5.2 specifies.
 *
 * `hardRequirements` is passed straight THROUGH: this function neither validates nor
 * reorders it (the route's Zod already parsed it, and PRD §5.2 wants them "置顶展示"
 * in the order given). It is deliberately an argument rather than something derived
 * here — hard requirements are a model classification, not a function of the ledger.
 *
 * Callable with an unfiltered ledger: a requirement with no binding scores 0 whether
 * it has a `Gap` or is uncovered entirely. In the route, FND-07's layer 2 has already
 * injected a gap for the uncovered case before this is called.
 */
export function computeFitReport(
  ledger: Ledger,
  jd: JdExtract,
  hardRequirements: HardRequirementCheck[],
): FitReport {
  const technical = emptyBucket();
  const experienceDepth = emptyBucket();
  const domain = emptyBucket();
  const evidenceStrength = emptyBucket();

  for (const requirement of jd.requirements) {
    const bindingsFor = ledger.bindings.filter((b) => b.requirementId === requirement.id);
    const bound = bindingsFor.length > 0;

    // PRD §5.1: strong = 1 / partial = 0.5 / gap = 0. A requirement carrying SEVERAL
    // bindings is scored by its STRONGEST one — the weighting unit is the requirement
    // (it is what carries `weight`), not the binding. Counting each binding
    // separately would let a model inflate a score by emitting the same evidence
    // twice, and would make the weights stop summing to the denominator.
    const value = bindingsFor.some((b) => b.strength === 'strong') ? 1 : bound ? 0.5 : 0;

    // D5: 'logistics' maps to no category bucket.
    const categoryBucket =
      requirement.category === 'technical'
        ? technical
        : requirement.category === 'experience'
          ? experienceDepth
          : requirement.category === 'domain'
            ? domain
            : null;

    if (categoryBucket) {
      categoryBucket.weightSum += requirement.weight;
      categoryBucket.weightedValue += requirement.weight * value;
      // D3: requirementId strings, in jd.requirements order.
      (bound ? categoryBucket.bindingIds : categoryBucket.gapIds).push(requirement.id);
    }

    // D4: evidenceStrength's membership is "has ≥ 1 binding", category-blind.
    if (bound) {
      evidenceStrength.weightSum += requirement.weight;
      evidenceStrength.weightedValue += requirement.weight * value;
      evidenceStrength.bindingIds.push(requirement.id);
    } else {
      // INFORMATIONAL ONLY. Unbound requirements are listed here so FIT-03 can show
      // what is missing, but they are NOT in this bucket's weightSum and therefore do
      // NOT affect its score — that asymmetry is the whole point of D4 and is exactly
      // what plan §4 R11 flags as its known consequence.
      evidenceStrength.gapIds.push(requirement.id);
    }
  }

  const subScores = {
    technical: toSubScore(technical),
    experienceDepth: toSubScore(experienceDepth),
    domain: toSubScore(domain),
    evidenceStrength: toSubScore(evidenceStrength),
  };

  // D6: the composite is the mean of the ASSESSED buckets only, equally weighted
  // (PRD specifies no differential weighting between the four sub-scores).
  const assessed = [
    [technical, subScores.technical] as const,
    [experienceDepth, subScores.experienceDepth] as const,
    [domain, subScores.domain] as const,
    [evidenceStrength, subScores.evidenceStrength] as const,
  ].filter(([bucket]) => bucket.weightSum > 0);

  const compositeScore =
    assessed.length === 0
      ? 0
      : Math.round(assessed.reduce((sum, [, sub]) => sum + sub.score, 0) / assessed.length);

  const tier = tierForScore(compositeScore);

  // D8. Every comparison key is index-based so the ordering is TOTAL and independent
  // of the engine's sort stability.
  const boundRequirementIds = new Set(ledger.bindings.map((b) => b.requirementId));
  const requirementRank = new Map(
    jd.requirements.map((r, index) => [r.id, { weight: r.weight, index }]),
  );

  const topGaps: Gap[] = ledger.gaps
    .map((gap, ledgerIndex) => ({ gap, ledgerIndex }))
    // A requirement that HAS evidence is not a gap in the report, whatever the model
    // also emitted about it (D11's double-cover case is resolved as bound).
    .filter(({ gap }) => !boundRequirementIds.has(gap.requirementId))
    .sort((a, b) => {
      // A requirementId absent from the JD (a hallucinated reference the route counts
      // and reports but never filters — plan §4 R7) gets weight 0 and sorts last.
      const ra = requirementRank.get(a.gap.requirementId) ?? { weight: 0, index: Number.MAX_SAFE_INTEGER };
      const rb = requirementRank.get(b.gap.requirementId) ?? { weight: 0, index: Number.MAX_SAFE_INTEGER };
      if (ra.weight !== rb.weight) return rb.weight - ra.weight;
      if (ra.index !== rb.index) return ra.index - rb.index;
      return a.ledgerIndex - b.ledgerIndex;
    })
    .slice(0, TOP_GAPS_CAP)
    .map(({ gap }) => gap);

  // The parse is a deliberate SELF-CHECK, not ceremony: a rounding bug producing
  // 100.0000001, an out-of-enum tier, or a malformed hardRequirements entry must fail
  // loudly at the source rather than be persisted into a jsonb column and rendered as
  // a real verdict. A throw here is a code bug; the route maps it to 500 score_failed.
  return FitReport.parse({
    hardRequirements,
    subScores,
    compositeScore,
    tier,
    advice: ADVICE_BY_TIER[tier],
    topGaps,
  });
}
