import {
  isNotAssessed,
  resolveRequirements,
  type RequirementView,
} from '@/app/(app)/jobs/[id]/_components/fit-view-model';
import type { JdExtract, Ledger, SubScore } from '@/lib/schemas/pipeline';

// FIT-03 Deliverable 5 — PRD §5.2's "**四个子分**（0–100）：…各自列出支撑 bindings
// 与 gaps，**分数可下钻到证据**". The drill-down is the requirement: a number with no
// evidence under it is exactly the "看起来很懂但你复述不出来" output PRD §2 P1 rejects.
//
// PLAN D7 — "NOT ASSESSED" IS NOT ZERO. A bucket the JD stated no requirement for is
// EXCLUDED from the composite by FIT-02's scorer (its D6) and renders as the words
// "Not assessed", never the number 0. Showing "Domain match 0 / 100" for a category
// the posting never asked about reports a failure that did not happen, and it is the
// single most likely legibility complaint from the ticket's [human] acceptance item.
// The predicate itself is FIT-02's, not ours — see `isNotAssessed`'s comment.
//
// PLAN D11 — "60 / 100", NEVER "60%". No `%` character anywhere in the Fit Report;
// a test asserts its absence. See composite-score-banner.tsx's header for why.
//
// PLAN E4 — a `RequirementView` whose `text` is null is a requirementId the model
// referenced but the JD never contained. FIT-02 counts these in `anomalies` and
// deliberately never filters them, so this card renders the RAW ID rather than
// dropping the row or rendering an empty bullet (PRD's "宁可暴露不完整，不静默吞掉").
//
// The drill-down sits inside `<details>` so a four-card page stays readable; the
// summary states the counts so the user can decide whether to open it.

function RequirementRow({ view, kind }: { view: RequirementView; kind: 'binding' | 'gap' }) {
  return (
    <li style={{ margin: '0 0 0.5rem' }}>
      <p style={{ margin: '0 0 0.25rem', fontWeight: 700 }}>
        {/* E4: the raw id when the JD has no such requirement. */}
        {view.text ?? view.requirementId}
      </p>

      {kind === 'binding'
        ? view.bindings.map((binding, index) => (
            <p key={`${index}-${binding.projectId}`} style={{ margin: '0 0 0.25rem' }}>
              {binding.strength === 'strong' ? 'Strong' : 'Partial'} · {binding.projectId} —{' '}
              {binding.evidence}
            </p>
          ))
        : view.gaps.map((gap, index) => (
            <div key={`${index}-${gap.probe}`} style={{ margin: '0 0 0.25rem' }}>
              <p style={{ margin: 0 }}>They will probe: {gap.probe}</p>
              {/* An injected gap's `play` is '' by FND-07 design; render the line only
                  when there is something to say, rather than an empty "bridge". */}
              {gap.play.trim() !== '' ? <p style={{ margin: 0 }}>Your bridge: {gap.play}</p> : null}
            </div>
          ))}
    </li>
  );
}

const cardStyle = {
  border: '1px solid #d0d0d0',
  borderRadius: '4px',
  padding: '1rem',
  margin: '0 0 1rem',
} as const;

export default function SubScoreCard({
  label,
  sub,
  jd,
  ledger,
}: {
  label: string;
  sub: SubScore;
  jd: JdExtract;
  ledger: Ledger;
}) {
  const notAssessed = isNotAssessed(sub);
  const bindings = resolveRequirements(sub.bindings, jd, ledger);
  const gaps = resolveRequirements(sub.gaps, jd, ledger);

  return (
    <article style={cardStyle}>
      <h3 style={{ fontSize: '1rem', margin: '0 0 0.25rem' }}>{label}</h3>

      {notAssessed ? (
        <>
          <p style={{ margin: '0 0 0.25rem', fontWeight: 700 }}>Not assessed</p>
          <p style={{ margin: 0, color: '#555' }}>
            This posting states no requirement in this category.
          </p>
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 0.5rem', fontSize: '1.25rem', fontWeight: 700 }}>
            {sub.score} / 100
          </p>

          <details>
            <summary>
              {bindings.length} supported · {gaps.length} gaps
            </summary>

            {bindings.length > 0 ? (
              <>
                <h4 style={{ fontSize: '0.95rem', margin: '0.5rem 0 0.25rem' }}>
                  Supporting evidence
                </h4>
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {bindings.map((view) => (
                    <RequirementRow key={`b-${view.requirementId}`} view={view} kind="binding" />
                  ))}
                </ul>
              </>
            ) : null}

            {gaps.length > 0 ? (
              <>
                <h4 style={{ fontSize: '0.95rem', margin: '0.5rem 0 0.25rem' }}>Gaps</h4>
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {gaps.map((view) => (
                    <RequirementRow key={`g-${view.requirementId}`} view={view} kind="gap" />
                  ))}
                </ul>
              </>
            ) : null}
          </details>
        </>
      )}
    </article>
  );
}
