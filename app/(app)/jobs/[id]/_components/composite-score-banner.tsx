import { hasUnassessedBucket } from '@/app/(app)/jobs/[id]/_components/fit-view-model';
import type { FitReport } from '@/lib/schemas/pipeline';

// FIT-03 Deliverable 5 — PRD §5.2's "**综合分 + 档位**：…档位给建议语" plus its
// "**诚实标注**" clause, quoted verbatim: "分数是启发式匹配度，**不是录取概率**——在
// V1.1 有真实结果回填之前**不得暗示统计意义**".
//
// THE DISCLAIMER IS UNCONDITIONAL. It renders for every score and every tier, with no
// branch that can skip it — PRD's "不得暗示统计意义" is not a low-score caveat, and a
// Strong report is precisely where a reader is most likely to hear "you'll get this
// job". The ticket's acceptance item 3 pins this across all four tiers × {0, 100}.
// `lib/scoring/score.ts`'s `advice` strings deliberately do NOT contain it (its own
// comment says so) — this component is where it lives.
//
// PLAN D11 — "58 / 100", NEVER "58%". No `%` character may appear anywhere in the Fit
// Report output, and a test asserts its absence in this component and in
// sub-score-card.tsx. A percent sign next to a number is read as a probability by
// every reader; refusing the character is the cheapest mechanical enforcement of a
// PRD hard constraint that prose alone cannot hold.
//
// PLAN D7's second line: when ANY bucket is "not assessed" it was EXCLUDED from the
// composite average (FIT-02's D6), so the four displayed numbers no longer average to
// the composite. FIT-02's scorer comment promises "the four figures FIT-03 displays
// really do reproduce the composite by hand" — that promise breaks exactly here, and
// one honest sentence is cheaper than a dogfood bug report that the numbers do not
// add up.

/**
 * Exported so the test and the component reference ONE string. PRD writes the
 * disclaimer in Chinese; §5.8 puts the UI in English, so this is its English form.
 */
export const FIT_DISCLAIMER =
  'This is a heuristic match score, not a probability of being hired.';

/** Plan D7's arithmetic-honesty line. */
export const PARTIAL_COMPOSITE_NOTE =
  'Overall is the average of the sub-scores that were assessed.';

const bannerStyle = {
  border: '1px solid #d0d0d0',
  borderRadius: '4px',
  padding: '1rem',
  margin: '0 0 1.5rem',
} as const;

export default function CompositeScoreBanner({ fit }: { fit: FitReport }) {
  return (
    <section style={bannerStyle} aria-label="Overall fit">
      <p style={{ margin: '0 0 0.25rem', fontSize: '1.5rem', fontWeight: 700 }}>
        {/* D11: a slashed fraction, never a percentage. */}
        {fit.compositeScore} / 100
      </p>
      <p style={{ margin: '0 0 0.5rem', fontWeight: 700 }}>{fit.tier}</p>
      <p style={{ margin: '0 0 0.5rem' }}>{fit.advice}</p>

      {hasUnassessedBucket(fit) ? (
        <p style={{ margin: '0 0 0.5rem', color: '#555' }}>{PARTIAL_COMPOSITE_NOTE}</p>
      ) : null}

      {/* UNCONDITIONAL — see the header. Do not wrap this in any branch. */}
      <p style={{ margin: 0, color: '#555' }}>{FIT_DISCLAIMER}</p>
    </section>
  );
}
