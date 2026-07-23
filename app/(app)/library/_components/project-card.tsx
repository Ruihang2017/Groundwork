'use client';

import { useId } from 'react';

import { joinList } from '@/app/(app)/library/_lib/library-edits';
import type { Project } from '@/lib/schemas/entities';

// LIB-03 Deliverable 4 — the read-only project card, and the OTHER half of
// PRD §5.7's Library rule: "卡片级警告" (a per-card warning), which is required
// IN ADDITION TO, never instead of, empty-metrics-banner.tsx's page-top tally.
//
// The warning text contains the literal lowercase string "no metrics" because
// PRD §2 P2 names that exact interface wording: 「库中项目没有 metrics，界面显示
// "no metrics" 警告」.
//
// SECURITY (plan §4 S2): every field here is rendered as TEXT. `Library` content
// originates from an LLM whose input is attacker-influenced resume text, so
// React's default escaping is the entire XSS control. There is no
// `dangerouslySetInnerHTML` and no markdown/HTML renderer anywhere in this ticket.
//
// `useId()` supplies the heading id rather than `project.id`: PARSE can emit
// DUPLICATE `Project.id`s (LIB-01 enforces uniqueness nowhere — docs/plans/
// LIB-01.md §4 R7), and two cards sharing a DOM id would make `aria-labelledby`
// resolve both headings to the first one.

const DANGER = '#b00020';

const cardStyle = {
  border: '1px solid #d0d0d0',
  borderRadius: '4px',
  padding: '1rem',
  margin: '0 0 1rem',
} as const;

export default function ProjectCard({
  project,
  onEdit,
  onRemove,
  disabled = false,
}: {
  project: Project;
  onEdit?: () => void;
  onRemove?: () => void;
  /** True while another mutation is in flight — see plan §4 C3. */
  disabled?: boolean;
}) {
  const headingId = useId();

  // An empty name is schema-valid (FND-02 puts `.min(1)` on nothing), and a card
  // with an empty accessible name cannot be addressed by
  // `getByRole('article', { name })` — nor announced usefully by a screen reader.
  const title = project.name.trim() === '' ? 'Untitled project' : project.name;

  return (
    <article aria-labelledby={headingId} style={cardStyle}>
      <h3 id={headingId} style={{ margin: '0 0 0.25rem' }}>
        {title}
      </h3>
      <p style={{ margin: '0 0 0.5rem', color: '#555' }}>
        {project.role} · {project.stage}
      </p>

      {project.summary.trim() !== '' ? <p>{project.summary}</p> : null}

      {project.stack.length > 0 ? <p>Stack: {joinList(project.stack, 'comma')}</p> : null}

      {project.metrics.length > 0 ? (
        <ul>
          {project.metrics.map((metric, index) => (
            // Index is part of the key because metrics are free text and may
            // legitimately repeat; there is no stable id to key on.
            <li key={`${index}-${metric}`}>{metric}</li>
          ))}
        </ul>
      ) : (
        <p style={{ color: DANGER, fontWeight: 700 }}>
          no metrics — add a real number from your resume
        </p>
      )}

      {project.tags.length > 0 ? <p>Tags: {joinList(project.tags, 'comma')}</p> : null}

      {onEdit ? (
        <button type="button" onClick={onEdit} disabled={disabled}>
          Edit
        </button>
      ) : null}{' '}
      {onRemove ? (
        <button type="button" onClick={onRemove} disabled={disabled}>
          Remove
        </button>
      ) : null}
    </article>
  );
}
