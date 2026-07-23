import type { RehearseQuestion } from '@/lib/schemas/pipeline';

// PRP-04 Deliverable 3 (plan §2.4 / D10; acceptance item 4) — the rehearsal questions,
// GROUPED BY `projectId` (the "angle" per PRD §4 S4: "面前按 angle 排练"). PRD gives no other
// candidate grouping dimension, and each question is "只因该项目的具体内容才可问", so the
// source project is the natural angle.
//
// D10 — grouped in FIRST-APPEARANCE order (deterministic; preserves the model's ordering, no
// re-sort). One header per distinct `projectId`; header text = `projectNames[projectId]` with
// a RAW-ID FALLBACK for any id absent from the map (a library edited after generation can drop
// a cited id — mirrors resume/_lib/project-names.ts's documented behaviour). Under each
// header, every question's `question` and its `trap` (labelled). Content is interpolated as
// `{text}` (React-escaped; S5) — never HTML.

const headingStyle = { fontSize: '1.1rem', margin: '0 0 0.5rem' } as const;
const groupHeadingStyle = { fontSize: '1rem', margin: '1rem 0 0.5rem' } as const;

export default function QuestionList({
  questions,
  projectNames,
}: {
  questions: RehearseQuestion[];
  projectNames: Record<string, string>;
}) {
  if (questions.length === 0) {
    return (
      <section style={{ margin: '0 0 1.5rem' }} aria-label="Rehearsal questions">
        <h2 style={headingStyle}>Rehearsal questions</h2>
        <p style={{ margin: 0 }}>No rehearsal questions were generated.</p>
      </section>
    );
  }

  // Group by projectId, preserving first-appearance order (D10). A Map keeps insertion order,
  // and each entry keeps the question's original index for a stable React key.
  const groups = new Map<string, Array<{ question: RehearseQuestion; index: number }>>();
  questions.forEach((question, index) => {
    const bucket = groups.get(question.projectId) ?? [];
    bucket.push({ question, index });
    groups.set(question.projectId, bucket);
  });

  return (
    <section style={{ margin: '0 0 1.5rem' }} aria-label="Rehearsal questions">
      <h2 style={headingStyle}>Rehearsal questions</h2>
      {[...groups.entries()].map(([projectId, bucket]) => (
        <div key={`group-${projectId}`}>
          <h3 style={groupHeadingStyle}>{projectNames[projectId] ?? projectId}</h3>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {bucket.map(({ question, index }) => (
              <li key={`${projectId}-${index}`} style={{ margin: '0 0 0.75rem' }}>
                <p style={{ margin: '0 0 0.25rem', fontWeight: 700 }}>{question.question}</p>
                <p style={{ margin: 0 }}>Follow-up: {question.trap}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
