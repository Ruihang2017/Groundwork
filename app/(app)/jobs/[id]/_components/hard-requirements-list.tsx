import type { HardRequirementCheck } from '@/lib/schemas/pipeline';

// FIT-03 Deliverable 5 — PRD §5.2's first mandatory block, quoted: "**硬性条件**
// （签证 / 地点 / 年限 / 语言）逐条 pass / fail / unknown，**置顶展示**". The
// "置顶" is honoured by fit-report-view.tsx, which renders this component first.
//
// PLAN D12 — TEXT TOKENS, NOT COLOUR. Each row carries the literal word Pass / Fail /
// Unknown. Colour is an ADDITION and never the sole carrier: a colour-only status is
// unreadable for colour-blind users, in monochrome print, and in any high-contrast
// mode — and this repo has no design system to lean on for a safe palette.
//
// PLAN D12 — AN EMPTY ARRAY IS NORMAL, NOT NOTHING. FIT-02's CROSS emits a
// hardRequirements entry only for the kinds a posting actually states, so `[]` is a
// routine outcome. A PRD-mandated "置顶展示" section that silently disappears reads as
// a rendering bug, so the empty case renders an explicit sentence instead.
//
// SECURITY: `label` originates from a model whose input is an attacker-influenced job
// posting. Every field here is rendered as TEXT — React's escaping is the entire XSS
// control, and there is no `dangerouslySetInnerHTML` anywhere in this ticket.

const STATUS_LABELS = {
  pass: 'Pass',
  fail: 'Fail',
  unknown: 'Unknown',
} as const;

const STATUS_COLOURS = {
  pass: '#146c2e',
  fail: '#b00020',
  unknown: '#6b5500',
} as const;

export default function HardRequirementsList({ items }: { items: HardRequirementCheck[] }) {
  return (
    <section style={{ margin: '0 0 1.5rem' }}>
      <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>Hard requirements</h2>

      {items.length === 0 ? (
        <p style={{ margin: 0, color: '#555' }}>
          This posting states no hard requirements we could check.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {items.map((item, index) => (
            // Index is part of the key because `label` is free model text and two
            // entries may legitimately repeat; there is no stable id to key on.
            <li key={`${index}-${item.label}`} style={{ margin: '0 0 0.25rem' }}>
              <span
                style={{ color: STATUS_COLOURS[item.status], fontWeight: 700 }}
              >
                {STATUS_LABELS[item.status]}
              </span>{' '}
              — {item.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
