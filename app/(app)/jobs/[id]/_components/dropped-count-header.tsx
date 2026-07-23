import type { DroppedItem } from '@/app/(app)/jobs/[id]/_components/fit-view-model';

export type { DroppedItem };

// FIT-03 Deliverable 6 — PRD §5.7's 产出展示 row, quoted: "dropped > 0 表头计数、
// **可展开被弃条目**" (the same row's `research fail` clause is 06-prep's concern).
// PRD §5.5 layer 1 is the other half: "dropped 计数随响应返回，前端可查看被弃原始条目".
//
// TICKET DELIVERABLE 6's OWN NOTE, carried here verbatim in intent: this component
// exists for the FIT TAB ONLY. `05-tailor` and `06-prep` must NOT import it — per-
// module duplication of small presentational units was the DELIBERATE choice recorded
// in `docs/prd/breakdown-plan.md`, taken to keep the modules' file-scopes disjoint.
// If that duplication later causes real maintenance pain, raise it as a NEW open
// question in breakdown-plan.md §6 (ticket Feedback obligation #2) — do not resolve it
// unilaterally by reaching into another module's files.
//
// PLAN D8 — `partial` is the honest half of a limitation this ticket cannot fix.
// FIT-02's `dropped.bindings` (layer 1's raw discards) exists ONLY in the response
// that produced it; `jobs` has no column for it. So on any page load after that run,
// the recoverable count is layer 2's injections alone — a SMALLER number than the one
// shown moments earlier. Showing the smaller number with no note was rejected: a count
// that silently shrinks between the first view and a refresh is worse than either
// honest option, and is exactly what PRD's "宁可暴露不完整，不静默吞掉" forbids. The
// underlying gap needs a new column (FND-05's file-scope) and is plan §5 Q3, owner
// Horace.
//
// E9 — `<details>`/`<summary>` under jsdom: clicking the summary really does flip
// `details.open`, but Testing Library STILL returns content inside a CLOSED
// `<details>` (jsdom applies no UA stylesheet). So a test must assert `details.open`
// and element presence, never "the collapsed content is invisible" — that assertion
// would pass for the wrong reason.

/** Plan D8's note, exported so the component and its test share one string. */
export const PARTIAL_DROPPED_NOTE =
  'The discarded raw entries are only available on the run that produced them.';

export default function DroppedCountHeader({
  droppedCount,
  items,
  partial = false,
}: {
  droppedCount: number;
  items: DroppedItem[];
  partial?: boolean;
}) {
  // Nothing at all — no wrapper, no heading, no empty <details>. An "0 items were
  // dropped" line would be noise on the overwhelmingly common healthy path.
  if (droppedCount === 0) return null;

  return (
    <section style={{ margin: '0 0 1rem' }}>
      <p style={{ margin: '0 0 0.25rem', fontWeight: 700 }}>
        {droppedCount === 1 ? '1 item was dropped' : `${droppedCount} items were dropped`}
      </p>

      {partial ? <p style={{ margin: '0 0 0.25rem', color: '#555' }}>{PARTIAL_DROPPED_NOTE}</p> : null}

      {items.length > 0 ? (
        <details>
          <summary>Show the dropped entries</summary>
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
            {items.map((item, index) => (
              // Free text on both fields; index is part of the key because entries may
              // legitimately repeat and carry no id.
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
