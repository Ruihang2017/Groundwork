# TLR-02 — Implementation plan: Alignment/edits review UI, full-draft editor, and export

> Architect stage output. Cold-startable: a fresh Builder with no access to the planning
> conversation must be able to execute this from this file alone. Ticket:
> `docs/prd/05-tailor/tickets/TLR-02-alignment-ui-export.md`. Sub-PRD:
> `docs/prd/05-tailor/README.md`. No ADR exists (the ticket declares the decision already
> made in PRD §5.3/§5.7); §2 below records reversible implementation decisions and flags the
> one item worth Horace's eyes as an open question, not an ADR.

---

## 0. Context established by exploration (facts the Builder can rely on)

All read at planning time; cited so the Builder does not re-derive them.

- **This ticket is pure client/server UI.** It adds NO API route and touches NO `lib/**`,
  `app/api/**`, `db/**`, or `package.json`. Its entire write-scope is the `resume/**`
  subtree, which `docs/prd/breakdown-plan.md` §3 assigns wholly to `05-tailor`
  (`app/(app)/jobs/[id]/resume/**`). Therefore `resume/_lib/**`, `resume/_fixtures/**`, and
  `resume/print/**` are all in-scope to create (the whole subtree is owned — unlike FIT-03,
  whose scope was enumerated file-by-file and which therefore could not add a `_lib/`).
- **The two upstream routes are merged and their wire contracts are fixed** (do NOT change
  them; call only):
  - **TLR-01** `POST /api/jobs/[id]/tailor` — `app/api/jobs/[id]/tailor/route.ts`. No request
    body is read. On **200** returns the persisted `TailoredResume` **at the top level** plus
    one additive key:
    ```
    { jobId, alignment: AlignmentEntry[], edits: Edit[], fullDraftMd: string,
      createdAt: number, updatedAt: number,
      dropped: {
        count: number,                                    // == usage_events.droppedCount
        edits:   Array<{ item: Edit; reason: string }>,   // layer-1 discarded edits
        numbers: Array<{ token: string; reason: string }> // layer-3 stripped numbers
      } }
    ```
    Verified against the route header and `route.test.ts` (no-drop case is
    `{ count: 0, edits: [], numbers: [] }`). Error bodies (branch on the `error` STRING, not
    the status alone): `401 {error:"Unauthorized"}`, `404 {error:"not_found"}`,
    `409 {error:"fit_not_ready"}`, `409 {error:"no_library"}`, `422 {error:"tailor_failed"}`,
    `429 {error:"quota_exceeded",op:"tailor",resetAt:number}`,
    `500 {error:"job_read_failed"|"library_read_failed"|"tailor_write_failed"}`,
    `503 {error:"global_breaker_tripped"}`. **KNOWN LIMITATION (TLR-01 route header / §5 Q2):**
    `dropped` is NOT persisted — it exists ONLY in this 200 body. After a reload the
    server-rendered draft is clean but the discard list is gone.
  - **FIT-01** `PATCH /api/jobs/[id]` — `app/api/jobs/[id]/route.ts`. Body
    `{ status: "screening"|"applied"|"interviewing"|"closed" }`, `Content-Type:
    application/json`. `200 <updated job>`; `400 {error:"invalid_body",issues:string[]}`;
    `401`; `404 {error:"not_found"}`; `500 {error:"job_write_failed"}`. Any status is
    accepted from any status (no state machine).
- **Query functions this ticket's server components call** (all import-safe with `DATABASE_URL`
  unset — each lazy-resolves `@/db/index`, so a **static** import from a page is safe and is
  pinned by a build guard, exactly as `app/(app)/jobs/[id]/page.tsx` does):
  - `getTailoredResume(userId, jobId): Promise<TailoredResume | null>` — `lib/db/queries/tailored-resumes.ts`. `null` = no draft, unknown job, OR another user's job (indistinguishable by design).
  - `getLibrary(userId): Promise<Library | null>` — `lib/db/queries/library.ts`. THROWS on stored-row shape drift (loud-failure policy) — do NOT wrap to swallow.
  - `requireUserId(): Promise<string>` — `lib/auth/session.ts`. Throws `UnauthorizedError`.
  - The **job's existence + ownership is already guarded by `app/(app)/jobs/[id]/layout.tsx`**
    (FIT-03), which runs `getJob` + `notFound()` before any child page renders. This ticket's
    pages therefore do NOT re-read the job for existence and do NOT call `getJob` (avoids a
    third per-request read; the layout is the guard).
- **Schemas (all pure Zod, safe to value-import from client bundles):**
  `AlignmentEntry`, `Alignment`, `Edit` in `@/lib/schemas/pipeline`; `TailoredResume`,
  `JobStatus` in `@/lib/schemas/persisted`; `Library`, `Project` in `@/lib/schemas/entities`.
  - `AlignmentEntry = { keyword: string; status: 'present'|'missing_in_resume'|'missing_in_library'|'synonym_mismatch'; note?: string }`.
  - `Edit = { original: string; suggested: string; rationale: string; projectId: string }`.
  - `TailoredResume = { jobId; alignment: AlignmentEntry[]; edits: Edit[]; fullDraftMd: string; createdAt; updatedAt }`.
  - **Client files must NOT value-import `@/lib/db/queries/*`** (that drags `drizzle-orm` +
    `@/db/schema` into the client bundle — see `fit-auto-runner.tsx` E12 and
    `job-fixtures.ts`). `import type { … }` from those modules is fine.
- **Styling reality:** there is **no global CSS file** (`app/**/*.css` — none) and no CSS
  modules; the whole repo styles with inline `style={{…}}` objects. `@media`/`@page` rules
  **cannot** be expressed inline, so print CSS must be emitted as a `<style>` element with a
  **static** string (React renders `<style>{CONST}</style>` safely — it is our own constant,
  never user content; do NOT use `dangerouslySetInnerHTML`).
