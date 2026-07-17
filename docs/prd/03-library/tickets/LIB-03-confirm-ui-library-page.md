---
id: LIB-03
title: Draft confirm UI and Library page
module: 03-library
lane: 03-library
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [LIB-02]
blocks: []
---

# LIB-03 — Draft confirm UI and Library page

No ADR — the decision is already made in PRD §4 S1, §5.7 (Library page rules); this is build ticket 3 of 3 against the `03-library` module.
Parent sub-PRD: [03-library README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [LIB-02 — Library and resume persistence API and query helpers](LIB-02-persistence-api.md)
**Why `builder`:** implementing UI for an already-decided draft-confirm flow and empty-metrics display rule — no open product design.

## Background + basis

PRD §4 S1: "上传简历 PDF → 约 30s 得到 markdown 全文 + 结构化草稿库（项目、技术栈、真实数字）→ **逐条确认/微调** → 库建成." — "逐条确认/微调" (confirm/tweak item by item) is the load-bearing UX requirement: the confirm step must let the user review and edit individual projects before they become the library, not just an "accept all or reject all" binary.

PRD §5.7 Library row, quoted verbatim: "Library | 导入后草稿确认流；项目无 metrics 时页顶红字盘点 + 卡片级警告（P2 界面化）". Two distinct UI elements required: (a) a page-top red banner tallying how many projects have no metrics ("页顶红字盘点"), and (b) a per-card warning on each metrics-less project ("卡片级警告") — both, not either/or.

PRD §5.6: "空数组是合法且被显式展示的状态" — the empty-metrics state is not an error state to be hidden or auto-fixed; it is a first-class, always-visible display state.

PRD §5 S5 ("复利"): "库每补一个真实数字、每加一个项目，所有未来的 fit / tailor / brief 上限同时抬升" — the Library page is not a one-time onboarding screen; it must support ongoing editing (add/edit/remove projects) after the initial import, since the library keeps growing over the product's lifetime.

LIB-01 returns `{ resumeMd, draftLibrary }` together; LIB-02's `POST /api/library` now (per that ticket's own correction before Gate 1) accepts and persists `{ library, resumeMd }` together in one transaction — this ticket's confirm flow must carry `resumeMd` through unmodified from PARSE to the confirm submission, alongside whatever edits the user makes to `draftLibrary`. The user does not edit `resumeMd` directly in v1 (no PRD-named UI action for that); it passes through as-is.

## Goal

`app/(app)/library/**` — an upload/paste entry point calling LIB-01's PARSE route, a per-project confirm/edit flow calling LIB-02's persistence API on save (submitting both the edited `Library` and the pass-through `resumeMd`), and a Library page displaying the confirmed library with the two required empty-metrics UI elements, plus ongoing add/edit/remove capability for individual projects.

## Non-goals

- No new API routes — this ticket only calls LIB-01 (`POST /api/parse`) and LIB-02 (`GET`/`POST /api/library`); no new server-side code beyond what's needed to render/submit against those two existing routes.
- No Jobs-list "no library" gating UI — that's `04-fit`/FIT-03's page, which calls LIB-02's `hasLibrary()` server-side; this ticket does not touch any `app/(app)/jobs/**` path.
- No AI-driven "guided library enrichment" (follow-up questions to deepen projects) — PRD §11 V1.5, not triggered, not v1.
- No UI for editing `resumeMd` directly — it passes through from PARSE to confirmation unmodified (Background); no PRD-named user action edits it.

## File-scope (write-owns)

- `app/(app)/library/page.tsx` (Library page: display + entry point to import/edit)
- `app/(app)/library/_components/**` (upload form, per-project confirm/edit card, empty-metrics banner, empty-metrics card warning)
- `app/(app)/library/library.test.tsx` (or colocated `*.test.tsx` files per component)
- Does not touch: `app/api/parse/route.ts` (LIB-01), `app/api/library/route.ts`/`lib/db/queries/library.ts` (LIB-02), any `app/(app)/jobs/**` path (`04-fit`).
- Serial-safety: LIB-02 merged before this ticket starts (same lane, sequential) — no in-flight contention.

## Deliverables

