---
id: PRP-04
title: Brief content UI
module: 06-prep
lane: 06-prep
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [PRP-01, PRP-02, PRP-03, FND-04, FND-05]
blocks: []
---

# PRP-04 — Brief content UI

No ADR — the decision is already made in PRD §5.4 (Brief spec) and §5.7 (产出展示 rules); this is build ticket 4 of 4 against the `06-prep` module — the last ticket in this module and the one that completes PRD §3 C4.
Parent sub-PRD: [06-prep README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [PRP-01 — RESEARCH API route](PRP-01-research-route.md), [PRP-02 — REHEARSE API route](PRP-02-rehearse-route.md), [PRP-03 — Prep tab shell](PRP-03-prep-tab-shell.md), [FND-04 — Persisted entity Zod schemas](../../01-foundation/tickets/FND-04-persisted-entity-schemas.md), [FND-05 — Drizzle schema, Neon Postgres client, and migrations](../../01-foundation/tickets/FND-05-drizzle-schema-neon.md)
**Why `builder`:** implementing UI for already-decided routes/schemas, orchestrating two sequential client calls (RESEARCH then REHEARSE) per the already-decided two-call design — no open product design.

## Background + basis

PRD §5.4: "ledger + intel + 预测问题 / askThem / positioning，MVP 已验证的四阶段 prompts 作为基线迁移." — the Brief page displays all of: the job's `Ledger` (already available on `job.ledger`, no new fetch needed), the `Intel` (RESEARCH result, may be `null`), and the `Rehearse` content (`questions[5]`, `askThem[3]`, `positioning`).

PRD §5.7 "产出展示" row: "dropped > 0 表头计数、可展开被弃条目；research fail 标红但简报照常渲染" — the "research fail 标红" clause is THIS module's own specific instance of the general dropped-count-header pattern (`04-fit`/FIT-03 built its own copy for Fit; per `docs/prd/breakdown-plan.md`'s deliberate per-module-duplication decision, this ticket builds its own, not importing FIT-03's).

PRD §4 S4: "面前按 angle 排练" (rehearse by angle before the interview) — this implies the questions should be browsable/groupable in a way useful for pre-interview review, not just a flat list; this ticket's own reasonable interpretation is grouping the 5 questions by their bound `projectId` (the "angle" a question comes from), since PRD gives no other candidate grouping dimension. Explicitly NOT a voice/interactive rehearsal feature (PRD §3: "语音 mock 面试" is V1.4, not v1) — "排练" here means structured reading/review, not interaction.

This ticket orchestrates the two-call sequence decided in `06-prep/README.md`: on first unlocked render (no persisted `Brief` yet), call `POST /api/jobs/[id]/research` (PRP-01) first, then — regardless of whether RESEARCH succeeded or degraded — call `POST /api/jobs/[id]/rehearse` (PRP-02) with the RESEARCH result as input, per PRD §2 P3's degrade-not-block principle applied at the UI orchestration level.

## Goal

Extends PRP-03's `app/(app)/jobs/[id]/prep/page.tsx` unlocked-state branch: on first visit (no `Brief` persisted for the job), triggers the RESEARCH→REHEARSE call sequence with a progress UI; once a `Brief` exists, renders it — intel (with the research-fail red flag when `intel === null`/`failed`), ledger recap, the 5 questions with traps (grouped by project/"angle"), the 3 askThem items, and positioning.

## Non-goals

- No voice/interactive rehearsal — PRD §11 V1.4, not triggered, not v1.
- No RESEARCH/REHEARSE server logic — PRP-01/PRP-02 (this ticket only calls those routes from the client).
- No changes to PRP-03's locked-state branch — this ticket only extends the unlocked branch of the same file (see PRP-03's own Feedback obligation note permitting structural extension while preserving locked-state behavior).

## File-scope (write-owns)

