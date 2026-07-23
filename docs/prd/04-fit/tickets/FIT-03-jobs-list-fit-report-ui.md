---
id: FIT-03
title: Jobs list, job-detail shell, and Fit Report page
module: 04-fit
lane: 04-fit
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FIT-02]
blocks: []
---

# FIT-03 — Jobs list, job-detail shell, and Fit Report page

No ADR — the decision is already made in PRD §5.2 (Fit Report spec) and §5.7 (Jobs list / Job detail UX rules); this is build ticket 3 of 3 against the `04-fit` module.
Parent sub-PRD: [04-fit README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FIT-02 — CROSS and SCORE route](FIT-02-cross-score-route.md)
**Why `builder`:** implementing UI for already-decided routes/schemas and an already-specified page layout — no open product design.

## Background + basis

PRD §5.7, quoted verbatim (both rows this ticket implements):

> Jobs 列表 | 每个 job 带状态 chip：screening → applied → interviewing → closed；无库时禁止新建 job，CTA 引导导入简历——垃圾进垃圾出，库太薄时产出通用结果等于自毁定位
> Job 详情 | Fit / Resume / Prep 三段推进；Prep 在 interviewing 前锁定（文案："拿到面邀后解锁"）

This ticket creates the **shared job-detail layout/tab shell** (`app/(app)/jobs/[id]/layout.tsx`) that `05-tailor` and `06-prep` render their own tabs INSIDE, without editing this file — per `docs/prd/breakdown-plan.md` §3's file-scope allocation: "`[id]/layout.tsx` 是 Job 详情三段式 tab 壳，FIT-03 创建；`05`/`06` 只在其子路由下新增页面，不改 layout 本身". This ticket must build the Prep-tab-locked-until-interviewing nav state (PRD: "Prep 在 interviewing 前锁定") using only `job.status` (already available from the server-side job fetch this layout performs) — it does NOT need to import anything from `06-prep` (that module doesn't exist yet in the DAG) to render a disabled nav link; `06-prep`/PRP-03 later builds the actual locked-state PAGE CONTENT at `app/(app)/jobs/[id]/prep/page.tsx`, reached only if the user navigates there directly (the nav link here is a UX hint, not the enforcement boundary — enforcement is PRP-03's own page-level check plus, ultimately, whatever a route actually requires server-side).

PRD §5.2's Fit Report display spec, quoted verbatim: "**硬性条件**（签证 / 地点 / 年限 / 语言）逐条 pass / fail / unknown，置顶展示。**四个子分**（0–100）：…各自列出支撑 bindings 与 gaps，分数可下钻到证据。**综合分 + 档位**：…档位给建议语 + top gaps（含 probe/play）。**诚实标注**：分数是启发式匹配度，**不是录取概率**——在 V1.1 有真实结果回填之前不得暗示统计意义。低分页面同时展示'如果仍要投，优先补哪两个 gap'。" — the "不得暗示统计意义" disclaimer and the low-score "priority gaps to fix" callout are both explicit, mandatory UI content, not optional polish.

PRD §5.7 "产出展示" row (applies here and is reused verbatim by `05-tailor`/`06-prep`'s own report pages): "dropped > 0 表头计数、可展开被弃条目；research fail 标红但简报照常渲染" — this ticket implements the dropped-count header for the Fit Report specifically (the `research fail` clause is `06-prep`'s own concern).

## Goal

`app/(app)/jobs/page.tsx` (Jobs list with status chips and the no-library CTA gate), `app/(app)/jobs/[id]/layout.tsx` (the shared 3-tab shell: Fit / Resume / Prep, with Prep visually locked pre-interviewing), `app/(app)/jobs/[id]/page.tsx` (the Fit tab's content — the actual Fit Report), and small presentational components for the status chip and dropped-count header.

## Non-goals

- No Resume/Prep tab content — `05-tailor`/TLR-02 and `06-prep`/PRP-03/PRP-04 add their own pages under this layout's sub-routes; this ticket does not create `app/(app)/jobs/[id]/resume/**` or `app/(app)/jobs/[id]/prep/**` at all.
- No JD-paste form for creating a new job — PRD §5.7 says the Jobs list CTA when a library exists leads to job creation, but the actual paste-JD form/submission flow calling `POST /api/jobs` (FIT-01) is this ticket's own scope IF not otherwise specified; PRD gives no separate "new job" page name, so this ticket includes a minimal inline paste-JD form on the Jobs list page itself (not a separate route) as the simplest reading of "全选粘贴 JD" (§4 S2) requiring no dedicated page.
- No status-transition buttons beyond what's needed for THIS page — the `interviewing`/`applied` transition buttons live on `06-prep`/PRP-03 and `05-tailor`/TLR-02's own pages respectively (per those modules' own tickets), not here; this ticket's status chip is read-only display.

## File-scope (write-owns)

- `app/(app)/jobs/page.tsx`, `app/(app)/jobs/_components/**` (job-list-item, status-chip, new-job-form)
- `app/(app)/jobs/[id]/layout.tsx`
- `app/(app)/jobs/[id]/page.tsx` (Fit tab content)
- `app/(app)/jobs/[id]/_components/**` (fit-report display components: hard-requirements list, sub-score cards, composite-score/tier banner, dropped-count header)
- Does not touch: `app/(app)/jobs/[id]/resume/**` (`05-tailor`), `app/(app)/jobs/[id]/prep/**` (`06-prep`), `app/api/jobs/**` (FIT-01/FIT-02, read/call only).
- Serial-safety: FIT-02 merged before this ticket starts (same lane, sequential) — no in-flight contention. This is the LAST ticket in `04-fit`; `05-tailor` and `06-prep` (which add sub-routes under this ticket's `layout.tsx`) do not start until `04-fit` is fully merged, per the module execution order.

## Deliverables

1. `app/(app)/jobs/_components/status-chip.tsx` — presentational component mapping `JobStatus` to a labeled chip (`screening`/`applied`/`interviewing`/`closed`), reused by both the Jobs list and (read-only) the job-detail layout header.
2. `app/(app)/jobs/_components/new-job-form.tsx` — a `company`/`role`/JD-paste textarea form calling `POST /api/jobs` (FIT-01); disabled with an inline message and a "Import your resume" link to `/library` when `hasLibrary()` (server-checked, passed down as a prop from the page) is `false` — the client-side mirror of FIT-01's server-side 403 gate, per PRD's "无库时禁止新建 job，CTA 引导导入简历".
3. `app/(app)/jobs/page.tsx` — server component: `requireUserId()`, fetches the user's jobs list (new query function `listJobs(userId)` added to `03-library`... no — this belongs in `lib/db/queries/jobs.ts`, which is FIT-01's file; since FIT-01 is merged and this is the same module/lane, this ticket appends `listJobs(userId): Promise<Job[]>` to that already-merged file, documented as a same-lane sequential append, not a new file) and `hasLibrary(userId)` (LIB-02), renders each job with `status-chip.tsx` and a link to `/jobs/[id]`, plus the `new-job-form.tsx`.
4. `app/(app)/jobs/[id]/layout.tsx` — server component: `requireUserId()`, `getJob(userId, id)` (FIT-01) — HTTP 404 (Next.js `notFound()`) if absent, renders a 3-tab nav (Fit / Resume / Prep) using Next.js App Router layout conventions, with the Prep tab rendered as a disabled/greyed link with the exact PRD copy "拿到面邀后解锁" when `job.status !== 'interviewing'`, and a normal link otherwise. Renders `status-chip.tsx` in the header.
5. `app/(app)/jobs/[id]/_components/hard-requirements-list.tsx`, `sub-score-card.tsx`, `composite-score-banner.tsx` (includes the mandatory "启发式匹配度，不是录取概率" disclaimer text, verbatim-spirit per PRD, in English per §5.8's "UI 英文" — e.g. "This is a heuristic match score, not a probability of being hired."), `low-score-gap-callout.tsx` (renders "if you're still applying, prioritize these two gaps" — the two highest-weight `topGaps`, only rendered when `tier` is `'Stretch'` or `'Long shot'`, per PRD's "低分页面同时展示").
6. `app/(app)/jobs/[id]/_components/dropped-count-header.tsx` — generic component (reusable by `05-tailor`/`06-prep`'s own report pages via direct import from this ticket's file, since it's a small enough presentational unit that PRD's dropped-count UI requirement — §5.7 — is identical across all three; NOTE per `docs/prd/breakdown-plan.md`'s discussion, cross-module reuse of small UI components was deliberately rejected in favor of per-module duplication to preserve disjoint file-scope — so `05-tailor`/`06-prep` must NOT import this file; they build their own copy. This ticket's component exists only for the Fit tab's own use) — renders `{droppedCount} items were dropped` in the header when `droppedCount > 0`, with an expandable list of the dropped items' raw content (PRD: "dropped > 0 表头计数、可展开被弃条目").
7. `app/(app)/jobs/[id]/page.tsx` — the Fit tab: server component rendering Deliverables 5–6 against the job's `job.fit`/`job.ledger`. If `job.fit` is not yet populated (a job exists post-FIT-01 but pre-FIT-02, per FIT-01's Feedback obligation caveat about the transient state), render a "Generating your Fit Report…" state with a client-side call to `POST /api/jobs/[id]/fit` (FIT-02) triggered automatically on page load if `fit` is absent — this is the concrete UI realization of the two-call READ-then-CROSS "single Fit action" design decided in `04-fit/README.md`.

## Acceptance checklist (classified)

- [ ] `[machine]` `new-job-form.tsx` renders disabled with the import-resume CTA when `hasLibrary === false` (component test, mocked prop).
- [ ] `[machine]` `layout.tsx`'s Prep tab link is disabled/non-navigable with the exact text "拿到面邀后解锁"'s English equivalent when `job.status !== 'interviewing'`, and enabled otherwise — two component tests (mocked job fixture at each status).
- [ ] `[machine]` `composite-score-banner.tsx` always renders the "not a probability of being hired" disclaimer text regardless of score/tier (component test — PRD's "不得暗示统计意义" is unconditional, not just for low scores).
- [ ] `[machine]` `low-score-gap-callout.tsx` renders for `tier: 'Stretch'` and `'Long shot'` fixtures and does NOT render for `'Strong'`/`'Competitive'` fixtures — four component tests covering all tiers.
- [ ] `[machine]` `dropped-count-header.tsx` renders nothing (no header text) when `droppedCount === 0` and renders the count + an expandable list when `> 0`.
- [ ] `[machine]` `app/(app)/jobs/[id]/page.tsx` triggers `POST /api/jobs/[id]/fit` automatically when rendered with a job whose `fit` field is absent, and does NOT call it when `fit` is already present (integration test with a mocked fetch, asserting call/no-call in each case).
- [ ] `[machine]` `pnpm test` green.
- [ ] `[human]` Horace's dogfood pass (P2 milestone) confirms the Fit Report page is legible and the disclaimers read clearly — visual/tone judgment beyond what component tests assert.

## Test plan

Component/integration tests using the `@testing-library/react` setup (FND-09), with the job-detail data (`Job` objects at various `status`/`tier` combinations) hand-built to match FND-03/FND-04's schemas — reuse the same fixture-construction pattern established across FIT-01/FIT-02's own tests. No real API calls; `fetch` to `/api/jobs/[id]/fit` is mocked in the auto-trigger test.

## Feedback obligation

1. General rule: the "Fit tab auto-triggers CROSS+SCORE on load if absent" design (Deliverable 7) is the concrete UI implementation of the atomic-"Fit"-operation architectural choice flagged in `04-fit/README.md` open question #2/#8 — if this auto-trigger pattern proves fragile (e.g. duplicate calls on fast navigation, or a user closing the tab mid-call leaving a job permanently stuck without `fit`), that is evidence bearing directly on that open architectural question; report it back to `04-fit/README.md`'s open questions table rather than silently adding client-side debouncing/retry logic that masks the underlying design tension.
2. The dropped-count-header duplication decision (Deliverable 6's note) is a deliberate simplicity-over-DRY choice recorded in `docs/prd/breakdown-plan.md` — if it causes real maintenance pain once `05-tailor`/`06-prep` build their own copies, that is a legitimate future refactor candidate, but not one any single ticket should unilaterally resolve by reaching into another module's files; raise it as a new open question in `docs/prd/breakdown-plan.md` §6 if it becomes a real problem.

## Changelog / Deviations

**v0.1 — 2026-07-23, Builder** (branch `ticket/FIT-03`, plan `docs/plans/FIT-03.md`). Not reviewed; no merge. Baseline `pnpm test` at `f513f09` was 63 files / 795 tests; after this ticket it is 75 files / 947 tests, all green. `pnpm lint` clean. `next build` with `DATABASE_URL` unset succeeds and registers `/jobs` and `/jobs/[id]` as dynamic routes.

1. **D1 — `listJobs` returns `JobListRow[]`, not `Job[]`.** Deliverable 3 literally says `listJobs(userId): Promise<Job[]>`. The implementation returns a **narrow five-column projection** (`id`, `company`, `role`, `status`, `createdAt`) with no Zod parse. Three reasons, all recorded at the implementation site: **(a) privacy** — the list needs company/role/status/date, and returning whole rows would pull every job's `jdRaw` + `jd` + `ledger` + `fit` into one page render (PRD §8.1 data minimisation); **(b) blast radius** — `parseRow` throws on stored-row drift and the Jobs list is the *only* navigation entry to every job, so one drifted row would make every other job unreachable, whereas a projection over NOT-NULL scalar/enum columns cannot drift at all; **(c) cost** — the `jsonb` columns are the bulk of a `jobs` row. Silently skipping unparseable rows was rejected outright (PRD "宁可暴露不完整，不静默吞掉"). A test asserts the row has *exactly* those five keys, so a future "just select \*" edit fails rather than silently undoing the decision.

2. **D8 — the dropped-count header is PARTIAL on every page load after the run that produced it.** FIT-02 does not persist `dropped.bindings` (`jobs` has no column for it), so only layer 2's injected `uncovered — rerun` gaps survive into the database. On a reload the count is therefore *smaller* than the one shown moments earlier, and the UI says so explicitly ("The discarded raw entries are only available on the run that produced them.") rather than letting the number silently shrink. PRD §5.5 layer 1's "前端可查看被弃原始条目" is thus honoured **only on the first render**. This is plan §5 Q3, owner Horace — persisting them needs a new column (FND-05's file-scope) plus a retention decision about model-discarded content, neither of which is inside this ticket's file-scope.

3. **D5 / D15 — no active-tab highlight, and the Resume/Prep links 404 until `05`/`06` land.** The highlight would require `useSelectedLayoutSegment()`/`usePathname()`, i.e. a client component, and that hook returns `null` under jsdom with no router — the highlight would be untestable. PRD §5.7 requires "Fit / Resume / Prep 三段推进", not a highlight. The dead links are deliberate: `docs/prd/breakdown-plan.md` §3 requires `05-tailor`/`06-prep` to add pages under `[id]/` **without editing `layout.tsx`** ("不改 layout 本身"), and a placeholder now would force exactly that later edit. A time-boxed inter-module gap, flagged so the Reviewer does not file it as a defect.

4. **§5 Q5 — PRD §5.1's "全程 streaming 展示进度" is NOT satisfied for Fit in v1.** FIT-02's route returns one JSON body; a progress stream is a route-shape change outside this ticket's file-scope. The substitute is an honest `role="status"` line carrying §5.1's real p50 expectation ("about 30 seconds"). LIB-03 recorded the same shortfall for PARSE, where PRD did *not* name streaming — here PRD **does**, so this is a genuine gap, not a narrower reading. Owner: Horace — accept non-streaming Fit for v1, or schedule a route-shape change.

5. **§5 Q1 — `/jobs` has no navigation entry point.** `app/layout.tsx`'s header links only "Groundwork" and sign-out, and `app/(app)/home/page.tsx` still says the Jobs page lands in a later module. Both are 01-foundation's files, outside this ticket's file-scope, so the page is reachable only by typing the URL. `/library` shipped with the identical gap. Flagged for the P2 dogfood pass; owner Horace decides whether a follow-up ticket (01-foundation or 07-platform-launch) adds an app-shell nav for `/library` + `/jobs`.

6. **Two `getJob` reads per job-detail request (D2).** `layout.tsx` and `page.tsx` each call `getJob` — App Router layouts cannot hand data to their pages, and a shared `cache()`d reader would need a `_lib/` folder that `breakdown-plan.md` §3 does not allocate to `04-fit`. Both are primary-key reads. Accepted and documented rather than solved by widening the file-scope.

7. **Minor, beyond the plan's letter:** the auto-runner's "Try again" control is *removed* while a call is in flight (the error UI is replaced by the `role="status"` line) rather than rendered disabled — a strictly stronger guarantee than the plan's "disabled while in flight", with an `inFlight` ref beneath it for the same-tick double-click. The plan's `DroppedItem` type is defined in `fit-view-model.ts` and re-exported from `dropped-count-header.tsx`, so the pure derivation helpers can build items without a `.ts` file importing a `.tsx` one; both modules still export the name.

**Reported, not patched (ticket Feedback obligation #1 / plan §5 Q4).** The `useRef` single-flight guard closes only the *same-component* duplicate POST (including React StrictMode's dev double-mount, which is live here — `next.config.mjs` is empty so `reactStrictMode` defaults to `true`). It cannot close, and this ticket deliberately does not paper over: two tabs or a fast back-and-forward both POSTing (FIT-02's `already_fitted` guard catches the common case, but its own header documents the residual race where both read `fit === null` and **both pay**); and a user closing the tab mid-call, leaving the job `fit`-less forever with the quota unit already spent. Both need a claim column or an advisory lock in `db/schema.ts` (FND-05's file-scope) and Horace's sign-off. If dogfooding produces real evidence of either, it belongs in `docs/prd/04-fit/README.md`'s open-questions table as a separate, deliberate act — and it is direct evidence on that README's open question #2 and on plan §6's flagged ADR-0001 candidate ("Fit is one user-facing operation delivered as two server calls"). No ADR was written; `docs/adr/` stays empty.

**What the green suite does and does not prove.** Every `fit`/`ledger` in these tests is a fixture this repo wrote, so the tests prove wiring, gating, derivation and copy — not that the Fit Report is *correct*. Model quality is `pnpm eval`'s Q1/Q2; legibility and tone are this ticket's `[human]` acceptance item (Horace's P2 dogfood pass). No manual smoke run was performed: it needs a real `DATABASE_URL` + `ANTHROPIC_API_KEY` that the Builder does not hold, so the StrictMode double-mount behaviour and the real two-call latency remain unobserved in a live browser.