- **No markdown renderer exists** (`react-markdown`/`marked`/`remark` are absent; `mammoth`
  is DOCX→text for LIB-01 only). See D3 for the decision.
- **`reactStrictMode` defaults to `true`** (`next.config.mjs` is `{}`), so effects mount twice
  in dev — any POST-on-mount would need a `useRef` guard. This ticket's generate trigger is a
  **button click, not on-mount**, so the StrictMode double-mount is a non-issue for it; the
  single-flight guard here defends against double-CLICKS (cost control), per `new-job-form.tsx`.
- **Test harness:** Vitest; component tests use `// @vitest-environment jsdom` +
  `@testing-library/react`; pure-function tests run in the default `node` env. `pnpm test` =
  `vitest run`. `app/**/*.test.{ts,tsx}` is already in `vitest.config.ts` `include`, so no
  config change is needed (and `vitest.config.ts` is FND-01-owned — do not touch it).

---

## 1. Scope

**This ticket changes (creates only — nothing pre-exists under `resume/`):**

A `/jobs/[id]/resume` page (inside FIT-03's job-detail shell) that:
1. When no `TailoredResume` exists yet: renders a **"Generate tailored resume"** trigger that
   POSTs TLR-01's route and renders the result from the response body.
2. When a draft exists: renders (a) the **keyword alignment table**, (b) the per-edit
   **accept/reject** list, (c) an **in-place markdown editor** seeded by applying accepted
   edits to `fullDraftMd`, (d) the module's **own dropped-count header** (fresh-generation
   only), (e) a **"Mark as applied"** button, and (f) an **export/print** path.
3. A **standalone print-optimized route** `resume/print/page.tsx` rendering the persisted draft.

**Explicitly NOT in scope:**

- **No API route, no `lib/**`, no `db/**`, no `package.json`/dependency changes.** Export is
  print-CSS + `window.print()` only (PRD §5.3; §13 Q2 escalation, not pre-empted).