- `app/(app)/jobs/[id]/prep/page.tsx` (unlocked-state branch — extends PRP-03's same file, same lane, sequential, PRP-03 merged first)
- `app/(app)/jobs/[id]/prep/_components/intel-card.tsx`, `research-fail-banner.tsx`, `question-list.tsx` (grouped by projectId "angle"), `ask-them-list.tsx`, `positioning-summary.tsx`, `dropped-count-header.tsx` (this module's own copy, per `docs/prd/breakdown-plan.md`'s deliberate duplication decision — does not import `04-fit`/FIT-03's copy)
- Does not touch: `app/(app)/jobs/[id]/layout.tsx` (`04-fit`/FIT-03), `app/api/jobs/[id]/research/route.ts`/`rehearse/route.ts` (PRP-01/PRP-02, call only).
- Serial-safety: PRP-01, PRP-02, PRP-03 merged before this ticket starts (same lane, sequential) — no in-flight contention. This is the last ticket in `06-prep`.

## Deliverables

1. `app/(app)/jobs/[id]/prep/_components/research-fail-banner.tsx` — renders a red-flagged banner (PRD: "research fail 标红") when the persisted `Brief.intel` is `null`, with copy explaining company research wasn't available but the rest of the brief is unaffected — rendered ALONGSIDE the rest of the brief content, never in place of it (PRD: "简报照常渲染").
2. `app/(app)/jobs/[id]/prep/_components/intel-card.tsx` — renders `Intel.snapshot`, `recent` (each with its `soWhat`), `engineeringSignals`, `talkingPoints` when `intel` is non-null; renders nothing (the `research-fail-banner.tsx` covers the null case) when `intel` is null.
3. `app/(app)/jobs/[id]/prep/_components/question-list.tsx` — renders the 5 `RehearseQuestion`s grouped by `projectId` (the "angle" grouping per Background), each showing `question` + `trap`, with the source project's name looked up from the job's `Library` context (passed down as a prop) for readability (PRD questions are "只因该项目的具体内容才可问" — showing which project grounds each question directly supports "面前按 angle 排练").
4. `app/(app)/jobs/[id]/prep/_components/ask-them-list.tsx` — renders the 3 `askThem` items.
5. `app/(app)/jobs/[id]/prep/_components/positioning-summary.tsx` — renders `Rehearse.positioning`.
6. `app/(app)/jobs/[id]/prep/_components/dropped-count-header.tsx` — this module's own copy of the dropped-count UI pattern (PRD §5.7), rendered when `PRP-02`'s response indicated `droppedCount > 0` (this value is not persisted on `Brief` itself per FND-04's schema — it's only available in PRP-02's immediate response; this ticket must capture it client-side at generation time and is NOT able to re-derive it on a later page load of an already-generated `Brief`, since dropped items are not part of what's persisted, only what's counted-and-discarded — document this explicitly as a known limitation: the dropped-count header is only shown right after generation, not on subsequent visits to an already-generated brief).
7. `app/(app)/jobs/[id]/prep/page.tsx` (extending PRP-03's file): on unlocked render, checks whether a `Brief` already exists (`getBrief`, PRP-02's query function) — if not, renders a generation-in-progress UI that calls `POST /api/jobs/[id]/research` then (regardless of its `failed` flag) `POST /api/jobs/[id]/rehearse` with the research result, then re-renders with the persisted `Brief`; if a `Brief` already exists, renders Deliverables 1–5 directly against it (no re-generation — REHEARSE is not re-triggered automatically on every visit, only once per job, matching `05-tailor`/TLR-01's "re-runnable but not auto-rerun" pattern, though this ticket does not add an explicit user-facing "regenerate" button since PRD names no such action for Prep specifically — flagged as a scope boundary, not an oversight).

## Acceptance checklist (classified)

- [ ] `[machine]` On first unlocked render with no persisted `Brief`, the page calls `POST /api/jobs/[id]/research` before `POST /api/jobs/[id]/rehearse` (mocked fetch, assert call order).
- [ ] `[machine]` When RESEARCH's mocked response is `{ intel: null, failed: true }`, REHEARSE is still called (with `{ intel: null }` in its body) — direct proof of the degrade-not-block orchestration.
- [ ] `[machine]` `research-fail-banner.tsx` renders when `Brief.intel === null`, and the rest of the brief content (questions/askThem/positioning) renders alongside it, not instead of it — component test asserting both are present in the same render.
- [ ] `[machine]` `question-list.tsx` groups a mocked 5-question `Rehearse` fixture by `projectId` correctly (e.g. 5 questions spanning 3 distinct projects render under 3 group headers).
- [ ] `[machine]` On a SECOND render of an already-generated `Brief` (mocked `getBrief` returning existing data), the page does NOT call `POST /api/jobs/[id]/research`/`rehearse` again (mocked fetch, assert zero calls).
- [ ] `[machine]` `pnpm test` green.
- [ ] `[human]` Horace's dogfood pass (P4 milestone, "一个真实 job 全漏斗走通") includes generating and reviewing a real Brief end to end — the milestone's own `[human]` acceptance item, not separately re-asserted here beyond this ticket's own machine checks.

## Test plan

Component/integration tests using the `@testing-library/react` setup, with mocked `fetch` for `/api/jobs/[id]/research` and `/api/jobs/[id]/rehearse`, and hand-built `Brief`/`Job`/`Library` fixtures matching FND-03/FND-04's schemas. The call-order and degrade-orchestration tests are the most load-bearing — they directly prove PRD §2 P3's principle is honored at the UI layer, not just the API layer (PRP-01/PRP-02 already prove it at the API layer independently).

## Feedback obligation

1. General rule: the "no re-generate button" scope boundary (Deliverable 7's closing note) is a judgment call, not a PRD requirement — if Horace's dogfood pass finds it's needed (e.g. wanting to regenerate REHEARSE after the library gains a new project), that's a legitimate small follow-up, but it changes this ticket's stated non-goal — log it as a new item in `06-prep/README.md`'s open questions or decisions table before adding a regenerate action, rather than silently expanding scope.
2. The dropped-count-header's "only shown right after generation, not on later visits" limitation (Deliverable 6) is a direct consequence of `droppedCount` not being part of the persisted `Brief` schema (FND-04) — if this is judged unacceptable (PRD §5.7's dropped-count requirement doesn't explicitly say "only at generation time"), the fix is adding a `droppedCount` field to `Brief` (a foundation-schema change, FND-04's file) — escalate rather than working around it with client-side-only state that disappears on refresh, since that would silently under-deliver PRD §5.7's transparency requirement on every subsequent visit.
3. The "angle" grouping choice (by `projectId`, Deliverable 3) is this ticket's own interpretation of PRD's "按 angle 排练" phrase (no PRD-given definition of "angle") — if Horace's dogfood pass finds a different grouping more useful (e.g. by question difficulty, or by requirement category), that's a UI iteration, log it in `06-prep/README.md`'s changelog, no re-scope needed since it doesn't touch any API contract.