1. `app/(app)/library/_components/upload-form.tsx` — client component accepting a PDF file, a DOCX file, or a pasted-text textarea; on submit, calls `POST /api/parse` (LIB-01), shows a progress state (PRD §5.1: "延迟预算…全程 streaming 展示进度" — this is Fit/Tailor/Prep's streaming requirement per §5.1's own delay-budget table which only names Fit/Tailor/Prep, not Parse explicitly; for PARSE, a simple loading spinner suffices since PRD does not name a PARSE-specific streaming requirement — document this as a deliberate, narrower interpretation, not an oversight), and on `suggestPaste: true` error response (LIB-01), switches the UI to the plain-text-paste mode per PRD §5.1's PARSE failure policy ("解析失败 → 引导粘贴纯文本").
2. `app/(app)/library/_components/draft-confirm.tsx` — renders the `draftLibrary` returned by PARSE as a list of editable project cards (name, stage, role, stack, summary, metrics, tags all editable inline; per-project remove button; an "add project" affordance for manually adding one not captured by parsing, matching PRD §3 C1: "手工填写只是补充与深化"), holds the PARSE response's `resumeMd` in component state unmodified, and on "Confirm and save" calls `POST /api/library` (LIB-02) with `{ library: <possibly edited Library>, resumeMd: <pass-through from PARSE> }`.
3. `app/(app)/library/_components/empty-metrics-banner.tsx` — page-top banner, red/warning-styled, rendered when `library.projects.some(p => p.metrics.length === 0)`, text tallying the count (e.g. "3 of 7 projects have no metrics — add real numbers to strengthen Fit and Tailor evidence"). Rendered on the confirmed Library page (not the draft-confirm step, though the same undelying check applies there too if useful — this ticket's minimum bar is the confirmed page per PRD §5.7's literal placement in the "Library" row, not the draft-confirm row).
4. `app/(app)/library/_components/project-card.tsx` — per-project display card; when `project.metrics.length === 0`, renders an inline warning badge/text on that specific card (PRD's "卡片级警告"), distinct from and in addition to the page-top banner.
5. `app/(app)/library/page.tsx` — server component: `requireUserId()` (via the already-established Auth.js session helper from FND-08, used the same way every other authenticated page in this repo uses it), calls `GET /api/library`-equivalent server-side query (LIB-02's `getLibrary`/`getResume`); if `library` is `null`, renders the upload/paste entry point (Deliverable 1 → 2 flow); if present, renders the confirmed Library page (banner + project cards, Deliverables 3–4) with per-project edit/remove wired back through `POST /api/library` (re-submitting the full edited `Library` alongside the unchanged persisted `resumeMd`, per LIB-02's whole-object-upsert design).

## Acceptance checklist (classified)

- [ ] `[machine]` `draft-confirm.tsx` renders one editable card per project in a mocked `draftLibrary` response, and the "Confirm and save" action submits the (possibly user-edited) `library` object PLUS the unmodified `resumeMd` to a mocked `POST /api/library` — component/integration test asserting the submitted payload reflects an in-test edit to `library` while `resumeMd` matches the original PARSE response byte-for-byte.
- [ ] `[machine]` `empty-metrics-banner.tsx` renders when at least one project has `metrics: []` and does NOT render when all projects have non-empty `metrics` — two component tests, directly covering PRD §5.7's "项目无 metrics 时页顶红字盘点" rule.
- [ ] `[machine]` `project-card.tsx` renders its per-card warning exactly on cards whose `metrics.length === 0`, verified against a mixed-metrics fixture library (some cards with, some without) — component test asserting the warning appears on the correct subset only.
- [ ] `[machine]` Submitting the plain-text-paste fallback after a mocked `suggestPaste: true` response from `/api/parse` shows the paste UI (not a generic error page) — component test.
- [ ] `[machine]` `pnpm test` green.
- [ ] `[human]` Horace visually confirms the empty-metrics banner/card styling is legible and appropriately "red-flag" (PRD's "红字" is a specific visual instruction; automated tests confirm presence/absence, not color/contrast quality) as part of the P1 milestone's dogfood pass.

## Test plan

Component tests using the same `@testing-library/react`-based setup established in `01-foundation`/FND-09, mocking `fetch`/the route handlers (`/api/parse`, `/api/library`) rather than hitting real routes — reproducible offline, no DB/API needed. Use `02-evaluation`/EVL-01's resume fixtures' expected draft shapes (or a hand-built equivalent matching FND-02's `Library` schema, paired with the fixture's raw text as the mocked `resumeMd`) as the mocked PARSE response, exercising the same "at least one metrics-less project" property called out in EVL-01's Deliverable 5 so this ticket's empty-metrics tests are grounded in the actual fixture corpus rather than an ad hoc test-only object.

## Feedback obligation

1. General rule: if the "confirm/edit is a single whole-object submit" design (inherited from LIB-02's Non-goals) proves too coarse once real editing UX is built (e.g. losing in-progress edits to one project if another project's field has a validation error), that is friction discovered here, not a LIB-02 bug — but since fixing it well might mean LIB-02 needs granular endpoints after all, escalate that specific finding back to `03-library/README.md`'s decisions table (version +0.1) rather than building a workaround purely in this ticket's UI state management that papers over a server-side design gap.
2. The empty-metrics banner's exact tally wording/styling is this ticket's own reasonable interpretation of "红字盘点" (PRD gives the intent, not exact copy) — if Horace's dogfood pass (the `[human]` acceptance item) finds it insufficiently prominent or the wrong tone, that is a content/design note, not a re-scope — fix directly in this ticket's components, no escalation needed, but do log the change in `03-library/README.md`'s changelog since it's a user-facing decision worth a paper trail per PRD §4's dogfood-driven product-decision stance ("产品分歧以画像与数据裁决，不以个人偏好裁决" — note that Horace-as-dogfood-user IS the target persona per PRD §4, so his direct feedback here is exactly the intended decision mechanism, not a shortcut around it).
3. If a future ticket adds a way to re-import/re-parse a resume for an existing library (not currently in scope — this ticket's upload flow only handles the first-time-empty-library case per Deliverable 5's branch on `library === null`), that ticket must decide how re-import interacts with `resumeMd` overwrite semantics (LIB-02's `upsertResume` already supports overwrite) — flag as a new open question in `03-library/README.md` rather than assuming this ticket's single-branch flow silently covers it.
