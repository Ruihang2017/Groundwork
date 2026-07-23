// PRP-04 Deliverable 5 (plan §2.4) — the `positioning` string (PRD §5.4: "positioning"): the
// one-paragraph framing the candidate should carry into the interview. Rendered under a
// heading.
//
// Renders NOTHING EXTRA (just the heading + an empty paragraph is avoided) when the string is
// empty — a positioning line is always produced by a valid Rehearse, but an empty string
// should not draw a stray blank paragraph. Content is `{text}` (React-escaped; S5) — never
// HTML.

const headingStyle = { fontSize: '1.1rem', margin: '0 0 0.5rem' } as const;

export default function PositioningSummary({ positioning }: { positioning: string }) {
  if (positioning === '') return null;

  return (
    <section style={{ margin: '0 0 1.5rem' }} aria-label="How to position yourself">
      <h2 style={headingStyle}>How to position yourself</h2>
      <p style={{ margin: 0 }}>{positioning}</p>
    </section>
  );
}
