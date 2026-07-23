// PRP-04 Deliverable 4 (plan §2.4) — the 3 `askThem` items (PRD §5.4: "askThem[3]"): smart
// questions for the candidate to ask the interviewer. Rendered as a list under a heading.
//
// Renders a neutral line if the array is empty (defensive — a valid Rehearse carries exactly
// 3, but the relaxed read path never touches askThem, so this is belt-and-braces). Items are
// interpolated as `{text}` (React-escaped; S5) — never HTML.

const headingStyle = { fontSize: '1.1rem', margin: '0 0 0.5rem' } as const;

export default function AskThemList({ askThem }: { askThem: string[] }) {
  return (
    <section style={{ margin: '0 0 1.5rem' }} aria-label="Questions to ask them">
      <h2 style={headingStyle}>Questions to ask them</h2>
      {askThem.length === 0 ? (
        <p style={{ margin: 0 }}>No questions to ask were generated.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {askThem.map((item, index) => (
            <li key={`ask-${index}`} style={{ margin: '0 0 0.25rem' }}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
