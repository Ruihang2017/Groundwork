'use client';

import type { Edit } from '@/lib/schemas/pipeline';

// TLR-02 Deliverable 2 (plan §3.7) — one `Edit` with an accept/reject toggle. PRD §5.3's
// "用户逐条采纳，不是黑盒整篇替换": the checkbox DEFAULTS to the `accepted` prop, which the
// parent seeds to `false` for every edit (opt-IN, not opt-out). Toggling calls
// `onToggle(index, checked)`; the parent owns the accepted set and the draft re-derivation.
//
// All fields render as TEXT (React escapes) — never HTML. `projectName` is resolved by the
// parent from the job's Library (`projectNameMap[edit.projectId] ?? edit.projectId`), so a
// project id dropped from the library after generation falls back to the raw id (plan R4).

export default function EditCard({
  edit,
  index,
  accepted,
  projectName,
  onToggle,
}: {
  edit: Edit;
  index: number;
  accepted: boolean;
  projectName: string;
  onToggle: (index: number, accepted: boolean) => void;
}) {
  return (
    <article
      style={{
        border: '1px solid #d0d0d0',
        borderRadius: '0.4rem',
        margin: '0 0 1rem',
        padding: '0.75rem 1rem',
      }}
    >
      <p style={{ margin: '0 0 0.5rem' }}>
        <strong>Original:</strong> {edit.original}
      </p>
      <p style={{ margin: '0 0 0.5rem' }}>
        <strong>Suggested:</strong> {edit.suggested}
      </p>
      <p style={{ margin: '0 0 0.5rem' }}>
        <strong>Why:</strong> {edit.rationale}
      </p>
      <p style={{ color: '#555', margin: '0 0 0.75rem' }}>
        <small>Source project: {projectName}</small>
      </p>
      <label>
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => onToggle(index, e.target.checked)}
        />{' '}
        Adopt this edit
      </label>
    </article>
  );
}
