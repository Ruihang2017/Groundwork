import type { AlignmentEntry } from '@/lib/schemas/pipeline';

// TLR-02 Deliverable 1 (plan §3.6) — PRD §5.3's 关键词对齐表. Renders TLR-01's
// `AlignmentEntry[]` colored by status, with real-text labels (colour is only ever an
// ADDITION — a chip whose meaning lives in its colour is unreadable for colour-blind
// users and in print; same reasoning as status-chip.tsx). No `'use client'` — no hooks,
// no browser API.
//
// HARD REQUIREMENT (acceptance item 1 — the direct proof of PRD's "库里也没有 → 显示为
// gap，绝不写入简历"): this component renders ZERO interactive controls for ANY entry —
// no button, checkbox, link, or accept action anywhere, and specifically none on a
// `missing_in_library` row. There is no "adopt" path for a gap; it is display only. Each
// row carries `data-status` so a test can scope "no actionable control within a
// missing_in_library row".

const STATUS_META: Record<AlignmentEntry['status'], { label: string; color: string }> = {
  present: { label: 'Present', color: '#146c2e' },
  missing_in_resume: { label: 'Missing — fixable by a rewrite', color: '#1c4f9c' },
  missing_in_library: {
    label: 'Gap — not in your library, and never written into your resume',
    color: '#b00020',
  },
  synonym_mismatch: { label: 'Synonym mismatch', color: '#8a6d00' },
};

const cellStyle = { padding: '0.35rem 0.75rem 0.35rem 0', verticalAlign: 'top' } as const;

export default function AlignmentTable({ alignment }: { alignment: AlignmentEntry[] }) {
  return (
    <section style={{ margin: '0 0 2rem' }}>
      <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>Keyword alignment</h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...cellStyle, textAlign: 'left' }}>Keyword</th>
            <th style={{ ...cellStyle, textAlign: 'left' }}>Status</th>
            <th style={{ ...cellStyle, textAlign: 'left' }}>Note</th>
          </tr>
        </thead>
        <tbody>
          {alignment.map((entry, index) => {
            const meta = STATUS_META[entry.status];
            return (
              // `data-status` is the stable test hook for scoping "no control on this row".
              <tr key={`${index}-${entry.keyword}`} data-status={entry.status}>
                <td style={cellStyle}>{entry.keyword}</td>
                <td style={{ ...cellStyle, color: meta.color }}>{meta.label}</td>
                <td style={cellStyle}>{entry.note ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
