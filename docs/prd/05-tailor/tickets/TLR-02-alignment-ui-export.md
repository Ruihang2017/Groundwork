---
id: TLR-02
title: Alignment/edits review UI, full-draft editor, and export
module: 05-tailor
lane: 05-tailor
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [TLR-01, FIT-01]
blocks: []
---

# TLR-02 — Alignment/edits review UI, full-draft editor, and export

No ADR — the decision is already made in PRD §5.3 (对齐表/edits/导出 spec) and §5.7; this is build ticket 2 of 2 against the `05-tailor` module — the one whose `[human]` acceptance item is PRD §13 Q2's open export-fidelity question.
Parent sub-PRD: [05-tailor README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [TLR-01 — TAILOR API route](TLR-01-tailor-route.md), [FIT-01 — Job creation and lifecycle status route](../../04-fit/tickets/FIT-01-job-creation-status-route.md)
**Why `builder`:** implementing UI for an already-decided TAILOR route/schema and an already-specified alignment/edits/export interaction model — no open product design beyond the export-fidelity question PRD itself flags as unresolved (§13 Q2).

## Background + basis

PRD §5.3, quoted verbatim (the sections this ticket implements): "**关键词对齐表**：JD 关键词 → 简历中 present / missing / 同义失配（如 'K8s' vs 'Kubernetes'）。missing 区分两类：库里有、简历没写 → 改写解决；库里也没有 → 显示为 gap，绝不写入简历。**逐条 edits**：`{原文, 建议改写, 理由, 来源 projectId}`，用户逐条采纳，不是黑盒整篇替换。**全文草稿**：markdown 就地编辑；导出 = 打印友好页 → 浏览器打印 PDF（模板系统进 roadmap）。"

The "用户逐条采纳，不是黑盒整篇替换" (user adopts edit-by-edit, not a blackbox full-text replacement) clause is the core interaction model: each `Edit` from TLR-01's response must be individually accept/reject-able, and only accepted edits apply to the working draft the user then exports — NOT an all-or-nothing swap to the model's `fullDraftMd`. This means `fullDraftMd` (TLR-01's output) is a STARTING SUGGESTION the user edits down from, not the literal final export by default.

PRD §5.7 "产出展示" row: "dropped > 0 表头计数、可展开被弃条目" — this module's own copy of the dropped-count UI pattern (per `docs/prd/breakdown-plan.md`'s deliberate per-module duplication decision, not imported from `04-fit`/FIT-03).

PRD §13 Q2: "导出保真：打印 CSS 能否达到'可直接投递'观感？P3 实测，不行则提前引入模板。" — this is an EXPLICITLY UNRESOLVED PRD question this ticket's export feature directly bears on; per `05-tailor/README.md`'s decision, this ticket ships the print-CSS approach (no template engine) and the "可直接投递" judgment is a `[human]` acceptance item, not something this ticket can self-certify as met.

`04-fit/README.md`'s decision (carried here): `job.status` transitions to `'applied'` via a manual button this ticket provides, calling `04-fit`/FIT-01's already-built generic status PATCH route — no new API route.

## Goal

`app/(app)/jobs/[id]/resume/**` — a page rendering TLR-01's `Alignment` table and `Edit[]` list (each individually accept/reject-able), a markdown editor seeded from the accepted edits applied to `fullDraftMd`, a print-optimized export view, and a "Mark as applied" button.

## Non-goals

- No template engine / non-print-CSS export mechanism — that is the fallback PRD §13 Q2 names IF print CSS is found insufficient; this ticket does not build it preemptively (see `05-tailor/README.md`'s Non-goals).
- No new API routes — calls TLR-01 (`POST /api/jobs/[id]/tailor`) and `04-fit`/FIT-01's existing `PATCH /api/jobs/[id]`.
- No `closed`-status UI — per `04-fit/README.md`'s decision, not implemented in v1.
- No Cover-letter generation — PRD §11 V1.2, not triggered.

## File-scope (write-owns)

- `app/(app)/jobs/[id]/resume/page.tsx` (alignment table + edits review + markdown editor)
- `app/(app)/jobs/[id]/resume/print/page.tsx` (print-optimized view, `@media print` CSS)
- `app/(app)/jobs/[id]/resume/_components/**` (alignment-table.tsx, edit-card.tsx, draft-editor.tsx, dropped-count-header.tsx [this module's own copy], mark-applied-button.tsx)
- Does not touch: `app/api/jobs/[id]/tailor/route.ts` (TLR-01, call only), `app/api/jobs/[id]/route.ts` (FIT-01, call only), `app/(app)/jobs/[id]/layout.tsx` (`04-fit`/FIT-03).
- Serial-safety: TLR-01 merged before this ticket starts (same lane, sequential); FIT-01 merged as part of `04-fit`'s full delivery before `05-tailor` began — no in-flight contention.

## Deliverables

1. `app/(app)/jobs/[id]/resume/_components/alignment-table.tsx` — renders `TailoredResume.alignment` (FND-03's `AlignmentEntry[]`), grouped/colored by status (`present` / `missing_in_resume` / `missing_in_library` / `synonym_mismatch`), with `missing_in_library` entries visually distinguished as "gap — not written into your resume" per PRD's "库里也没有 → 显示为 gap，绝不写入简历" (this ticket must NOT offer any UI action that writes a `missing_in_library` keyword into the draft — there is no accept action for these, only display).
2. `app/(app)/jobs/[id]/resume/_components/edit-card.tsx` — renders one `Edit` (`{original, suggested, rationale, projectId}`) with the source project name (resolved from the job's `Library` context) and an accept/reject toggle, defaulting to NOT accepted (per PRD's "用户逐条采纳" — opt-in per edit, not opt-out).
3. `app/(app)/jobs/[id]/resume/_components/draft-editor.tsx` — an in-place markdown editor (textarea or a lightweight markdown editor component) whose initial content is computed by applying only the currently-ACCEPTED edits' `suggested` text in place of their `original` text within `fullDraftMd` (a client-side find/replace derivation, recomputed whenever the user toggles an edit's accept state), further freely editable by the user afterward (PRD: "markdown 就地编辑").
4. `app/(app)/jobs/[id]/resume/_components/dropped-count-header.tsx` — this module's own copy (per Background) rendering TLR-01's `droppedCount` when `> 0`, with an expandable list of dropped items (same pattern as `04-fit`/FIT-03's and `06-prep`/PRP-04's own copies — captured client-side at generation time, same "not re-derivable on later visits" limitation as PRP-04's copy, documented here identically).
5. `app/(app)/jobs/[id]/resume/_components/mark-applied-button.tsx` — calls `PATCH /api/jobs/[id]` (FIT-01) with `{ status: 'applied' }`, per `04-fit/README.md`'s decision that this is a manual, TLR-02-owned trigger.
6. `app/(app)/jobs/[id]/resume/print/page.tsx` — a print-optimized rendering of the current draft content (the same text the editor holds — this page reads the persisted `TailoredResume.fullDraftMd` plus any client-side edits are expected to be saved back via a `PATCH`-style re-submission before printing, OR this ticket accepts the simpler v1 scope of printing the server-persisted draft as-is, without a client-side unsaved-edits carry-through mechanism — resolve as: this ticket does NOT persist user in-editor edits back to the server at all in v1 [TLR-01's `upsertTailoredResume` is only ever called by TLR-01's own route, not by this UI ticket], so the print/export view operates on whatever is currently in the client-side editor state at the moment of printing, within the same browser session — no server round-trip needed for export, matching PRD's "markdown 就地编辑…导出 = 打印友好页 → 浏览器打印 PDF" as a client-side-only editing-then-printing flow), styled with `@media print` CSS rules aiming for a clean, resume-like printed page (margins, font, no navigation chrome).
7. `app/(app)/jobs/[id]/resume/page.tsx` — server component: `requireUserId()`, `getJob`/`getTailoredResume` (FIT-01/TLR-01's query functions) — if no `TailoredResume` exists yet, renders a "Generate Tailor" trigger calling `POST /api/jobs/[id]/tailor` (TLR-01); once it exists, renders Deliverables 1–5 plus a link to the print view (Deliverable 6).

## Acceptance checklist (classified)

- [ ] `[machine]` `alignment-table.tsx` renders no accept/write action for `missing_in_library` entries (component test asserting no actionable control is present on that entry type — direct proof of "绝不写入简历").
- [ ] `[machine]` `edit-card.tsx` defaults to not-accepted, and toggling it updates a callback/state the parent uses (component test).
- [ ] `[machine]` `draft-editor.tsx`'s initial content, given a `fullDraftMd` and a set of accepted edits, correctly substitutes each accepted edit's `original` text with its `suggested` text and leaves non-accepted edits' original text untouched — unit test on the derivation function with a hand-built `fullDraftMd` + edits fixture.
- [ ] `[machine]` `mark-applied-button.tsx` calls `PATCH /api/jobs/[id]` with exactly `{ status: 'applied' }` (mocked fetch, assert call args).
- [ ] `[machine]` `dropped-count-header.tsx` renders nothing when `droppedCount === 0` and the count + expandable list when `> 0` (same pattern as the other two modules' copies).
- [ ] `[machine]` `pnpm test` green.
- [ ] `[human]` Horace evaluates the printed/exported PDF against PRD §13 Q2's "可直接投递" bar (this is the concrete P3 milestone exit-criterion check; a `false`/insufficient result does not fail this ticket's OWN delivery but DOES trigger the PRD §13 Q2 escalation path — filing the finding back to `05-tailor/README.md`'s open question #1 rather than this ticket silently attempting a template-engine workaround).

## Test plan

Component tests using the `@testing-library/react` setup, with hand-built `TailoredResume`/`Job`/`Library` fixtures matching FND-03/FND-04's schemas. The `draft-editor.tsx` substitution-derivation test is the most load-bearing unit test (pure function, exhaustively testable offline with string fixtures). Print CSS itself is not unit-testable in a meaningful way (a `[human]` visual judgment, per the acceptance checklist) — no automated visual-regression tooling is introduced for this, since PRD names no such requirement and it would be new infrastructure beyond this ticket's scope.

## Feedback obligation

1. General rule: if PRD §13 Q2's `[human]` check finds print CSS insufficient, the escalation path is: record the finding in `05-tailor/README.md`'s open question #1 with specifics (what looked wrong — margins, page breaks, font rendering, etc.), then a NEW ticket (not a silent extension of this one) introduces a template system, per PRD's own stated fallback ("不行则提前引入模板") — this ticket does not attempt that fallback itself.
2. The "no server round-trip for in-editor edits" scope decision (Deliverable 6) means a user's in-progress unsaved edits are lost on page refresh/navigation-away — this is a real UX gap PRD does not address explicitly (PRD says "就地编辑" without specifying persistence semantics for edits-in-progress) — if this proves to be a real problem in Horace's dogfood pass, that is a legitimate follow-up (e.g. autosave via a debounced `PATCH`-equivalent), but it requires a NEW ticket adding a save endpoint (touching `05-tailor`'s API surface, currently owned solely by TLR-01) — log it as a new open question in `05-tailor/README.md` rather than silently adding local-storage-only persistence as an undocumented workaround.
3. The dropped-count-header duplication (Deliverable 4) follows the same deliberate-simplicity decision recorded in `docs/prd/breakdown-plan.md` as `04-fit`/FIT-03's and `06-prep`/PRP-04's copies — same escalation path if it becomes a real maintenance problem (raise in `docs/prd/breakdown-plan.md` §6, don't unilaterally refactor across modules).
