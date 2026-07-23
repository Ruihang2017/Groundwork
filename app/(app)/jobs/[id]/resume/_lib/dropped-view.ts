import type { Edit } from '@/lib/schemas/pipeline';

// TLR-02 Deliverable 4 (plan §3.3) — maps TLR-01's 200-body `dropped` payload into the
// dropped-count header's items. Mirrors 04-fit/FIT-03's `fit-view-model.droppedFromResponse`
// in shape, adapted to TAILOR's discard categories (discarded edits + stripped numbers).
//
// MODULE-LOCAL TYPE (docs/prd/breakdown-plan.md §3: "任何模块新增的 Zod/类型必须落在自己
// 模块目录下"). `TailorDropped` transcribes TLR-01's wire contract; it is NOT imported from
// 04-fit — the per-module duplication is the deliberate breakdown-plan decision (plan D7).
//
// NOT RE-DERIVABLE ON RELOAD (plan R7 / Deliverable 4): TLR-01 does NOT persist `dropped`
// (its route header / §5 Q2), so this payload exists only in the fresh-generation 200 body.
// On a later page visit the workspace is handed `[]` / `0` and the header renders nothing.

/** One expandable entry under the dropped-count header. */
export type DroppedItem = { label: string; detail: string };

/** TLR-01's 200-body `dropped` payload, transcribed (see the route's WIRE CONTRACT). */
export type TailorDropped = {
  count: number;
  edits: Array<{ item: Edit; reason: string }>;
  numbers: Array<{ token: string; reason: string }>;
};

const SNIPPET_MAX = 80;

/** First ~80 chars, with an ellipsis appended when truncated. */
function snippet(text: string): string {
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}

/**
 * Map TLR-01's dropped payload → the header's items, edits first then numbers (the two
 * summands of `count`). `undefined` (the reload path, where TLR-01 sent no `dropped`)
 * maps to an empty list.
 */
export function toDroppedItems(dropped: TailorDropped | undefined): DroppedItem[] {
  if (!dropped) return [];
  return [
    ...dropped.edits.map(({ item, reason }) => ({
      // An empty `original` carries no readable anchor, so fall back to the project id.
      label: item.original === '' ? item.projectId : snippet(item.original),
      detail: `Rewrite discarded (${reason}).`,
    })),
    ...dropped.numbers.map(({ token, reason }) => ({
      label: token,
      detail: `Number removed (${reason}).`,
    })),
  ];
}
