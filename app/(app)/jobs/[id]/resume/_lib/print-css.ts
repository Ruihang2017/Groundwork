// TLR-02 (plan §3.5) — the static print stylesheet, emitted as a `<style>` string by
// print-view.tsx (D1/D2). The repo has NO global CSS file and no CSS modules (everything
// is inline `style={{…}}`), and `@page`/`@media`/`!important` CANNOT be expressed inline,
// so print styling must be a `<style>` element carrying this constant. React renders
// `<style>{printCss(...)}</style>` safely — it is our own constant, never user content, so
// there is no `dangerouslySetInnerHTML` and no injection surface.
//
// THE VISIBILITY TRICK hides ancestor chrome this ticket may NOT edit (the root
// `<header>` in app/layout.tsx and the job `<h1>`/StatusChip/JobTabs in [id]/layout.tsx)
// without selecting it by a fragile per-element selector: everything is hidden in print,
// then `#print-root` and its subtree are made visible again and positioned at the origin.
// `display:block` re-shows `#print-root` even though the screen rule set `display:none`.
//
// EXACTLY ONE `#print-root` may exist per rendered page — the resume page has one (the
// hub's screen-hidden PrintView); the print route has one. Never both on one page.

/**
 * Build the print CSS. `screenHideRoot` is true for the in-page hidden PrintView (the
 * `#print-root` must not show on screen there), false for the standalone print route
 * (which shows the formatted draft on screen).
 */
export function printCss(opts: { screenHideRoot: boolean }): string {
  const screenBlock = opts.screenHideRoot
    ? '@media screen { #print-root { display: none; } }\n'
    : '';
  return `@page { margin: 1.6cm; }
${screenBlock}@media print {
  body * { visibility: hidden !important; }
  #print-root, #print-root * { visibility: visible !important; }
  #print-root {
    position: absolute; inset: 0; margin: 0; padding: 0; display: block !important;
    font-family: Georgia, 'Times New Roman', serif; color: #000; background: #fff;
  }
  #print-root a { color: #000; text-decoration: none; }
}`;
}
