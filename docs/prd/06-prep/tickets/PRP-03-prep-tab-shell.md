---
id: PRP-03
title: Prep tab shell (lock/unlock UI)
module: 06-prep
lane: 06-prep
size: S
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FIT-01]
blocks: [PRP-04]
---

# PRP-03 — Prep tab shell (lock/unlock UI)

No ADR — the decision is already made in PRD §5.4 (unlock condition) and §5.7 (Prep locked pre-interviewing); this is build ticket 3 of 4 against the `06-prep` module.
Parent sub-PRD: [06-prep README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FIT-01 — Job creation and lifecycle status route](../../04-fit/tickets/FIT-01-job-creation-status-route.md)
**Why `builder`:** implementing a locked/unlocked UI branch and a status-transition button against an already-built API route — no open design.

## Background + basis

PRD §5.7 Job 详情 row: "Fit / Resume / Prep 三段推进；Prep 在 interviewing 前锁定（文案：'拿到面邀后解锁'）". PRD §5.4: "解锁条件：`job.status = interviewing`（用户点击'我拿到面试了'）——这是 P4 的门。"

This ticket creates the WHOLE `app/(app)/jobs/[id]/prep/page.tsx` file's locked-state branch AND the "我拿到面试了" (I got the interview) button that calls `04-fit`/FIT-01's existing generic status PATCH route — per `06-prep/README.md`'s decision, this avoids any edit to `04-fit`/FIT-03's shared `layout.tsx` (which only needs to read `job.status` to grey out the Prep tab link, already covered by FIT-03's own ticket). PRP-04 (later, same module) extends this SAME file's unlocked-state branch with the actual brief content — a same-lane, sequential, same-file edit, explicitly permitted (see File-scope).

## Goal

`app/(app)/jobs/[id]/prep/page.tsx` — server component rendering EITHER a locked state (job status not `interviewing`: the exact PRD copy "unlocks after you get an interview" plus a button to mark the job as `interviewing`) OR (once PRP-04 extends this file) the unlocked brief content.

## Non-goals

- No RESEARCH/REHEARSE calls — PRP-01/PRP-02 (this ticket's locked-state branch makes no API calls beyond the status-transition PATCH; the unlocked-state branch that triggers RESEARCH/REHEARSE is PRP-04's addition to this same file).
- No `layout.tsx` edits — `04-fit`/FIT-03 already reads `job.status` to grey out the Prep nav link; this ticket does not touch that file.
- No new API routes — reuses FIT-01's existing `PATCH /api/jobs/[id]`.

## File-scope (write-owns)

- `app/(app)/jobs/[id]/prep/page.tsx` (locked-state branch only, in this ticket; PRP-04 extends the same file's unlocked branch next, same lane, sequential)
- `app/(app)/jobs/[id]/prep/_components/lock-screen.tsx`, `status-transition-button.tsx`
- `app/(app)/jobs/[id]/prep/prep.test.tsx` (or colocated test files)
- Does not touch: `app/(app)/jobs/[id]/layout.tsx` (`04-fit`/FIT-03), `app/api/jobs/[id]/research/route.ts`/`rehearse/route.ts` (PRP-01/PRP-02, call only, not in this ticket).
- Serial-safety: `04-fit` (all tickets) fully merged before this ticket starts; PRP-01/PRP-02 may be building in parallel within the same lane per the module's own ticket order (PRP-03's `blocked_by` is only `FIT-01`, not PRP-01/PRP-02) — but since `run-milestone` executes this module's tickets serially in file-name order (`docs/prd/breakdown-plan.md` §4's serial-lane rule), PRP-03 in practice runs after PRP-01/PRP-02 are already merged, even though it has no CODE dependency on them; this ticket does not import anything from PRP-01/PRP-02's files regardless.

## Deliverables

1. `app/(app)/jobs/[id]/prep/_components/lock-screen.tsx` — renders the exact PRD-intent copy (English, per §5.8 "UI 英文"): "Prep unlocks after you get an interview." plus the `status-transition-button.tsx`.
2. `app/(app)/jobs/[id]/prep/_components/status-transition-button.tsx` — client component, "I got the interview" button calling `PATCH /api/jobs/[id]` (FIT-01) with `{ status: 'interviewing' }`, then refreshing the page/route (Next.js router refresh) so the now-unlocked branch renders.
3. `app/(app)/jobs/[id]/prep/page.tsx` — server component: `requireUserId()`, `getJob(userId, id)` (FIT-01) — `notFound()` if absent; if `job.status !== 'interviewing'`, render `lock-screen.tsx`; else render a placeholder unlocked-state marker (e.g. a clearly-commented `{/* PRP-04 replaces this with real brief content */}` block) that PRP-04 replaces — this ticket does NOT call RESEARCH/REHEARSE at all, even in the unlocked branch (that's PRP-04's job).

## Acceptance checklist (classified)

- [ ] `[machine]` `prep/page.tsx` renders `lock-screen.tsx` for a job fixture with `status: 'screening'`/`'applied'`, and the placeholder unlocked marker for `status: 'interviewing'` — two component tests.
- [ ] `[machine]` Clicking `status-transition-button.tsx` calls `PATCH /api/jobs/[id]` with exactly `{ status: 'interviewing' }` (mocked fetch, assert call args).
- [ ] `[machine]` `pnpm test` green.
- No `[fixture]`/`[human]` criteria — pure UI-state logic, fully machine-checkable.

## Test plan

Component tests using the `@testing-library/react` setup (FND-09), with hand-built `Job` fixtures at each status. Mocked `fetch` for the status-transition button's PATCH call — no real API/DB access needed.

