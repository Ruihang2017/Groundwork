import type { DroppedItem } from '@/app/(app)/jobs/[id]/resume/_lib/dropped-view';

export type { DroppedItem };

// TLR-02 Deliverable 4 (plan §3.9 / D7) — THIS MODULE'S OWN COPY of the dropped-count
// header. PRD §5.7's 产出展示 row: "dropped > 0 表头计数、可展开被弃条目". Mirrors
// 04-fit/FIT-03's dropped-count-header.tsx structure, WITHOUT its `partial` flag: TLR-02's
// discard list is either fully present at generation or entirely absent on reload (TLR-01
// does not persist `dropped`), so there is no partial middle state to annotate.
//
// PER-MODULE DUPLICATION IS DELIBERATE (docs/prd/breakdown-plan.md; Feedback obligation #3):
// this component is NOT imported from 04-fit and must NOT be imported by other modules. If
// the duplication becomes a real maintenance problem, raise it in breakdown-plan.md §6 —
// do not unilaterally refactor across module file-scopes.
//
// E9 (from FIT-03's copy) — under jsdom a CLOSED `<details>` still exposes its content to
// Testing Library (no UA stylesheet), so tests assert `details.open`, never "content is
// invisible". Items render as TEXT (model-derived content is never HTML).

export default function DroppedCountHeader({
  droppedCount,
  items,
}: {
  droppedCount: number;
  items: DroppedItem[];
}) {
  // Nothing at all on the healthy path — no wrapper, no empty <details>.
  if (droppedCount === 0) return null;

  return (
    <section style={{ margin: '0 0 1.5rem' }}>
      <p style={{ fontWeight: 700, margin: '0 0 0.25rem' }}>
        {droppedCount === 1 ? '1 item was dropped' : `${droppedCount} items were dropped`}
      </p>

      {items.length > 0 ? (
        <details>
          <summary>Show the dropped entries</summary>
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
            {items.map((item, index) => (
              <li key={`${index}-${item.label}`} style={{ margin: '0 0 0.25rem' }}>
                <strong>{item.label}</strong> — {item.detail}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
