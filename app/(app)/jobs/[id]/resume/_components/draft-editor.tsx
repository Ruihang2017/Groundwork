'use client';

// TLR-02 Deliverable 3 (plan §3.8) — the in-place markdown editor. A controlled
// `<textarea>` holding the working draft (PRD §5.3 "markdown 就地编辑"). The `deriveDraft`
// seeding and the re-derive-on-toggle live in the parent hub (resume-workspace.tsx); this
// component is only the raw-markdown editing surface. The formatted view is the print
// root / print route, not here.

export default function DraftEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ margin: '0 0 1.5rem' }}>
      <label htmlFor="resume-draft-editor" style={{ display: 'block', fontWeight: 700, margin: '0 0 0.25rem' }}>
        Full draft (markdown)
      </label>
      <textarea
        id="resume-draft-editor"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        rows={24}
        style={{
          display: 'block',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          width: '100%',
        }}
      />
    </div>
  );
}