- **No template engine** (PRD §13 Q2 fallback — built only if the `[human]` check fails; see
  Feedback obligation #1). **No** DOCX/PDF-generation library.
- **No server persistence of in-editor edits.** TLR-01's `upsertTailoredResume` is called ONLY
  by TLR-01's own route; this UI never writes back a draft (ticket Deliverable 6 resolution).
  Editing→printing is a **client-side, same-session** flow.
- **No `closed`-status UI**; **no cover-letter**; **no** edit to `layout.tsx`, the tailor
  route, or the jobs route (call only).
- **No write/accept action for `missing_in_library` alignment entries** ("库里也没有 → gap,
  绝不写入简历" — acceptance item 1).
- **No new visual-regression tooling** (print fidelity is a `[human]` judgment, ticket Test plan).

---

## 2. Decisions (reversible implementation choices; not ADRs)

The ticket declares "No ADR — the decision is already made in PRD §5.3/§5.7". The choices below
are implementation-level and reversible (swappable without a data migration or contract change),
so none rises to an ADR. The one product-facing ambiguity is escalated as **Q1** (§6).

- **D1 — Export is client-side and edit-aware, via `window.print()` + an isolated `#print-root`.**
  The resume page's client hub renders, in the same DOM, a **screen-hidden** formatted rendering
  of the **current** working draft; a "Print / Save as PDF" button calls `window.print()`.
  Because that rendering lives in the same client tree as the editor, printing captures the
  user's current unsaved edits with **no server round-trip and no storage** — exactly the ticket
  Deliverable 6 resolution ("operates on whatever is currently in the client-side editor state …
  no server round-trip needed for export"). Ancestor chrome that this ticket must NOT edit
  (root `<header>` in `app/layout.tsx`, the job `<h1>`/StatusChip/JobTabs in `[id]/layout.tsx`)
  is hidden with the standard ancestor-agnostic print trick (§3.7 CSS) rather than by touching
  those files.
- **D2 — `resume/print/page.tsx` is a standalone route that prints the PERSISTED draft.** It
  server-renders `getTailoredResume(...).fullDraftMd` with the same renderer + print CSS. It is
  the "simpler v1 scope of printing the server-persisted draft as-is" the ticket names as
  acceptable, and it is useful as a clean, linkable, chrome-free view of the **generated** draft.
  **Documented limitation:** it shows the persisted draft, NOT unsaved in-editor edits — that is
  the D1 path's job and the exact gap in Feedback obligation #2. The two surfaces are labelled to
  avoid confusion ("Print with your edits" on the page vs. "Open a clean print view of the
  generated draft" for the link). Whether to keep both surfaces is **Q1**.
- **D3 — Markdown → React is a small, in-repo, documented-subset renderer (no dependency).**
  Rationale: (a) raw markdown printed verbatim (`##`, `**`, `- `) is obviously not "可直接投递",
  which would make the `[human]` check fail for the wrong reason and pre-empt PRD §13 Q2's
  empirical question; a renderer is required for the check to be meaningful. (b) Adding
  `react-markdown` touches `package.json` (an allowed cross-module append per breakdown-plan §3)
  and pulls a remark/micromark dependency tree — heavier than this M ticket needs, and against
  the repo's minimal-dependency posture. (c) The repo convention is to render model-derived
  content as **React elements/text, never HTML** (see `dropped-count-header.test.tsx`: "model
  content is never HTML"); an in-repo renderer that returns elements honors that and makes XSS
  structurally impossible. The subset is deliberately bounded (§3.4); anything outside it renders
  as literal text. **This is reversible** (swap to `react-markdown`, or to the template engine per
  §13 Q2, later) — recorded here, not an ADR. Alternative (`react-markdown`) is noted for the
  Reviewer; if the Reviewer/Horace prefers it, that is a one-file swap.
- **D4 — The generate trigger is a user-clicked button, not auto-on-mount** (unlike FIT-03's
  auto-runner). PRD §5.1's TAILOR trigger is "用户决定投" and every call charges a `tailor` quota
  unit (5/day), so generation must be a deliberate act. Single-flight guards double-CLICKS.
- **D5 — "Mark as applied" confirms in place; it does not reload.** On 200 it shows an inline
  "Marked as applied" confirmation and disables itself. The StatusChip lives in FIT-03's layout
  (server-rendered) and this ticket may not edit it, so the chip updates on the user's next
  navigation/refresh — a minor, documented staleness (Risk R5), chosen over a `window.location.reload()`
  that is awkward to assert in jsdom and re-runs the whole detail render.
- **D6 — Toggling an edit re-derives the draft and overwrites the textarea.** Deliverable 3 says
  the derived content is "recomputed whenever the user toggles an edit's accept state" AND the
  draft is "further freely editable afterward". These conflict once the user has hand-edited: a
  re-derive discards manual edits. v1 takes the literal spec (toggle → re-derive → overwrite) and
  shows a visible note ("Choosing edits rebuilds the draft below and discards manual changes —
  finish choosing edits before hand-editing."). The alternative (freeze derivation after the first
  manual edit) is **Q2**.
- **D7 — Per-module duplication of the dropped-count header stands** (breakdown-plan §3; ticket
  Deliverable 4 + Feedback obligation #3). This module gets its OWN copy under `resume/_components/`;
  it does NOT import FIT-03's. Note: the referenced `06-prep`/PRP-04 copy does **not exist yet**
  (only PRP-01 is merged), so FIT-03's copy is the sole precedent to mirror — adapted to TLR-01's
  `dropped` shape and **without** FIT-03's `partial` flag (TLR-02's discard list is either fully
  present at generation or entirely absent on reload — there is no partial middle state).

---

## 3. Change list (exact files, functions, contracts)

All paths under `app/(app)/jobs/[id]/resume/`. Grouped pure → presentational → stateful → pages →
fixtures. `_`-prefixed folders are Next private folders (never routed). Nothing here is a client
component unless it says `'use client'`.

### 3.1 `_lib/draft-derivation.ts` (pure; node-testable) — Deliverable 3's load-bearing function

Acceptance item 3 tests THIS function directly. Signature and exact semantics:

```ts
import type { Edit } from '@/lib/schemas/pipeline';

/**
 * Apply only the ACCEPTED edits to `fullDraftMd`, in place.
 * Pure. No I/O, no mutation of arguments.
 */
export function deriveDraft(
  fullDraftMd: string,
  edits: readonly Edit[],
  acceptedIndices: ReadonlySet<number>,
): string;
```

Exact, pinned semantics (each is a test case in §4):
- Iterate `edits` **in array order**, maintaining a working string starting at `fullDraftMd`.
- For index `i`: if `acceptedIndices.has(i)` AND `edits[i].original !== ''`, replace the
  **FIRST occurrence** of `edits[i].original` in the working string with `edits[i].suggested`.
  Use a **literal string** search (`String.prototype.replace(searchString, replacement)` where
  `searchString` is a string, NOT a RegExp) so model text containing regex metacharacters is
  treated literally and only the first match is replaced.
- Non-accepted edits are skipped — their `original` text remains verbatim.
- If `original` is not found in the working string: **no-op** (the `suggested` text is NOT
  inserted anywhere — an unmatched anchor cannot be placed; documented Risk R4).
- Empty `original`: skipped (guards against a degenerate whole-string mangle).
- `suggested` from a prior accepted edit becomes part of the working string, so a later edit
  could match text an earlier edit produced — this is accepted (deterministic given array order).

### 3.2 `_lib/render-markdown.tsx` (pure → `ReactNode`; node/jsdom-testable) — D3

```ts
import type { ReactNode } from 'react';
/** Documented-subset markdown → React elements. Never returns HTML strings. */
export function renderMarkdown(md: string): ReactNode;
```

Bounded, documented subset (anything outside renders as literal text — this is intentional and
is what the `[human]` §13 Q2 check judges; do NOT chase completeness here — see Feedback
obligation #1):
- **Block grouping:** split on blank lines into blocks.
- **Headings:** a block that is a single line starting with 1–6 `#` then a space → `<h1>`…`<h6>`
  by count.
- **Horizontal rule:** a line of only `---` or `***` → `<hr/>`.
- **Unordered list:** a block whose every line starts with `- ` or `* ` → `<ul><li>…</li></ul>`.
- **Ordered list:** a block whose every line starts with `<digits>. ` → `<ol><li>…</li></ol>`.
- **Paragraph:** any other block → `<p>` with internal line breaks preserved as `<br/>` (resume
  address/contact lines depend on hard breaks).
- **Inline (single non-nested pass, applied to `<li>`/`<p>`/heading text):** `**bold**`→`<strong>`,
  `*em*` / `_em_`→`<em>`, `` `code` ``→`<code>`, `[label](url)`→ see security rule below. Nested
  emphasis (e.g. bold inside a link) is out of subset and renders literally — documented.
- **SECURITY (Reviewer will check):** rendering is via React elements only, so text is escaped by
  React — no HTML injection is possible. The ONLY attacker-influenced attribute is a link `href`.
  Render `[label](url)` as `<a href={url}>label</a>` **only if** `url` starts with `http://`,
  `https://`, or `mailto:` (case-insensitive); otherwise render `label` as plain text with NO
  anchor. This blocks `javascript:`/`data:` URLs. `fullDraftMd` is server-number-filtered but
  still model-derived, so treat it as untrusted.
- Use stable-enough React `key`s (index-based keys are acceptable here — content is static per
  render and not reordered).

### 3.3 `_lib/dropped-view.ts` (pure) + the DroppedItem shape — D4

```ts
import type { Edit } from '@/lib/schemas/pipeline';

export type DroppedItem = { label: string; detail: string };

/** TLR-01's 200-body `dropped` payload, transcribed. Module-local (breakdown-plan §3). */
export type TailorDropped = {
  count: number;
  edits: Array<{ item: Edit; reason: string }>;
  numbers: Array<{ token: string; reason: string }>;
};

/** Map TLR-01's dropped payload → the header's items (mirrors fit-view-model.droppedFromResponse). */
export function toDroppedItems(dropped: TailorDropped): DroppedItem[];
```
- For each `edits[i]`: `label` = a short snippet of `item.original` (first ~80 chars; append `…`
  if truncated) or, if `original` is empty, `item.projectId`; `detail` = `Rewrite discarded (${reason}).`
- For each `numbers[i]`: `label` = `item.token`; `detail` = `Number removed (${reason}).`
- Order: edits first, then numbers (matches the count's two summands).

### 3.4 `_lib/project-names.ts` (pure) — Deliverable 2 project-name resolution

```ts
import type { Library } from '@/lib/schemas/entities';
/** projectId → project name, for resolving Edit.projectId to a human label. */
export function projectNameMap(library: Library | null): Record<string, string>;
```
Empty map when `library` is null. Consumers fall back to the raw `projectId` for any id not in
the map (a library edited after generation can drop an id — Risk R4).

### 3.5 `_lib/print-css.ts` (constant) — D1/D2 print styling

Export a function `printCss(opts: { screenHideRoot: boolean }): string` returning the static CSS
below (include the `@media screen` block only when `screenHideRoot` is true — true for the in-page
hidden root, false for the standalone route which shows on screen):

```css
@page { margin: 1.6cm; }
@media screen { #print-root { display: none; } }            /* only when screenHideRoot */
@media print {
  body * { visibility: hidden !important; }
  #print-root, #print-root * { visibility: visible !important; }
  #print-root {
    position: absolute; inset: 0; margin: 0; padding: 0; display: block !important;
    font-family: Georgia, 'Times New Roman', serif; color: #000; background: #fff;
  }
  #print-root a { color: #000; text-decoration: none; }
}
```
The `visibility` trick hides ancestor chrome this ticket may not edit, without selecting it by a
fragile per-element selector. `display:block` on `#print-root` in `@media print` re-shows it even
though `@media screen` set `display:none`. **Exactly one `#print-root` may exist per rendered page**
(the resume page has one, via the hub's hidden PrintView; the print route has one — never both on
one page).

### 3.6 `_components/alignment-table.tsx` (presentational; no `'use client'` needed) — Deliverable 1

Props: `{ alignment: AlignmentEntry[] }`. Renders entries grouped/colored by `status`. Four
statuses with real-text labels (color is only ever an addition — same reasoning as `status-chip.tsx`):
`present` ("Present"), `missing_in_resume` ("Missing — fixable by a rewrite"),
`missing_in_library` ("Gap — not in your library, and never written into your resume"),
`synonym_mismatch` ("Synonym mismatch"). Optional `note` shown when present.
- **Hard requirement (acceptance item 1):** this component renders **zero interactive controls**
  for ANY entry — no button, checkbox, link, or accept action anywhere, and specifically none on
  `missing_in_library` rows ("绝不写入简历"). Give each entry a stable test hook (e.g. render each
  row as an element carrying `data-status={status}`) so the test can scope "no actionable control
  within a `missing_in_library` row".

### 3.7 `_components/edit-card.tsx` (`'use client'`) — Deliverable 2

Props: `{ edit: Edit; index: number; accepted: boolean; projectName: string; onToggle: (index: number, accepted: boolean) => void }`.
- Renders `edit.original`, `edit.suggested`, `edit.rationale`, and the resolved `projectName`
  (from §3.4; parent passes `projectNameMap[edit.projectId] ?? edit.projectId`).
- Accept control is a **checkbox** (role `checkbox`) labelled "Adopt this edit", **defaulting to
  the `accepted` prop** — which the parent seeds to `false` for every edit (PRD "用户逐条采纳" =
  opt-in). `onChange` calls `onToggle(index, e.target.checked)`.
- All text rendered as text (never HTML).

### 3.8 `_components/draft-editor.tsx` (`'use client'`) — Deliverable 3

Props: `{ value: string; onChange: (next: string) => void; disabled?: boolean }`.
- A labelled `<textarea>` (label "Full draft (markdown)") bound to `value`. Free-form editing
  calls `onChange`. This is the raw-markdown editor (D3 keeps a formatted preview optional — the
  formatted view is the print-root / print route). The `deriveDraft` seeding + re-derive on toggle
  is owned by the parent hub (§3.10), not here — this component is a controlled textarea.

### 3.9 `_components/dropped-count-header.tsx` (presentational) — Deliverable 4 (module's OWN copy)

Props: `{ droppedCount: number; items: DroppedItem[] }` (NO `partial` flag — see D7).
- `droppedCount === 0` → render **nothing at all** (no wrapper, no empty `<details>`).
- `> 0` → a bold count line (singular "1 item was dropped" / plural "N items were dropped") + a
  `<details><summary>Show the dropped entries</summary>…</details>` listing each item as
  `<strong>{label}</strong> — {detail}`, rendered as TEXT.
- Mirror FIT-03's `dropped-count-header.tsx` structure and its E9 jsdom note (a closed `<details>`
  still exposes its content to Testing Library under jsdom, so tests assert `details.open`, never
  "content is invisible").

### 3.10 `_components/resume-workspace.tsx` (`'use client'`) — the stateful hub (composes D1–D4, editor, export)

The single client hub, rendered on BOTH the reload path (by `page.tsx`) and the fresh-generate
path (by `tailor-generator.tsx`). Props:
```ts
{
  jobId: string;
  tailored: TailoredResume;               // value type from @/lib/schemas/persisted
  projectNames: Record<string, string>;
  droppedItems: DroppedItem[];            // [] on reload; populated only on fresh generate
  droppedCount: number;                   // 0 on reload
}
```
State: `accepted: Set<number>` (initially empty — all edits opt-in false); `draft: string`
(initially `deriveDraft(tailored.fullDraftMd, tailored.edits, emptySet)`, i.e. `fullDraftMd`).
Behavior:
- Renders (in order): `DroppedCountHeader` (count/items from props); `AlignmentTable`
  (`tailored.alignment`); the edits section — one `EditCard` per `tailored.edits[i]` with
  `accepted={accepted.has(i)}` and `projectName={projectNames[edit.projectId] ?? edit.projectId}`;
  the D6 note; `DraftEditor` bound to `draft`; a "Print / Save as PDF" button; a link to the
  standalone print route (`/jobs/${jobId}/resume/print`, label "Open a clean print view of the
  generated draft"); `MarkAppliedButton` (`jobId`); and a **screen-hidden** `PrintView`
  (`draft={draft}`, `screenHideRoot`) that provides the `#print-root` used by `window.print()`.
- `onToggle(i, isAccepted)` → update `accepted`; then **re-derive** `draft =
  deriveDraft(tailored.fullDraftMd, tailored.edits, nextAccepted)` (D6 — overwrites manual edits;
  the note warns the user).
- The "Print / Save as PDF" button calls `window.print()`.
- No `console.*` anywhere (PII — résumé content). No storage of any draft/alignment/edit content
  in localStorage/sessionStorage/cookies/URL (PRD §8.1).

### 3.11 `_components/print-view.tsx` (`'use client'`) — shared formatted+print-styled render (D1/D2)

Props: `{ draft: string; screenHideRoot?: boolean; showPrintButton?: boolean }`.
- Renders `<style>{printCss({ screenHideRoot: !!screenHideRoot })}</style>` and
  `<div id="print-root">{renderMarkdown(draft)}</div>`.
- When `showPrintButton` (the standalone route), also render a "Print / Save as PDF" button
  (`window.print()`) and it must sit OUTSIDE `#print-root` so it is hidden in print.
- Used hidden by the hub (`screenHideRoot`, no button — the hub owns its own button) and visible
  by the print route (`showPrintButton`, not screen-hidden).

### 3.12 `_components/mark-applied-button.tsx` (`'use client'`) — Deliverable 5

Props: `{ jobId: string }`. Pattern mirrors `settings/_components/delete-account-confirm.tsx`.
- A "Mark as applied" button. On click (single-flight via a `busy`/`inFlight` guard so a
  double-click issues ONE request):
  ```ts
  await fetch(`/api/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'applied' }),   // EXACTLY this body — acceptance item 4
  });
  ```
- On 200 (D5): set a `done` state → render "Marked as applied" and disable the button (do NOT
  reload). Non-200/throw: inline `role="alert"` message per FIT-01's contract (`401` session
  expired; `404` "We could not find that job."; `400`/`500`/network → a generic retry message),
  leaving the button usable. No `console.*`.

### 3.13 `_components/tailor-generator.tsx` (`'use client'`) — Deliverable 7's "Generate Tailor" trigger

Props: `{ jobId: string; projectNames: Record<string, string> }`. Mirrors `fit-auto-runner.tsx`
error mapping, but **click-triggered** (D4), not on-mount.
- State machine: `idle` → (click) `running` → `done(report)` | `error(message, cta?)`.
- On click, single-flight (`inFlight` ref + `busy`): `fetch(`/api/jobs/${jobId}/tailor`, { method: 'POST' })`
  (NO body, NO Content-Type — the route reads none).
- Validate the 200 body defensively before rendering (defence in depth; server is the real
  boundary). Define a module-local response schema (breakdown-plan §3 — module-local Zod in own
  dir), composing pure schemas so nothing DB-touching enters the bundle:
  ```ts
  import { TailoredResume } from '@/lib/schemas/persisted';
  import { Edit } from '@/lib/schemas/pipeline';
  import { z } from 'zod';
  const TailorRunResponse = TailoredResume.extend({
    dropped: z.object({
      count: z.number(),
      edits: z.array(z.object({ item: Edit, reason: z.string() })),
      numbers: z.array(z.object({ token: z.string(), reason: z.string() })),
    }).optional(),
  });
  ```
  On parse failure → the generic error state (never a half-rendered draft).
- On success → render `<ResumeWorkspace jobId tailored={parsed} projectNames droppedItems={toDroppedItems(parsed.dropped)} droppedCount={parsed.dropped?.count ?? 0} />`.
- Error branches (branch on the `error` STRING per TLR-01's header), each an actionable
  `role="alert"` message, button stays usable:
  - `409 fit_not_ready` → "Run the Fit report for this job first, then come back to tailor your
    resume." (optionally link to the Fit tab `/jobs/${jobId}`).
  - `409 no_library` → import CTA ("Your library is empty…", link `/library`).
  - `429 quota_exceeded` → "You've used today's tailor allowance. Try again tomorrow." (never echo
    the raw `resetAt` epoch).
  - `422 tailor_failed` → "We couldn't produce a tailored draft. Try again."
  - `401` → session expired; `404` → not found; `500`/`503`/network → generic/temporarily
    unavailable.
- No `console.*`. Do not persist the response anywhere but component state.

### 3.14 `page.tsx` (server component) — Deliverable 7

```ts
export const dynamic = 'force-dynamic';
export default async function ResumePage({ params }: { params: Promise<{ id: string }> }) { … }
```
- `const { id } = await params;` (Next 15 — `params` is a Promise; a non-Promise type fails
  `next build`'s route-type check).
- `const userId = await requireUserId();` (NOT wrapped in try/catch — propagate).
- `const library = await getLibrary(userId);` `const projectNames = projectNameMap(library);`
  (getLibrary may throw on drift — do NOT catch; loud-failure policy.)
- `const tailored = await getTailoredResume(userId, id);`
- Branch:
  - `tailored === null` → `<TailorGenerator jobId={id} projectNames={projectNames} />`.
  - else → `<ResumeWorkspace jobId={id} tailored={tailored} projectNames={projectNames}
    droppedItems={[]} droppedCount={0} />` (reload path — `dropped` is not persisted, so it is
    empty here; the header renders nothing).
- Does NOT call `getJob` / `notFound()` — the parent `[id]/layout.tsx` already guards existence +
  ownership (§0). Static import of the query modules (import-safe; build-guarded by the test).

### 3.15 `print/page.tsx` (server component) — Deliverable 6 (standalone persisted print)

```ts
export const dynamic = 'force-dynamic';
export default async function ResumePrintPage({ params }: { params: Promise<{ id: string }> }) { … }
```
- `const { id } = await params;` `const userId = await requireUserId();`
- `const tailored = await getTailoredResume(userId, id);`
- `tailored === null` → render a small "No tailored draft yet — generate one first." message with
  a link back to `/jobs/${id}/resume` (do NOT `notFound()` — the job exists; the draft just does
  not).
- else → `<PrintView draft={tailored.fullDraftMd} showPrintButton />` (visible on screen; isolates
  `#print-root` in print). Include a "Back to editor" link (outside `#print-root`).
- Static import of `getTailoredResume`; build-guarded.

### 3.16 `_fixtures/tailored-fixtures.ts` (test-only) — hand-built fixtures

Mirror `app/(app)/jobs/_fixtures/job-fixtures.ts` conventions exactly: **hand-written literals
only** (NO `node:fs`, NO `@/eval` import, NO `import.meta.url` — those throw at import under jsdom);
value-import only pure schema types; type-only import for anything that would drag drizzle.
Provide:
- `TAILORED_FIXTURE: TailoredResume` — an `alignment` covering **all four** statuses (including at
  least one `missing_in_library`), 2–3 `edits` referencing project ids that exist in `LIBRARY_FIXTURE`,
  and a `fullDraftMd` that contains each edit's `original` verbatim (so `deriveDraft` has anchors to
  hit) plus markdown exercising the renderer subset (a heading, a bold span, a bullet list).
- `LIBRARY_FIXTURE: Library` — projects whose ids match the edits' `projectId`s (so project-name
  resolution has hits) plus at least one edit whose id is deliberately absent (to test the raw-id
  fallback, Risk R4).
- `tailorResponseFixture(overrides?)` — the exact 200 body: `{ ...TAILORED_FIXTURE, dropped: { count, edits, numbers } }` with at least one dropped edit and one dropped number.
- `MARKDOWN_FIXTURE: string` — a small markdown doc exercising headings, bold/italic, unordered +
  ordered lists, a link with an http URL, and a link with a `javascript:` URL (for the security
  test), plus a paragraph with an internal hard line break.

---

## 4. Test plan (each acceptance item → concrete proof)

All component tests: `// @vitest-environment jsdom` + `@testing-library/react`, `afterEach(cleanup)`,
`vi.unstubAllGlobals()`/`restoreAllMocks()`. Pure-fn tests run in the default node env. Fixtures
come from §3.16. Test files are colocated (`*.test.ts(x)`), already covered by `vitest.config.ts`.

| Acceptance item (ticket §"Acceptance checklist") | Test file | Key assertions |
|---|---|---|
| **1** `[machine]` alignment-table renders NO accept/write action for `missing_in_library` | `_components/alignment-table.test.tsx` | Render with the fixture alignment. Locate the `missing_in_library` row (via `data-status`); assert `queryByRole('button'/'checkbox'/'link')` **within that row is null**; assert the whole component renders zero of those roles. Assert the "Gap — … never written into your resume" label is present. Also assert `present`/`synonym_mismatch`/`missing_in_resume` render their labels + optional `note`. |
| **2** `[machine]` edit-card defaults to not-accepted; toggling updates parent state | `_components/edit-card.test.tsx` | Render with `accepted={false}`: the checkbox is unchecked. `fireEvent.click` the checkbox → `onToggle` called once with `(index, true)`. Render with `accepted={true}` → checked. Assert `projectName` prop is displayed. |
| **3** `[machine]` draft derivation substitutes accepted edits' original→suggested, leaves non-accepted untouched | `_lib/draft-derivation.test.ts` (node) | Hand-built `fullDraftMd` + edits. Cases: (a) accepted subset → only those replaced; (b) non-accepted `original` remains verbatim; (c) array-order compounding; (d) `original` absent → unchanged, `suggested` not inserted; (e) empty `original` → skipped; (f) `original`/`suggested` containing regex metacharacters replaced literally, first-occurrence only; (g) empty `acceptedIndices` → returns `fullDraftMd` unchanged. |
| **4** `[machine]` mark-applied-button PATCHes with exactly `{ status: 'applied' }` | `_components/mark-applied-button.test.tsx` | Stub `fetch`. Click → assert one call to `/api/jobs/<jobId>` with `method: 'PATCH'`, `headers: { 'Content-Type': 'application/json' }`, and `JSON.parse(body)` **deep-equals** `{ status: 'applied' }` (exactly one key). Double-click → exactly ONE fetch (single-flight, deferred-promise pattern from `new-job-form.test.tsx`). On 200 → "Marked as applied" shown + button disabled. 401/500 → `role="alert"`, button still usable. Privacy: no `console.log/error/warn`. |
| **5** `[machine]` dropped-count-header: nothing at 0; count + expandable list at >0 | `_components/dropped-count-header.test.tsx` | `droppedCount=0` → `container.textContent === ''` and no `<details>`. `>0` → count line (singular vs plural), a `<details>` with `.open === false` initially, `fireEvent.click(summary)` → `.open === true`, each item's label/detail text present. Model-derived content rendered as text (pass a `<script>`-looking label; assert no `<script>`/`<img>` element). |
| **6** `[machine]` `pnpm test` green | (all) | Whole suite passes. |
| **7** `[human]` printed PDF meets "可直接投递" (§13 Q2) | — | Not machine-tested (ticket Test plan). See Feedback obligation #1 escalation path. §5 R2 documents what the automated tests do and do not cover. |

**Additional tests (not acceptance items, but required for a green, cold-startable delivery):**

- `_lib/render-markdown.test.tsx` (D3 correctness + security): headings→`h1..h6`, `**`→`strong`,
  lists→`ul/ol>li`, paragraph hard-break→`br`. **Security:** `[x](javascript:alert(1))` renders no
  `<a>` (plain text "x"); `[x](https://e.com)` renders an `<a href="https://e.com">`; a
  `<script>`-looking token in the markdown never produces a `<script>` element (React escaping).
- `_lib/dropped-view.test.ts`: `toDroppedItems` maps edits (label snippet/`…`, project-id fallback
  when `original` empty) and numbers (token label) in edits-then-numbers order.
- `_lib/project-names.test.ts`: map built from library; `null` → `{}`.
- `_components/resume-workspace.test.tsx` (integration): (a) toggling an EditCard re-derives the
  textarea value per `deriveDraft`; (b) the hidden `#print-root` content reflects the CURRENT draft
  after a toggle (query `#print-root` textContent); (c) exactly one `#print-root` in the DOM; (d)
  the "Print / Save as PDF" button calls `window.print` (spy `vi.spyOn(window,'print')`); (e) the
  D6 note is present; (f) `missing_in_library` still exposes no action inside the composed tree.
- `_components/tailor-generator.test.tsx` (D4 + TLR-01 wire contract): click → exactly one POST to
  `/api/jobs/<id>/tailor` with `{ method: 'POST' }` and NO body/Content-Type; 200 → workspace
  renders (alignment + edits + dropped list from response). Each error branch (`fit_not_ready`,
  `no_library`, `quota_exceeded` without echoing `resetAt`, `tailor_failed`, `401`, `404`, `503`,
  network throw) → its `role="alert"` message; button stays usable. Double-click → one fetch.
  Privacy: no `console.*`.
- `page.test.tsx` (server; mock `@/lib/auth/session`, `@/lib/db/queries/tailored-resumes`,
  `@/lib/db/queries/library` per the `vi.hoisted` pattern in the existing `page.test.tsx`):
  (a) `getTailoredResume` null → `TailorGenerator` rendered, no workspace; (b) non-null →
  workspace rendered with alignment/edits and empty dropped header; (c) reads with the SESSION
  userId + awaited `params.id`; (d) an `UnauthorizedError` from `requireUserId` propagates and no
  query runs; (e) a THROWING `getLibrary` propagates (not swallowed); (f) `dynamic === 'force-dynamic'`;
  (g) **BUILD GUARD**: with `DATABASE_URL` unset + `vi.resetModules()` + `vi.doUnmock` the query
  modules, `import('…/resume/page')` resolves and `import('@/db/index')` rejects with `/DATABASE_URL/`
  (mirror the existing job `page.test.tsx` build-guard test verbatim in structure).
- `print/page.test.tsx` (server): null draft → the "generate one first" message + back link, no
  `#print-root`; non-null → `#print-root` present containing rendered draft; force-dynamic; build guard.

---

## 5. Risks & edge cases (Reviewer focus: concurrency + security)

- **R1 — SECURITY: markdown rendering of model-derived content (`fullDraftMd`, `edits`, alignment).**
  All rendered as React elements/text (never HTML, never `dangerouslySetInnerHTML`), so injection
  is structurally impossible EXCEPT the `[label](url)` href. The href scheme allowlist
  (`http/https/mailto` only) in `render-markdown.tsx` is the one security-sensitive line — it has a
  dedicated test (§4). `fullDraftMd` is server-number-filtered by TLR-01 but is still model output;
  treat as untrusted. This is the Reviewer's primary security check.
- **R2 — Print fidelity is a `[human]` judgment, and may legitimately fail (PRD §13 Q2).** The
  automated tests prove structure (headings/lists/bold render; chrome is isolated by `#print-root`),
  NOT visual "可直接投递" quality. A failing `[human]` check does NOT fail this ticket's own delivery
  — it triggers the Feedback-obligation-#1 escalation (record specifics in `05-tailor/README.md`
  open question #1; a NEW ticket introduces a template system). The Builder must NOT pre-emptively
  add a template engine or a markdown dependency to "pass" a check that is designed to be answerable
  only by Horace.
- **R3 — CONCURRENCY / cost: duplicate or wasted paid TAILOR calls.** The generate button is
  single-flight against double-clicks (D4). Residual, NOT fixable in this ticket and inherited from
  TLR-01 (its route header + `tailored-resumes.ts` CONCURRENCY note): two tabs can each POST and, in
  the absence of a UNIQUE constraint on `tailored_resumes.jobId`, both insert a row (newest wins on
  read). Each call charges a `tailor` unit, so the blast radius is bounded. Do NOT add client-side
  debouncing/locking as a workaround — the real fix is a DB constraint in FND-05's scope
  (docs/plans/TLR-01.md §4 R3), already escalated. Just do not introduce a NEW abuse path (e.g.
  auto-generate on mount — explicitly rejected by D4).
- **R4 — Derivation/anchor + project-name mismatch.** `deriveDraft` is a no-op for an edit whose
  `original` is absent from `fullDraftMd` (the suggested text is not inserted) — documented, and the
  edit still appears in the list (adopting it simply has no textual effect). Likewise a
  `projectId` absent from the current library falls back to the raw id. Both stem from the library
  being editable after generation; both are display/robustness concerns, not correctness bugs. Tests
  pin both.
- **R5 — StatusChip staleness after "Mark as applied" (D5).** The chip is in FIT-03's layout
  (server) and this ticket may not edit it, so it shows the old status until the next
  navigation/refresh, even though the button confirms "Marked as applied". Documented, minor;
  alternative (reload) is Q3.
- **R6 — Lost in-progress edits (ticket Feedback obligation #2).** No server round-trip and no
  storage means unsaved in-editor edits are lost on refresh/navigation-away, and the standalone
  print route (D2) shows the persisted draft, not those edits. This is the documented v1 gap; a
  real dogfood problem is a NEW ticket adding a save endpoint (touches `05-tailor`'s API surface,
  currently TLR-01-only) — log it in `05-tailor/README.md`, do NOT add localStorage-only persistence
  here.
- **R7 — Dropped list only exists at generation time.** On reload the server-rendered path has no
  `dropped` payload (not persisted), so the header renders nothing. This is the documented
  "not re-derivable on later visits" limitation (Deliverable 4) — do NOT attempt to reconstruct it
  from the clean persisted draft (impossible and misleading).
- **R8 — PII / privacy (PRD §8.1).** Résumé draft, alignment, and edits are the user's most
  sensitive data. NO `console.*` in any client component; NO localStorage/sessionStorage/cookie/URL
  persistence of draft/alignment/edit content; relative same-origin fetches only (session cookie is
  httpOnly + sameSite=lax → cross-site POST fails closed with 401, same posture as FIT-01/TLR-01).
  Tests pin the no-log behavior on the fetching components.
- **R9 — `next build` route typing.** Both pages take `params: Promise<{ id: string }>` and `await`
  it; a non-Promise type type-checks in isolation but fails `next build`'s generated route-type
  check (observed across the repo). Server pages declare `export const dynamic = 'force-dynamic'`.
- **R10 — Client-bundle safety.** Client components must not value-import `@/lib/db/queries/*`
  (drags drizzle in). Only `page.tsx`/`print/page.tsx` (server) import the query modules, statically;
  the build-guard tests pin that those page modules import cleanly with `DATABASE_URL` unset.

---

## 6. Open questions (each with an owner)

- **Q1 — Two export surfaces, or one? (owner: Horace / product.)** v1 ships both the in-page
  edit-aware `window.print()` (D1) and the standalone persisted-draft route `resume/print/page.tsx`
  (D2), because the ticket file-scope mandates the `print/page.tsx` file AND the Deliverable 6
  resolution mandates edit-aware client-side export. They print different content (current edits vs.
  persisted draft), which is a potential UX confusion the labels try to mitigate. Decide whether to
  keep both or collapse to the in-page path only (the route would then just redirect/summarize).
  Does not block delivery.
- **Q2 — Re-derive-overwrites-manual-edits vs. freeze-after-first-manual-edit (owner: Horace +
  Reviewer).** D6 takes the literal Deliverable-3 reading (toggle → re-derive → overwrite) with a
  warning note. If dogfood shows users lose hand edits by toggling late, the alternative is to stop
  re-deriving once the draft diverges from the last derived baseline. Behavioral/UX call; the pure
  `deriveDraft` function is unaffected either way.
- **Q3 — Should "Mark as applied" reload so the StatusChip updates? (owner: Horace.)** D5 confirms in
  place and leaves the layout chip stale until next navigation (R5). A `window.location.reload()` on
  success would fix the chip at the cost of a full re-render. Minor; product preference.
- **Q4 — `edits[].suggested` fabricated-number bypass at export (carried from `05-tailor/README.md`
  open question Q3; owner: Horace + this Architect pass).** TLR-01 runs `filterNumberIntegrity` only
  on `fullDraftMd`, NOT on `edit.suggested`. If a user adopts an edit whose `suggested` contains a
  fabricated number, that number enters the working draft and is **exported without re-validation**,
  because this ticket does no server round-trip and `filterNumberIntegrity` lives server-side
  (`lib/validation/**`, FND-07 scope — out of this ticket's file-scope). **This Architect pass's
  position:** do NOT silently re-implement number filtering client-side (it would duplicate FND-07
  logic in a place it does not belong and could diverge). v1 accepts the residual exposure and
  records it; the clean fix (server re-validates the final draft before export) requires a save/export
  endpoint that this ticket's Non-goals exclude — same escalation channel as R6. Flagging for Horace
  because it is a real integrity gap in the "数字永不虚构" guarantee, narrow (only user-adopted
  fabricated numbers), and a conscious v1 acceptance rather than an oversight.

---

## 7. Build/verify checklist for the Builder

- Create only files under `app/(app)/jobs/[id]/resume/**` (§3). Touch nothing else — not
  `layout.tsx`, not the tailor/jobs routes, not `lib/**`, `db/**`, `package.json`, or
  `vitest.config.ts`.
- `pnpm test` green (acceptance item 6), including the two server build-guard tests.
- `pnpm build` (`next build`) succeeds — this is the real check for the `params: Promise<…>` typing
  (R9) and for client/server boundary correctness (R10); run it before declaring done.
- Record any deviation from this plan in the ticket's Changelog/Deviations, per pipeline rules.
- Remember: AI-generated code is a draft and must be reviewed before merge; the Reviewer runs the
  full suite independently and focuses on R1 (markdown href security) and R3 (paid-call concurrency).
