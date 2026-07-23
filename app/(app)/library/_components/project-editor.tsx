'use client';

import { useState } from 'react';

import { joinList, splitList } from '@/app/(app)/library/_lib/library-edits';
import type { Project } from '@/lib/schemas/entities';

// LIB-03 — the editable project card, shared by the draft-confirm flow
// (Deliverable 2) and the ongoing edit flow on the confirmed Library page
// (Deliverable 5).
//
// PRD §4 S1 makes "逐条确认/微调" — confirm/tweak ITEM BY ITEM — the load-bearing
// requirement: the user reviews and edits individual projects, not an
// accept-all/reject-all binary. Every field FND-02's `Project` carries is
// editable here except `id`.
//
// `id` is shown as static text, never an input. It is generated once when a
// project is created and NEVER regenerated when the name changes: ids are the
// join key FND-07's referential-integrity layer uses downstream, so rewriting one
// under the user would silently re-point future bindings (plan §2.3).
//
// LOCAL TEXT STATE for the three array fields is deliberate, not sloppiness. If
// the textarea's value were `joinList(splitList(text))`, typing "React," would
// round-trip to "React" and the comma would vanish under the cursor mid-keystroke.
// So the raw text is held locally (seeded once from the incoming project) and the
// PARSED array is pushed to the parent on every change. `splitList` drops empty
// entries, which is what makes an emptied Metrics box submit `[]` and not `['']`
// — plan §4 E1, the bug that would silently delete this ticket's entire
// empty-metrics acceptance surface.
//
// Every `id`/`htmlFor` is prefixed with the row `uid` (never `project.id`, which
// PARSE can duplicate — LIB-01 §4 R7). Duplicate DOM ids across cards break
// `getByLabelText` with "found multiple elements" and, worse, make a real click on
// one card's label focus another card's input (plan §4 E12).

const fieldStyle = { display: 'block', width: '100%', margin: '0.25rem 0 0.75rem' } as const;

const cardStyle = {
  border: '1px solid #d0d0d0',
  borderRadius: '4px',
  padding: '1rem',
  margin: '0 0 1rem',
} as const;

export default function ProjectEditor({
  uid,
  project,
  onChange,
  onRemove,
  disabled = false,
}: {
  uid: string;
  project: Project;
  onChange: (next: Project) => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const [stackText, setStackText] = useState(() => joinList(project.stack, 'comma'));
  const [metricsText, setMetricsText] = useState(() => joinList(project.metrics, 'line'));
  const [tagsText, setTagsText] = useState(() => joinList(project.tags, 'comma'));

  const title = project.name.trim() === '' ? 'Untitled project' : project.name;

  return (
    <article aria-labelledby={`${uid}-heading`} style={cardStyle}>
      <h3 id={`${uid}-heading`} style={{ margin: '0 0 0.75rem' }}>
        {title}
      </h3>

      <label htmlFor={`${uid}-name`}>Name</label>
      <input
        id={`${uid}-name`}
        type="text"
        value={project.name}
        disabled={disabled}
        onChange={(e) => onChange({ ...project, name: e.target.value })}
        style={fieldStyle}
      />

      <label htmlFor={`${uid}-stage`}>Stage</label>
      <input
        id={`${uid}-stage`}
        type="text"
        value={project.stage}
        disabled={disabled}
        onChange={(e) => onChange({ ...project, stage: e.target.value })}
        style={fieldStyle}
      />

      <label htmlFor={`${uid}-role`}>Role</label>
      <input
        id={`${uid}-role`}
        type="text"
        value={project.role}
        disabled={disabled}
        onChange={(e) => onChange({ ...project, role: e.target.value })}
        style={fieldStyle}
      />

      <label htmlFor={`${uid}-stack`}>Stack (comma-separated)</label>
      <input
        id={`${uid}-stack`}
        type="text"
        value={stackText}
        disabled={disabled}
        onChange={(e) => {
          setStackText(e.target.value);
          onChange({ ...project, stack: splitList(e.target.value, 'comma') });
        }}
        style={fieldStyle}
      />

      <label htmlFor={`${uid}-summary`}>Summary</label>
      <textarea
        id={`${uid}-summary`}
        rows={4}
        value={project.summary}
        disabled={disabled}
        onChange={(e) => onChange({ ...project, summary: e.target.value })}
        style={fieldStyle}
      />

      <label htmlFor={`${uid}-metrics`}>Metrics (one per line)</label>
      <textarea
        id={`${uid}-metrics`}
        rows={3}
        value={metricsText}
        disabled={disabled}
        onChange={(e) => {
          setMetricsText(e.target.value);
          onChange({ ...project, metrics: splitList(e.target.value, 'line') });
        }}
        style={fieldStyle}
      />
      <p id={`${uid}-metrics-help`} style={{ margin: '-0.5rem 0 0.75rem', color: '#555' }}>
        One real number per line, exactly as it appears in your resume. Leave it empty if you
        have none — that is a valid state, and it will be flagged.
      </p>

      <label htmlFor={`${uid}-tags`}>Tags (comma-separated)</label>
      <input
        id={`${uid}-tags`}
        type="text"
        value={tagsText}
        disabled={disabled}
        onChange={(e) => {
          setTagsText(e.target.value);
          onChange({ ...project, tags: splitList(e.target.value, 'comma') });
        }}
        style={fieldStyle}
      />

      <p style={{ color: '#555' }}>ID: {project.id}</p>

      {onRemove ? (
        <button type="button" onClick={onRemove} disabled={disabled}>
          Remove
        </button>
      ) : null}
    </article>
  );
}
