'use client';

import { printCss } from '@/app/(app)/jobs/[id]/resume/_lib/print-css';
import { renderMarkdown } from '@/app/(app)/jobs/[id]/resume/_lib/render-markdown';

// TLR-02 (plan §3.11 / D1/D2) — the shared formatted + print-styled render of a draft.
// Emits the print CSS as a `<style>` element (see print-css.ts for why inline styles
// cannot express `@page`/`@media`) and the draft rendered through the documented-subset
// markdown renderer inside `#print-root` — the one element the `@media print` visibility
// trick keeps visible.
//
// TWO USES, one component:
//   - the hub renders it HIDDEN (`screenHideRoot`, no button): it provides the
//     `#print-root` that the hub's own "Print / Save as PDF" button targets, capturing the
//     user's CURRENT edits with no server round-trip (Deliverable 6 resolution).
//   - the standalone print route renders it VISIBLE (`showPrintButton`, not screen-hidden):
//     it shows the PERSISTED draft on screen with its own print button.
//
// The optional button sits OUTSIDE `#print-root` so it is hidden in print. `window.print`
// is the browser's own dialog — no library, no PDF generation (PRD §5.3 "浏览器打印 PDF").

export default function PrintView({
  draft,
  screenHideRoot = false,
  showPrintButton = false,
}: {
  draft: string;
  screenHideRoot?: boolean;
  showPrintButton?: boolean;
}) {
  return (
    <>
      {/* Our own constant CSS string — safe as a child, never dangerouslySetInnerHTML. */}
      <style>{printCss({ screenHideRoot })}</style>

      {showPrintButton ? (
        <p>
          <button type="button" onClick={() => window.print()}>
            Print / Save as PDF
          </button>
        </p>
      ) : null}

      <div id="print-root">{renderMarkdown(draft)}</div>
    </>
  );
}
