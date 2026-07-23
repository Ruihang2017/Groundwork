import type { Intel } from '@/lib/schemas/pipeline';

// PRP-04 Deliverable 2 (plan §2.4 / D9) — renders the RESEARCH `Intel`: snapshot, then
// `recent` (each item's `headline` — which carries the source month/year per PRP-01 D9c — and
// its `soWhat`), `engineeringSignals`, and `talkingPoints`.
//
// SELF-GUARDING: returns `null` when `intel === null` (the research-fail banner covers that
// case — D9). BriefView renders this and the banner as complements.
//
// EMPTY ARRAYS ARE THE VALID "查无实据" STATE (FND-03: no `.min(1)` on any Intel array; PRD
// §5.1 "查无实据返回空数组，禁止编造"). Each array section renders ONLY when non-empty — an
// empty list is never drawn.
//
// PRD §12 ("搜索结果污染" — intel is web-sourced, best-effort): a standing caption tells the
// user to verify before the interview. All content is interpolated as `{text}` (React
// auto-escapes) — NEVER `dangerouslySetInnerHTML` — because intel is model/web-sourced (S5).

const headingStyle = { fontSize: '1.1rem', margin: '0 0 0.5rem' } as const;
const subHeadingStyle = { fontSize: '0.95rem', margin: '1rem 0 0.25rem' } as const;

/** PRD §12 usage-norm caption. Exported so the copy and its test cannot drift. */
export const INTEL_VERIFY_CAPTION =
  'Company research is best-effort and may be out of date — verify anything load-bearing before your interview.';

export default function IntelCard({ intel }: { intel: Intel | null }) {
  // Complement of research-fail-banner.tsx: the banner owns the null case.
  if (intel === null) return null;

  return (
    <section style={{ margin: '0 0 1.5rem' }} aria-label="Company intel">
      <h2 style={headingStyle}>Company intel</h2>
      <p style={{ margin: '0 0 0.5rem' }}>{intel.snapshot}</p>

      {intel.recent.length > 0 ? (
        <>
          <h3 style={subHeadingStyle}>Recent developments</h3>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {intel.recent.map((item, index) => (
              <li key={`recent-${index}`} style={{ margin: '0 0 0.5rem' }}>
                <p style={{ margin: '0 0 0.25rem', fontWeight: 700 }}>{item.headline}</p>
                <p style={{ margin: 0 }}>So what: {item.soWhat}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {intel.engineeringSignals.length > 0 ? (
        <>
          <h3 style={subHeadingStyle}>Engineering signals</h3>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {intel.engineeringSignals.map((signal, index) => (
              <li key={`signal-${index}`} style={{ margin: '0 0 0.25rem' }}>
                {signal}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {intel.talkingPoints.length > 0 ? (
        <>
          <h3 style={subHeadingStyle}>Talking points</h3>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {intel.talkingPoints.map((point, index) => (
              <li key={`talk-${index}`} style={{ margin: '0 0 0.25rem' }}>
                {point}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p style={{ fontSize: '0.85rem', fontStyle: 'italic', margin: '1rem 0 0' }}>
        {INTEL_VERIFY_CAPTION}
      </p>
    </section>
  );
}
