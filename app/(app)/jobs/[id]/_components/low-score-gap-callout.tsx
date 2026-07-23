import type { FitReport, JdExtract } from '@/lib/schemas/pipeline';
import { UNCOVERED_MARKER } from '@/lib/validation';

// FIT-03 Deliverable 5 — PRD §5.2's final, explicit sentence: "低分页面同时展示
// '如果仍要投，优先补哪两个 gap'". Mandatory UI content on a low-score page, not
// optional polish.
//
// WHY THE TIER AND NOT A SCORE THRESHOLD: `tierForScore` lives in
// `lib/scoring/score.ts` and owns PRD §5.2's cut-points (≥75 / 55–74 / 35–54 / <35).
// Re-deriving them from `compositeScore` here would fork them silently — the two
// copies would agree until someone changed one. So this compares against the TIER
// VALUE, which the scorer already computed.
//
// E7: 'Long shot' contains a SPACE and is FND-03's literal enum value. Comparisons use
// the literal; any `tier.toLowerCase().replace(' ', '')` normalisation would be a
// latent bug.
//
// PLAN D13 — the "two" in PRD is a target, not a guarantee. A degenerate JD can
// produce fewer: ≥ 2 → the first two; exactly 1 → that one with singular copy; 0 →
// render NOTHING (a heading promising gaps with no gaps under it is worse than
// silence). `topGaps` is already ordered by originating requirement weight desc
// (FIT-02's D8), so "the first two" IS "the highest-weight two".
//
// PLAN D13 — INJECTED GAPS. FND-07's layer-2 injections carry `probe ===
// UNCOVERED_MARKER` and `play: ''` BY DESIGN, and they are eligible for `topGaps`.
// Rendering "Your bridge:" followed by nothing is the trap (plan E5); they get their
// own honest line instead. `UNCOVERED_MARKER` is IMPORTED, never retyped — it contains
// an em dash and a hand-typed hyphen version would compile and never match (E8).

const CALLOUT_TIERS = new Set<FitReport['tier']>(['Stretch', 'Long shot']);

/** Plan D13's substitute for an injected gap's empty `play`. */
export const UNCOVERED_GAP_COPY =
  'This requirement was not addressed by the analysis — re-run Fit by creating the job again.';

const calloutStyle = {
  border: '1px solid #b00020',
  borderRadius: '4px',
  padding: '1rem',
  margin: '0 0 1.5rem',
} as const;

export default function LowScoreGapCallout({ fit, jd }: { fit: FitReport; jd: JdExtract }) {
  if (!CALLOUT_TIERS.has(fit.tier)) return null;

  const gaps = fit.topGaps.slice(0, 2);
  if (gaps.length === 0) return null;

  const byId = new Map(jd.requirements.map((r) => [r.id, r]));
  const heading =
    gaps.length === 1
      ? 'If you still apply, close this gap first'
      : 'If you still apply, close these two gaps first';

  return (
    <section style={calloutStyle} aria-label="Priority gaps">
      <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>{heading}</h2>
      <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
        {gaps.map((gap, index) => {
          const injected = gap.probe === UNCOVERED_MARKER;
          return (
            // Index is part of the key: a requirementId can legitimately repeat across
            // gaps (FIT-02 reports rather than filters such anomalies).
            <li key={`${index}-${gap.requirementId}`} style={{ margin: '0 0 0.5rem' }}>
              <p style={{ margin: '0 0 0.25rem', fontWeight: 700 }}>
                {byId.get(gap.requirementId)?.text ?? gap.requirementId}
              </p>
              {injected ? (
                <p style={{ margin: 0 }}>{UNCOVERED_GAP_COPY}</p>
              ) : (
                <>
                  <p style={{ margin: '0 0 0.25rem' }}>They will probe: {gap.probe}</p>
                  <p style={{ margin: 0 }}>Your bridge: {gap.play}</p>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