## Feedback obligation

1. General rule: if PRD's exact unlock-copy wording ("拿到面邀后解锁") needs a closer English translation than this ticket's Deliverable 1 choice, that is a content/i18n-tone fix inside this ticket, logged in `06-prep/README.md`'s changelog — no re-scope needed.
2. This ticket and PRP-04 share one file (`app/(app)/jobs/[id]/prep/page.tsx`) by design (Background) — if PRP-04's Builder finds this ticket's placeholder marker insufficiently structured to extend cleanly (e.g. the locked/unlocked branching logic needs restructuring to accommodate real data fetching), PRP-04 may refactor this file's internal structure freely (same-lane, sequential, no cross-module conflict) but must preserve this ticket's locked-state behavior exactly (the acceptance criteria above must still pass after PRP-04's changes) — regression-test them, don't just trust the refactor.

## Changelog

- v0.1 (2026-07-24, Builder writeback): implemented against `docs/plans/PRP-03.md`. Three new source files + three new test files, all under this ticket's write-scope — `app/(app)/jobs/[id]/prep/page.tsx` (+ `page.test.tsx`), `app/(app)/jobs/[id]/prep/_components/lock-screen.tsx` (+ `lock-screen.test.tsx`), `app/(app)/jobs/[id]/prep/_components/status-transition-button.tsx` (+ `status-transition-button.test.tsx`). No new API route, no server-side change, no new dependency, no migration. `layout.tsx`, `job-tabs.tsx` (04-fit/FIT-03), the RESEARCH/REHEARSE routes (PRP-01/PRP-02), and every file outside `app/(app)/jobs/[id]/prep/**` left untouched. Only other file changed: this Changelog.

  ### Decisions flagged for the Reviewer (plan §2, §5)

  - **`useRouter().refresh()` on the 200 path — the repo's FIRST `useRouter` use (plan §2.3 / Q1 / R3).** The ticket names "Next.js router refresh"; `router.refresh()` (App Router, imported from `next/navigation`) re-fetches the current route's server components in place — re-running `page.tsx`'s status branch AND `layout.tsx`'s tab nav — without a full document reload or losing client state. Rejected alternative: `window.location.reload()` / a full navigation (the `new-job-form.tsx` precedent) — heavier UX (full document load, visible flash) and not what the ticket asked for. Trivially reversible (one-line swap) if the Reviewer/Horace prefers the `window.location` precedent. Both the button test and the page test mock `next/navigation`'s `useRouter` (without a mounted App Router provider the real hook throws "invariant expected app router to be mounted").
  - **The lock screen owns its own copy — it does NOT import `PREP_LOCKED_COPY` from FIT-03's `job-tabs.tsx` (plan §2.2 / §5 Q3).** The two strings serve different UI contexts (a terse inline tab hint vs. a full-page locked state with a call-to-action), importing a constant from a 04-fit component would couple 06-prep to another module's UI internals (the cross-module coupling `breakdown-plan.md` §3 avoids), and exporting `PREP_UNLOCK_COPY` locally lets the test assert the copy without a driftable literal.
  - **The `status !== 'interviewing'` branch in `page.tsx` IS the page-level lock `job-tabs.tsx` promises (plan S2 / R4).** The tab-nav lock is only a UX hint (typing the URL bypasses it); this page-level check is what actually withholds the unlocked branch — which PRP-04 will wire to paid RESEARCH/REHEARSE calls — from any non-`interviewing` job. Test 3 (`status: 'closed'` locks) proves the branch is `!== 'interviewing'`, not a `screening`-only whitelist.

  ### Wording choices (Feedback obligation #1)

  - Lock copy: **"Prep unlocks after you get an interview."** and button label **"I got the interview"** — the plan's suggested English for PRD §5.4/§5.7's "拿到面邀后解锁" / "我拿到面试了" (§5.8 "UI 英文"). No i18n-tone refinement was made, so `06-prep/README.md`'s Changelog is deliberately **not** touched (Feedback obligation #1 only requires a README line if the wording is refined beyond the plan).

  ### Deviations from the plan

  - **Page test `next/navigation` mock also stubs `useRouter`.** Plan §3's literal snippet mocks `next/navigation` as `{ notFound: mockNotFound }` only. But the locked-branch render (`<LockScreen>` → `<StatusTransitionButton>`) calls `useRouter()` at render, which throws without the mock (the same R3 reason the plan already gives for the lock-screen test). The mock was extended to `{ notFound, useRouter: () => ({ refresh: vi.fn() }) }`. No behavior change — a necessary test-harness detail the plan's page-test snippet omitted. Everything else was built as planned.

  ### Test results

  New tests: **21 across 3 files** (`page.test.tsx` 11, `status-transition-button.test.tsx` 8, `lock-screen.test.tsx` 2). Full suite `corepack pnpm test`: **95 files / 1195 tests green** (≥ the plan's documented baseline of 80 files / 1087 tests; the delta above baseline is PRP-01/PRP-02 and other already-merged tickets landed since v0.3, plus this ticket's 3 files / 21 tests). `corepack pnpm lint`: clean. `corepack pnpm build` with `DATABASE_URL` unset: exit 0, with `/jobs/[id]/prep` in the route table (dynamic, 763 B) — confirms the Next-15 async-`params` type and the static/lazy `getJob` import (build guard). Acceptance items: item 1 (lock for `screening`/`applied`/`closed`, placeholder for `interviewing`) — page tests 1–4; item 2 (button PATCHes `{ status: 'interviewing' }` exactly) — `status-transition-button.test.tsx` test 1; item 3 (`pnpm test` green) — above.
