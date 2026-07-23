# Implementation plan — FIT-03: Jobs list, job-detail shell, and Fit Report page

Ticket: [docs/prd/04-fit/tickets/FIT-03-jobs-list-fit-report-ui.md](../prd/04-fit/tickets/FIT-03-jobs-list-fit-report-ui.md)
Sub-PRD: [docs/prd/04-fit/README.md](../prd/04-fit/README.md)
Master spec: [docs/PRD.md](../PRD.md) §4 S2 (全选粘贴 JD → 30s 内拿到 Fit Report), §5.1 (stage table + 延迟预算 + streaming), §5.2 (the Fit Report display spec — hard requirements 置顶, four sub-scores with drill-down, composite + tier + advice + top gaps, the 诚实标注 disclaimer, the low-score "priority two gaps" callout), §5.5 layers 1–2 (dropped 计数随响应返回、前端可查看被弃条目; `uncovered — rerun` injection), §5.6 (`Job` + status enum), §5.7 (Jobs 列表 / Job 详情 / 产出展示 rows), §5.8 (UI 英文), §8.3 (全部查询以 session userId 约束)
Upstream tickets whose merged code this builds on: [FND-03](../prd/01-foundation/tickets/FND-03-pipeline-payload-schemas.md) (`JdExtract`/`Ledger`/`Binding`/`Gap`/`FitReport`/`SubScore`/`FitTier`/`HardRequirementCheck`), [FND-04](../prd/01-foundation/tickets/FND-04-persisted-entity-schemas.md) (`JobStatus`), [FND-05](../prd/01-foundation/tickets/FND-05-drizzle-schema-neon.md) (`jobs` table), [FND-07](../prd/01-foundation/tickets/FND-07-server-validation-layers.md) (`UNCOVERED_MARKER`), [FND-08](../prd/01-foundation/tickets/FND-08-authjs-session.md) (`requireUserId`, `middleware.ts`'s allowlist-by-omission gate), [FND-09](../prd/01-foundation/tickets/FND-09-app-shell-deploy.md) (`app/layout.tsx`, the `@testing-library/react` + jsdom setup), [LIB-02](../prd/03-library/tickets/LIB-02-persistence-api.md) (`hasLibrary`), [LIB-03](../prd/03-library/tickets/LIB-03-confirm-ui-library-page.md) (**the UI pattern this ticket mirrors end to end** — thin server page + client components + `_fixtures`), [FIT-01](../prd/04-fit/tickets/FIT-01-job-creation-status-route.md) (`POST /api/jobs`, `GET /api/jobs/[id]`, `getJob`, `lib/db/queries/jobs.ts`), [FIT-02](../prd/04-fit/tickets/FIT-02-cross-score-route.md) (`POST /api/jobs/[id]/fit`, `lib/scoring/score.ts`)
ADRs: `docs/adr/` contains only `.gitkeep` — none exist. This plan flags **one ADR candidate** (§6). Do **not** create it in this ticket.
Base commit: `f513f09` on `main` (`merge: [FIT-02] ticket/FIT-02 -> main (pipeline CLEAR)`), working tree clean at planning time (2026-07-23). Branch per repo convention: `ticket/FIT-03`.

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone. Every "verified" claim below was checked by direct inspection or by **running it** at planning time — confirm cheaply if you like, do not re-derive.

**Standing environment rules on this machine** (carried from `docs/plans/FIT-01.md` / `FIT-02.md`, re-verified this session):

- Invoke pnpm as **`corepack pnpm ...`** — bare `pnpm` is not on the Bash tool's `PATH`.
- Every Bash invocation prints a harmless first line `/c/Users/HoraceHou/.bash_profile: line 1: $'\377\376source': command not found`. That is the user's UTF-16-BOM'd `~/.bash_profile`, **not** a repo file. Ignore it.
- `.gitattributes` is `* text=auto eol=lf` — new files are materialized LF. Do not add CRLF.
- Paths in this repo contain `(app)` and `[id]` segments. In Bash, quote every such path (`"app/(app)/jobs/[id]/page.tsx"`), or globbing/grouping will mangle it.

---

## 0. Repo-state check performed for this plan (verified 2026-07-23 at `f513f09`)

**Baseline `corepack pnpm test` is GREEN: 63 files / 795 tests, ~23.5 s.** Record this number. Your final run must be ≥ these counts and still green.

### 0.0 Facts verified by RUNNING them (do not re-litigate these; they cost a bounce each if guessed wrong)

Four probes were executed at planning time in a scratchpad Vitest project wired to this repo's `node_modules`, React plugin and `@` alias. Results:

1. **`next/link` renders under jsdom with NO router provider.** `render(<Link href="/jobs/abc">Fit</Link>)` works and `screen.getByRole('link', { name: 'Fit' }).getAttribute('href') === '/jobs/abc'`. **No `next/link` mock and no router provider are needed in any test in this ticket.**
2. **`useSelectedLayoutSegment()` with no router provider returns `null` — it does not throw.** That is precisely why it is *useless* for testing an "active tab" highlight: every test would see `null`. See D5 — this ticket does not use it.
3. **`<details>`/`<summary>` toggles under jsdom**: clicking the `<summary>` flips `details.open` from `false` to `true`. **But content inside a *closed* `<details>` is still returned by Testing Library queries** (jsdom does not apply the UA stylesheet's hiding). So "collapsed content is not visible" is **not** assertable; assert on `details.open` and on element presence/absence instead. Getting this backwards produces a test that passes for the wrong reason.
4. **An async Server Component layout is directly renderable in a test**: `render(await JobLayout({ children: <p/>, params: Promise.resolve({ id: 'job-1' }) }))` renders both the layout chrome and the children. Same technique as `app/(app)/library/page.test.tsx`'s `render(await LibraryPage())`.

Also verified by running: `@/lib/db/queries/jobs` imports cleanly from a **jsdom** test with `DATABASE_URL` unset (its lazy memoized `dbIndex()` holds), so `app/(app)/jobs/page.tsx` may import it **statically** exactly as `app/(app)/library/page.tsx` imports `@/lib/db/queries/library`.

### 0.1 Merged code this ticket consumes (all read directly for this plan)

- **FIT-01 → `lib/db/queries/jobs.ts`** (this ticket **appends** to it; see D1):
  - `PersistedJob = Job.extend({ ledger: Ledger.nullable(), fit: FitReport.nullable() })` — the DB-facing contract. `PersistedJob` is a **value** export (a Zod schema) as well as a type.
  - `getJob(userId, jobId): Promise<PersistedJob | null>` — `null` means *absent OR another user's*, indistinguishable by design (PRD §8.3). **Throws** when the stored row fails `PersistedJob.safeParse` (loud-failure policy).
  - Module is import-safe with no environment (memoized lazy `dbIndex()`); **do not add a top-level `@/db/index` import**.
  - `jobs` has **no `deletedAt`** and there is no delete endpoint in v1.
- **FIT-01 → `app/api/jobs/route.ts`** — wire contract transcribed in its header, code against it verbatim:
  - `POST /api/jobs`, body `{ jdRaw: string, company: string, role: string }`.
  - `201` → the created job (`{ …, status: 'screening', jd, ledger: null, fit: null }`), `400 {error:'invalid_body', issues: string[]}`, `401 {error:'Unauthorized'}`, **`403 {error:'no_library'}`**, `422 {error:'read_failed'}`, **`429 {error:'quota_exceeded', op:'fit', resetAt:number}`**, `500 {error:'library_check_failed'|'job_write_failed'}`, `503 {error:'global_breaker_tripped'|'quota_check_failed'}`.
  - Server-side caps: `jdRaw` ≤ 50 000 chars, `company`/`role` ≤ 200 chars, all `.trim().min(1)`.
  - **There is deliberately no `GET /api/jobs` list route.** The Jobs list reads server-side through a query helper.
- **FIT-01 → `app/api/jobs/[id]/route.ts`**: `GET /api/jobs/{id}` → `200 <job>` / `401` / `404 {error:'not_found'}` / `500 {error:'job_read_failed'}`. `PATCH` exists but **this ticket never calls it** (status transitions belong to TLR-02 / PRP-03).
- **FIT-02 → `app/api/jobs/[id]/fit/route.ts`** — the auto-trigger's target. **No request body is read at all.** Responses:
  - `200` = the completed job **at the top level** plus two additive keys:
    `dropped: { count: number, bindings: Array<{ item: Binding; reason: string }>, uncoveredRequirementIds: string[] }` and
    `anomalies: { doubleCoveredRequirementIds: string[], unknownRequirementIds: string[] }`.
  - `401 Unauthorized` · `404 not_found` · **`409 already_fitted`** (job.fit already populated — **no paid call made**) · `409 no_library` · `422 cross_failed` · `500 job_read_failed|library_read_failed|score_failed|job_write_failed` · `503 global_breaker_tripped`.
  - Its header states explicitly: **"FIT-03 must branch on the `error` STRING, not on the status code"** (two different 409s).
  - Its header also states the limitation this ticket must live with: **dropped items are NOT persisted** — `jobs` has no column for them — "so after a refresh FIT-03 can only render the injected 'uncovered — rerun' gaps, which do live in `ledger`". D8 below is the honest resolution.
- **FIT-02 → `lib/scoring/score.ts`** (read-only; **do not edit**):
  - `SubScore.bindings` / `SubScore.gaps` hold **`requirementId` strings** in `jd.requirements` order (its D3). That is the join key for PRD §5.2's "分数可下钻到证据".
  - **D6 "not assessed"**: a bucket with no member requirement gets `score: 0, bindings: [], gaps: []` and is **excluded from the composite average**. Its comment names the consumer test explicitly: *"FIT-03 detects it as `bindings.length === 0 && gaps.length === 0`"*. D7 below implements that, and §5 Q2 records the one case where the heuristic and the scorer disagree.
  - `TOP_GAPS_CAP = 3`, exported. `topGaps` is ordered by originating requirement weight desc; layer-2 injected `uncovered — rerun` gaps **are** eligible for it and carry `play: ''`.
  - `advice` is four fixed English strings and **deliberately does not contain the disclaimer**: its comment says *"The user-facing 'this is a heuristic match score, not a probability' DISCLAIMER itself is FIT-03's mandatory UI element (its Deliverable 5), not this string's job."*
  - Composite = mean of the **assessed** buckets, of the already-rounded sub-scores.
- **FND-03 → `lib/schemas/pipeline.ts`** (import only, never edit): `FitTier = 'Strong'|'Competitive'|'Stretch'|'Long shot'` (note the space); `HardRequirementCheck = { label: string; status: 'pass'|'fail'|'unknown' }`; `Gap = { requirementId, probe, play }`; `Binding = { requirementId, projectId, strength: 'strong'|'partial', evidence }`; `JdExtract.requirements[] = { id, text, weight: 1|2|3, category: 'technical'|'experience'|'domain'|'logistics' }`.
- **FND-07 → `lib/validation/`**: `UNCOVERED_MARKER = 'uncovered — rerun'` (em dash, exactly). **Import the constant; never retype the literal.** Verified: the barrel `lib/validation/index.ts` and all four modules import nothing but `import type` — **safe to pull into a client bundle**.
- **LIB-02 → `lib/db/queries/library.ts`**: `hasLibrary(userId): Promise<boolean>` = a non-null library with ≥ 1 project. **Throws** on stored-row drift (do not catch it into "no library" — that would tell a user who *has* a library to import another one).
- **FND-08 → `middleware.ts`**: gating is **allowlist-by-omission** (`PUBLIC_PATHS = { '/', '/signin', '/privacy', '/tos' }`). `/jobs` and `/jobs/*` are therefore protected **the moment the files exist**. **No middleware edit is needed and none may be made** (`middleware.ts` is 01-foundation's file).
- **FND-09 → `app/layout.tsx`**: renders the header + `<main>`. It is 01-foundation's file — **out of scope**, which is why there is no nav link to `/jobs` (§5 Q1).
- **Next.js 15.5.20 / React 19.2**: a dynamic segment's `params` is a **Promise** in both `page.tsx` and `layout.tsx` and must be awaited. A non-Promise type type-checks in isolation and fails `next build`'s generated route-type check in CI.
- **`next.config.mjs` is empty (`{}`)** ⇒ `reactStrictMode` takes its Next 15 default of **`true`**, so in `next dev` every effect mounts **twice**. D9's single-flight guard is therefore load-bearing in dev, not decorative.
- **`vitest.config.ts` needs NO change** — `include` already covers `app/**/*.test.{ts,tsx}` and `lib/**/*.test.ts`. **`package.json` needs NO change**; no new dependency. `eslint.config.mjs` extends `next/core-web-vitals` + `next/typescript`; there is no CSS framework, so styling is inline `style={{…}}` exactly like every existing page.
- **Serial-safety**: no `ticket/FIT-03` branch exists; `app/(app)/jobs/` does not exist at all; `app/(app)/` currently holds only `home/`, `library/`, `settings/`. FIT-01 and FIT-02 are merged into `main`. `05-tailor` and `06-prep` have not started. There is **no `error.tsx`, `not-found.tsx` or `loading.tsx`** anywhere in `app/` — `notFound()` renders Next's built-in 404. If any of that has changed at build time, stop and escalate.

### 0.2 Design resolutions this plan makes (the ticket's open ambiguities, decided here)

The ticket hands the Architect several genuinely under-specified points. Each is decided below **with the rejected alternative**, so the Builder implements one thing and the Reviewer reviews a decision rather than an accident. **Every one of these must also appear as a code comment at the site that implements it.**

| # | Question | Decision | Why / rejected alternative |
|---|---|---|---|
| **D1** | The ticket's Deliverable 3 says append `listJobs(userId): Promise<Job[]>` to `lib/db/queries/jobs.ts`. What exactly does it return? | **A NARROW PROJECTION, not `PersistedJob[]`.** Add `export type JobListRow = { id: string; company: string; role: string; status: JobStatus; createdAt: number }` and `listJobs(userId): Promise<JobListRow[]>`, selecting **only those five scalar columns** — `jdRaw`, `jd`, `ledger`, `fit` are never read. Ordered `createdAt DESC`. **No Zod parse** (see why in the next column). This is a **deliberate, documented deviation from the ticket's literal `Promise<Job[]>`** — record it in the ticket's Deviations. | Three independent reasons. (a) **Privacy**: the list page needs company/role/status only; pulling every job's `jdRaw` + `jd` + `ledger` into a page render ships the user's whole JD corpus for nothing (PRD §8.1's data-minimisation posture). (b) **Blast radius**: `parseRow` *throws* on stored-row drift, and the Jobs list is the **only** navigation entry to every job — one drifted row would make every other job unreachable. A narrow projection reads only NOT-NULL scalar/enum columns, which cannot drift, so the failure mode does not exist rather than being handled. (c) **Cost**: `jsonb` columns are the bulk of a `jobs` row. Rejected: returning `PersistedJob[]` via `parseRow` (all three problems); silently skipping rows that fail to parse (violates PRD's "宁可暴露不完整，不静默吞掉"). |
| **D2** | Where does the Fit tab get its data — from the layout or its own read? | **Its own read.** `layout.tsx` and `page.tsx` **each** call `getJob(userId, id)`. App Router layouts cannot pass data to pages, and this ticket must not create a `_lib/` folder (out of the declared file-scope). **Two indexed primary-key reads per detail-page request is accepted and documented.** | Rejected: a React `cache()`-wrapped shared reader in a new `app/(app)/jobs/[id]/_lib/` — the breakdown-plan §3 glob for `04-fit` names `app/(app)/jobs/[id]/_components/**` and not `_lib`, and inventing a folder outside the declared scope is exactly what the file-scope table exists to prevent. Rejected: passing the job down through `children` cloning (not possible for a Server Component layout). The cost is two `SELECT … WHERE id=$1 AND user_id=$2 LIMIT 1` — both on the primary key. |
| **D3** | The "single Fit action" (ticket Deliverable 7 / §4 S2 "全选粘贴 JD → 30s 内拿到 Fit Report"): how do the two server calls become one user action? | **New-job form → `POST /api/jobs` → on 201, full navigation to `/jobs/<id>` → the Fit tab renders `<FitAutoRunner>` because `job.fit === null` → the runner `POST`s `/api/jobs/<id>/fit` on mount and renders the report from that response body.** | This is the concrete UI realisation of `04-fit/README.md`'s decision-table row 1 and is what the ticket names as its Deliverable 7. Full navigation (`window.location.href = '/jobs/' + id`) rather than `useRouter().push()` — the **exact precedent already in this repo** is `app/(app)/settings/_components/delete-account-confirm.tsx`, and its test file shows the `Object.defineProperty(window, 'location', …)` stub. Keeps every test in this ticket free of a Next router mock. Cost: a full document load between the two calls — accepted, documented. |
| **D4** | After the auto-trigger succeeds, how does the report appear — `router.refresh()` or from the response? | **From the response body.** The runner validates and renders it directly. **NO `router.refresh()`, NO `next/navigation` import anywhere in this ticket except `notFound()`.** | Not merely a testing convenience: FIT-02's `dropped` payload **exists only in that response** and is never persisted. A `router.refresh()` would re-read from the DB and *lose* the very data PRD §5.5 layer 1 requires the front end to show ("dropped 计数随响应返回，前端可查看被弃原始条目"). Rendering from the response is the only way to satisfy that requirement at all. |
| **D5** | Active-tab highlighting in the 3-tab nav. | **Not implemented.** All three tabs render identically apart from the Prep lock. | It would require `useSelectedLayoutSegment()`/`usePathname()`, i.e. converting the nav into a client component — and (verified, §0.0 probe 2) that hook returns `null` under jsdom with no router, so the highlight would be **untestable**. PRD §5.7 requires "Fit / Resume / Prep 三段推进", not a highlight. Recorded as a deliberate omission, not an oversight. |
| **D6** | "Prep 在 interviewing 前锁定" — how is a tab *actually* non-navigable? | **Render a `<span>`, not an anchor.** When `job.status !== 'interviewing'` the Prep tab is `<span>Prep</span>` plus the locked copy; when it is `'interviewing'` it is a real `<Link href={'/jobs/'+id+'/prep'}>`. Exported constant **`PREP_LOCKED_COPY = 'Unlocked after you get an interview invite'`** (PRD's "拿到面邀后解锁", English per §5.8). | **`disabled` is not a valid attribute on `<a>`, and `aria-disabled` does not stop navigation** — an `<a disabled href>` is fully clickable. The only correct "non-navigable" implementation is to not render an anchor. This also makes the acceptance assertion crisp and falsifiable: `queryByRole('link', { name: /prep/i })` is `null` when locked and non-null when unlocked. The copy is fixed **here** so code and test cannot drift; the ticket only says "the English equivalent". **This nav is a UX hint, not the enforcement boundary** — the ticket says so, and PRP-03 owns the real page-level check. |
| **D7** | Rendering a "not assessed" sub-score (FIT-02 D6 handed this here explicitly). | A bucket with `bindings.length === 0 && gaps.length === 0` renders **"Not assessed"** plus "this posting states no requirement in this category" — **never the number `0`**. Additionally, when *any* bucket is not assessed, the composite banner renders one extra line: "Overall is the average of the sub-scores that were assessed." | Showing `0` for a category the JD never asked about reports a failure that did not happen — the exact misreading FIT-02's D6 exists to prevent. The extra banner line is required for a second reason: FIT-02's scorer comment promises "the four figures FIT-03 displays really do reproduce the composite by hand", and that promise **breaks** whenever a bucket is excluded. One honest sentence is cheaper than a dogfood bug report that the numbers do not add up. |
| **D8** | The dropped-count header must render on **two** paths with different data: fresh-fit (full `dropped` payload in hand) and page-reload (nothing persisted). | `DroppedCountHeader` takes `{ droppedCount: number; items: DroppedItem[]; partial?: boolean }`. **Fresh-fit path**: `droppedCount = dropped.count`, items = the discarded bindings (`item.projectId` + `item.evidence` + `reason`) *and* the injected-gap requirement ids, `partial: false`. **Reload path**: count = `ledger.gaps.filter(g => g.probe === UNCOVERED_MARKER).length`, items = those requirements, **`partial: true`**, which renders the note "The discarded raw entries are only available on the run that produced them." | PRD §5.7 requires "dropped > 0 表头计数、可展开被弃条目"; the persisted data can only support half of it. Rejected: showing nothing after a reload (loses a PRD-mandated count that *is* recoverable); rejected: showing the reduced count with no note (the number silently shrinks between the first view and a refresh — worse than either honest option, and exactly the kind of silent inconsistency PRD's "宁可暴露不完整，不静默吞掉" forbids). The underlying gap — dropped items are unpersistable without a new column — is §5 Q3, owner Horace, and is **not** fixable inside this ticket's file-scope. |
| **D9** | Duplicate `POST …/fit` calls. | **A `useRef` single-flight guard inside `FitAutoRunner`**, so one mounted component issues **at most one** automatic POST for its lifetime — including under React StrictMode's dev double-mount (verified: `reactStrictMode` defaults to `true` here). **Explicitly NO automatic retry, NO debounce, NO backoff**; a failure renders an error plus a manual "Try again" button, which is an explicit user action. | The mount-effect idempotence guard is ordinary correctness, not the "client-side debouncing/retry logic that masks the underlying design tension" the ticket's Feedback obligation #1 forbids — that clause is about **cross-mount / cross-tab** duplication and abandoned jobs, which a ref cannot fix and which must be **reported** to `04-fit/README.md`'s open questions (§5 Q4). An automatic retry would be a second **paid** CROSS call from a component the user is not watching. |
| **D10** | The `409 already_fitted` response. | **Not an error state.** On `409` with `error === 'already_fitted'`, the runner issues `GET /api/jobs/<id>` and renders the report from that job (with `partial: true` dropped data, per D8). Any other 409 (`no_library`) is an error state. | The 409 means another tab/request already produced the report — the user's Fit exists and must be shown. Showing "something went wrong" while the report sits in the database would be a false failure. Branching on the **error string, not the status code**, is mandated by FIT-02's own header (two distinct 409s). |
| **D11** | Score presentation format. | **`72 / 100`, never `72%`.** No `%` character may appear anywhere in the Fit Report output. A test asserts its absence. | PRD §5.2: "在 V1.1 有真实结果回填之前**不得暗示统计意义**". A percent sign next to a number is read as a probability by every reader; this is the cheapest possible mechanical enforcement of a PRD hard constraint. |
| **D12** | Hard-requirement status presentation. | Text tokens **`Pass` / `Fail` / `Unknown`** next to each label; colour is an addition, never the sole carrier. An **empty** `hardRequirements` array renders the section with the line "This posting states no hard requirements we could check." rather than rendering nothing. | Colour-only status fails for colour-blind and monochrome-print readers, and this repo has no design system to lean on. An empty array is a **normal** outcome (FIT-02's D2 emits an entry only for kinds the JD actually states), and a silently absent PRD-mandated "置顶展示" section reads as a rendering bug. |
| **D13** | The low-score callout when `topGaps` has fewer than two entries. | ≥ 2 → the first two. Exactly 1 → that one, heading "close this gap first". **0 → render nothing at all.** Gaps whose `probe === UNCOVERED_MARKER` render a distinct line ("This requirement was not addressed by the analysis — re-run Fit by creating the job again.") instead of an empty `play`. | PRD says "优先补哪两个 gap"; two is the target, not a guarantee — a degenerate JD can produce fewer. Injected gaps carry `play: ''` **by FND-07 design**, and rendering an empty bullet under "here is your bridge" is worse than saying what actually happened. |
| **D14** | Where does the JD-paste form live? | **Inline on `app/(app)/jobs/page.tsx`**, as the ticket's Non-goals prescribe. No `/jobs/new` route. | The ticket decides this; recorded here so the Builder does not re-open it. PRD §4 S2's "全选粘贴 JD" describes one paste, not a page. |
| **D15** | Resume/Prep tabs point at routes that **do not exist yet** (`05-tailor` / `06-prep`). | **Render the links anyway.** A click 404s (Next's built-in 404 — this repo has no `not-found.tsx`) until those modules land. | `docs/prd/breakdown-plan.md` §3 requires that `05`/`06` add pages under this layout **without editing the layout itself**. Rendering a placeholder now would force exactly the edit that rule forbids. The transient 404 is a known, time-boxed inter-module gap — **flagged to the Reviewer here so it is not filed as a defect** (§4 R7). |
| **D16** | Where do test fixtures live, and what are they made of? | **`app/(app)/jobs/_fixtures/job-fixtures.ts`**, test-only, imported by no production file, built from **hand-written literals only — no `node:fs`, no `@/eval` import**. | Follows LIB-03's `app/(app)/library/_fixtures/` precedent, and `_`-prefixed folders are Next.js private folders (never routed). The no-`fs` rule is not style: LIB-03's own fixture header records that `@/eval/fixtures` **throws at import time under the jsdom environment** (`import.meta.url` is not a `file://` URL there). Most of this ticket's tests are jsdom. Repeating LIB-03's bug would cost a bounce. |

---

## 1. Scope

### In scope

**Appended to a merged same-lane file** (allowed: `lib/db/queries/jobs.ts` is `04-fit`'s own file per breakdown-plan §3, FIT-01/FIT-02 are merged, nothing is in flight):

1. `lib/db/queries/jobs.ts` — **append only**: `JobListRow` type + `listJobs()`. Do not restructure, rename, or reformat one existing line.
2. `lib/db/queries/jobs.test.ts` — **append only**: one new `describe('listJobs …')` block.

**New files** (this ticket owns all of them):

3. `app/(app)/jobs/page.tsx` + `app/(app)/jobs/page.test.tsx`
4. `app/(app)/jobs/_components/status-chip.tsx` + `.test.tsx`
5. `app/(app)/jobs/_components/job-list-item.tsx` *(no own test file — covered by `page.test.tsx`)*
6. `app/(app)/jobs/_components/new-job-form.tsx` + `.test.tsx`
7. `app/(app)/jobs/_fixtures/job-fixtures.ts` *(test-only)*
8. `app/(app)/jobs/[id]/layout.tsx` + `layout.test.tsx`
9. `app/(app)/jobs/[id]/page.tsx` + `page.test.tsx`
10. `app/(app)/jobs/[id]/_components/job-tabs.tsx` *(no own test file — covered by `layout.test.tsx`)*
11. `app/(app)/jobs/[id]/_components/fit-view-model.ts` + `.test.ts` *(pure, node environment)*
12. `app/(app)/jobs/[id]/_components/hard-requirements-list.tsx` + `.test.tsx`
13. `app/(app)/jobs/[id]/_components/sub-score-card.tsx` + `.test.tsx`
14. `app/(app)/jobs/[id]/_components/composite-score-banner.tsx` + `.test.tsx`
15. `app/(app)/jobs/[id]/_components/low-score-gap-callout.tsx` + `.test.tsx`
16. `app/(app)/jobs/[id]/_components/dropped-count-header.tsx` + `.test.tsx`
17. `app/(app)/jobs/[id]/_components/fit-report-view.tsx` *(no own test file — covered by both page tests)*
18. `app/(app)/jobs/[id]/_components/fit-auto-runner.tsx` + `.test.tsx`

Plus the doc write-backs in §2.14 (ticket Changelog / Deviations), which are how this repo records a decision instead of burying it.

### Explicitly out of scope — do not implement, even opportunistically

- **No `app/(app)/jobs/[id]/resume/**` and no `app/(app)/jobs/[id]/prep/**`.** Not even a placeholder page. `05-tailor`/TLR-02 and `06-prep`/PRP-03/PRP-04 own those paths (D15).
- **No edit to any API route** (`app/api/jobs/**` is FIT-01/FIT-02's — call it, never change it), **`lib/scoring/**`** (FIT-02), **`lib/validation/**`** (FND-07 — import only), **`lib/schemas/**`** (FND-03/04 — import only), **`lib/db/queries/library.ts`** (LIB-02 — import only), **`app/layout.tsx`**, **`app/(app)/home/page.tsx`**, **`middleware.ts`**, **`auth*.ts`**, **`db/**`**, **`app/(app)/library/**`**.
- **No new Zod type in `lib/schemas/**`.** breakdown-plan §3: a module's new Zod types live in the module's own directory. The response schema in §2.12 is module-local.
- **No migration.** Nothing here changes the schema. Do not run `db:generate`.
- **No status-transition UI.** No "mark as applied", no "I got an interview", no `PATCH /api/jobs/[id]` call. The status chip is read-only. Those buttons belong to TLR-02 and PRP-03 (04-fit/README decision + open question #1).
- **No re-run-Fit affordance.** FIT-02's `already_fitted` guard makes re-running a job impossible by design; a "Re-run" button would just produce a 409 (04-fit/README open question #5).
- **No `vitest.config.ts` / `package.json` / `tsconfig.json` / `next.config.mjs` / `eslint.config.mjs` change. No new dependency** (no CSS framework, no icon library, no date library — format the one timestamp by hand, see §4 E6).
- **No `router.refresh()`, no `useRouter`, no `usePathname`, no `useSelectedLayoutSegment`.** The only `next/navigation` import in this ticket is `notFound`.
- **No ADR file.** §6 flags the candidate only.

---

## 2. Change list

Every file below carries a header comment in the style of the surrounding repo: what it is, which PRD clause forces it, and which decision from §0.2 it implements. A decision without a comment at its implementation site is a defect in this repo.

### 2.1 `lib/db/queries/jobs.ts` — APPEND (Deliverable 3's query helper; D1)

Append at the **end of the file**, after `attachLedgerAndFit`. Touch nothing above it.

```ts
/**
 * FIT-03's Jobs-list read. A NARROW PROJECTION, not a PersistedJob — see plan D1.
 * ... (rationale comment: privacy / drift blast radius / cost)
 */
export type JobListRow = {
  id: string;
  company: string;
  role: string;
  status: JobStatus;
  createdAt: number;
};

export async function listJobs(userId: string): Promise<JobListRow[]> { … }
```

Implementation rules:

- `db.select({ id: jobs.id, company: jobs.company, role: jobs.role, status: jobs.status, createdAt: jobs.createdAt }).from(jobs).where(eq(jobs.userId, userId)).orderBy(desc(jobs.createdAt))`.
- `desc` must be added to the existing `import { and, eq } from 'drizzle-orm'` line → `import { and, desc, eq } from 'drizzle-orm'`. That is the **only** edit above the appended block, and it is an import-list addition, not a restructure.
- **No `parseRow`, no Zod.** All five columns are NOT NULL scalars/enum whose Drizzle types already guarantee their shape — a re-validation would assert nothing (the same asymmetry LIB-02 documents for `getResume`). Say so in the comment, or a reviewer will read it as an omission.
- `ORDER BY createdAt DESC` — **not** `updatedAt`. Rationale to state in the comment: `updatedAt` is bumped by every status PATCH, so ordering by it would silently reshuffle the user's list when TLR-02/PRP-03 flip a status.
- No `LIMIT`, no pagination. v1 has no PRD requirement for either, and a single user's job count is small. Note it rather than leaving it implicit.
- `eq(jobs.userId, userId)` is the whole WHERE clause — PRD §8.3.

### 2.2 `app/(app)/jobs/_fixtures/job-fixtures.ts` (test-only; D16)

Hand-written literals only. **No `node:fs`, no `@/eval` import, no `import.meta.url`.** Export at minimum:

- `JD_FIXTURE: JdExtract` — 5 requirements exercising **all four** categories including `logistics`, mixed weights 1/2/3, stable ids `r1`…`r5`.
- `LEDGER_FIXTURE: Ledger` — bindings for a subset (at least one `strong` and one `partial`, ≥ 2 bindings on one requirement so the "strongest wins" case is representable), gaps for the rest, **including one injected-style gap** `{ requirementId: 'r5', probe: UNCOVERED_MARKER, play: '' }` (import the constant).
- `fitFixture(overrides?: Partial<FitReport>): FitReport` — a **builder**, so per-tier tests differ by one line. Base: `tier: 'Competitive'`, a plausible `compositeScore`, `advice` copied from `lib/scoring/score.ts`'s table, `topGaps` with 3 entries, `hardRequirements` with one of each status.
- `NOT_ASSESSED_SUB_SCORE: SubScore = { score: 0, bindings: [], gaps: [] }` and an assessed counterpart.
- `jobFixture(overrides?): PersistedJob`-shaped object — **use `import type { PersistedJob }`** (type-only; a value import would drag `drizzle-orm` into jsdom tests for nothing).
- `JOB_LIST_FIXTURE: JobListRow[]` — 4 rows, **one per status**, so the list test covers all four chips from data instead of hardcoding.
- `fitResponseFixture(overrides?)` — the exact FIT-02 200 body: job fields + `dropped` + `anomalies`.

**Guard against the fixture lying**: the fixture module must be exercised by at least one assertion that the objects really satisfy the schemas — e.g. in `fit-view-model.test.ts` (node env), `expect(FitReport.safeParse(fitFixture()).success).toBe(true)` and the same for `Ledger`/`JdExtract`. A fixture that has drifted from FND-03 makes every component test green for the wrong reason.

### 2.3 `app/(app)/jobs/_components/status-chip.tsx` (Deliverable 1)

`export default function StatusChip({ status }: { status: JobStatus })`. Pure, presentational, **no `'use client'`** (it is rendered inside both server and client trees — a component with no hooks and no browser API works in both, and marking it `'use client'` would needlessly pull it into the bundle).

- Maps the four `JobStatus` values to capitalised labels: `Screening` / `Applied` / `Interviewing` / `Closed`. Use a `Record<JobStatus, string>` so TypeScript's exhaustiveness check fires if FND-04's enum ever grows.
- Renders the **label text** plus optional colour/border. Never colour-only (same reasoning as D12).
- Include `title`/`aria-label` only if it adds information beyond the visible label; do not duplicate the label into an aria attribute (it changes nothing and complicates queries).

### 2.4 `app/(app)/jobs/_components/job-list-item.tsx` (Deliverable 3)

`export default function JobListItem({ job }: { job: JobListRow })` — `import type { JobListRow } from '@/lib/db/queries/jobs'` (**type-only**).

- Renders `<article>` (so `getAllByRole('article')` counts rows, matching LIB-03's `project-card.tsx` convention) containing a `next/link` to `/jobs/${job.id}` whose accessible name includes company and role, plus `<StatusChip>`, plus the created date.
- **Renders nothing derived from `jd`/`jdRaw`/`ledger`/`fit`** — it structurally cannot, since `JobListRow` has none of them.

### 2.5 `app/(app)/jobs/_components/new-job-form.tsx` (Deliverable 2) — `'use client'`

`export default function NewJobForm({ hasLibrary }: { hasLibrary: boolean })`.

- **`hasLibrary === false`**: render **no usable form**. Render an explanatory line quoting PRD's reasoning in the product's own voice ("A job screened against an empty library produces generic output") plus a `next/link` to **`/library`** labelled "Import your resume". The submit control is either absent or `disabled`; **`fetch` must not be reachable on this path** — assert zero fetch calls in the test. State in the comment: *this is the client-side mirror of FIT-01's server-side 403 `no_library` gate; the server gate is the real control and this one is UX.*
- **`hasLibrary === true`**: three labelled fields — `company` (`<input>`), `role` (`<input>`), `jdRaw` (`<textarea>`, ~12 rows). Every field has a real `<label htmlFor>` (the tests query by label, and it is the accessibility baseline the rest of the repo keeps).
- Client-side pre-checks that bail with **zero** fetch calls (mirror `upload-form.tsx`'s structure): any field empty after `trim()` → inline `role="alert"`; `jdRaw.length > 50_000` or `company`/`role` `> 200` → inline `role="alert"`. Mirror FIT-01's server caps as named constants with a comment that these are UX mirrors, not security.
- **Single-flight**: `busy` state disables submit while in flight, and the handler returns early if `busy`. This is a **cost control, not polish** — one submit is one paid READ call plus one `fit` quota unit (PRD §9 ≈ $0.04). Copy `upload-form.tsx`'s "double-clicking submit issues exactly ONE fetch" test.
- On submit: `fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jdRaw, company, role }) })`. Relative same-origin URL only; **never send `userId`** (the route takes it from the session).
- Response handling — branch on **status**, and read `error` from the body where FIT-01 defines one:
  - `201` → read `id` off the body; `window.location.href = '/jobs/' + id` (D3). If the body has no string `id`, fall through to the generic error (do not navigate to `/jobs/undefined`).
  - `403` (`no_library`) → render the same import-resume CTA as the `hasLibrary === false` branch. Reachable in real life via a stale tab after account deletion; also the last line of defence if the prop is wrong.
  - `429` (`quota_exceeded`) → "You've used today's Fit allowance. Try again tomorrow." Do **not** echo `resetAt` as a raw epoch number.
  - `422` (`read_failed`) → "We couldn't read that job description. Check that you pasted the whole posting and try again."
  - `400` → surface `issues` the way `_lib/api.ts` does (FIT-01 guarantees issues are Zod **paths + messages, never values**, precisely so they can be shown), capped at 5.
  - `401` → "Your session has expired. Sign in again to continue."
  - `503` → "Job screening is temporarily unavailable. Please try again later."
  - anything else / network throw → one generic message.
  - **Every non-201 path must leave the form usable** (`busy` cleared, values kept). Losing a pasted JD to an error is a real user injury.
- **No `console.*` anywhere.** A JD is user content and often carries their own annotations (FIT-01's logging rule). A test pins this.

### 2.6 `app/(app)/jobs/page.tsx` (Deliverable 3)

Thin async Server Component, modelled line-for-line on `app/(app)/library/page.tsx`:

```ts
export const metadata = { title: 'Jobs — Groundwork' };
export const dynamic = 'force-dynamic';

export default async function JobsPage() {
  const userId = await requireUserId();
  const [jobs, libraryPresent] = await Promise.all([listJobs(userId), hasLibrary(userId)]);
  …
}
```

- **Static** imports of `@/lib/db/queries/jobs` and `@/lib/db/queries/library` — both are verified import-safe with no `DATABASE_URL` (§0.0). A build-guard test pins it.
- `requireUserId()` is **allowed to throw**. `middleware.ts` gates `/jobs` on every request, so an `UnauthorizedError` here means that gate is broken and must be loud. No `redirect('/signin')` (LIB-03's recorded decision, same reasoning).
- `hasLibrary()` is **not** wrapped in try/catch — it throws on stored-row drift by LIB-02's loud-failure policy, and catching it would render the "import your resume" CTA to a user who *has* a library (LIB-03's recorded decision, same reasoning).
- Renders: `<h1>Jobs</h1>`, then `<NewJobForm hasLibrary={libraryPresent} />`, then the list — one `<JobListItem>` per row. **Zero jobs**: an explicit empty-state line (with a library: "No jobs yet — paste a job description above to screen your first one."; without: the form's own CTA already carries the message, so no second empty-state paragraph).
- Order on the page: form above the list. Rationale to state: PRD §4 S2 makes pasting a JD the primary action of this page.

### 2.7 `app/(app)/jobs/[id]/_components/job-tabs.tsx` (Deliverable 4's nav; D5/D6/D15)

```ts
export const PREP_LOCKED_COPY = 'Unlocked after you get an interview invite';
export default function JobTabs({ jobId, status }: { jobId: string; status: JobStatus })
```

- No `'use client'`; no hooks; renders a `<nav aria-label="Job sections">`.
- **Fit** → `<Link href={`/jobs/${jobId}`}>Fit</Link>`; **Resume** → `<Link href={`/jobs/${jobId}/resume`}>Resume</Link>` (D15 — 404s until TLR-02; say so in the comment).
- **Prep**: `status === 'interviewing'` → `<Link href={`/jobs/${jobId}/prep`}>Prep</Link>`. Otherwise → `<span>Prep</span>` + a sibling element carrying `PREP_LOCKED_COPY`. **No `<a>` element on the locked path** (D6 — an anchor cannot be disabled).
- Comment must state: this nav is a UX hint; **PRP-03 owns the real enforcement** at `app/(app)/jobs/[id]/prep/page.tsx`. Do not let a reader conclude the lock is a security control.

### 2.8 `app/(app)/jobs/[id]/layout.tsx` (Deliverable 4)

```ts
export const dynamic = 'force-dynamic';

export default async function JobLayout(
  { children, params }: { children: ReactNode; params: Promise<{ id: string }> },
) { … }
```

- `const { id } = await params;` — **Next 15 requires the await** (a non-Promise type fails `next build`'s generated route-type check in CI).
- `const userId = await requireUserId();` then `const job = await getJob(userId, id);` → `if (!job) notFound();` (`import { notFound } from 'next/navigation'`). `notFound()` covers both "no such job" and "another user's job" — indistinguishable by design (PRD §8.3), and the query module already refuses to distinguish them.
- `getJob` is **not** wrapped in try/catch: it throws on row drift, which is a real bug and must surface, not degrade to a 404 (same policy as LIB-03's `getLibrary`).
- Renders: a header with `job.company` — `job.role`, `<StatusChip status={job.status} />`, then `<JobTabs jobId={id} status={job.status} />`, then `{children}`.
- **No metadata / `generateMetadata`** — it would require a third `getJob` call. Documented omission.
- Header comment must state the contract `05`/`06` depend on: **this file is the shared 3-tab shell; `05-tailor` and `06-prep` add pages under `[id]/resume/**` and `[id]/prep/**` and must not edit this file** (breakdown-plan §3).

### 2.9 `app/(app)/jobs/[id]/_components/fit-view-model.ts` (pure; D7)

No React, no JSX, no `'use client'`. Exports:

```ts
export type RequirementView = {
  requirementId: string;
  /** null when the id is absent from `jd` — a model-hallucinated reference FIT-02 counts but never filters. */
  text: string | null;
  weight: 1 | 2 | 3 | null;
  bindings: Binding[];
  gaps: Gap[];
};

export function resolveRequirements(ids: readonly string[], jd: JdExtract, ledger: Ledger): RequirementView[];
export function isNotAssessed(sub: SubScore): boolean;              // bindings.length === 0 && gaps.length === 0
export const SUB_SCORE_LABELS: Record<keyof FitReport['subScores'], string>;
```

- `SUB_SCORE_LABELS` transcribes PRD §5.2's four names into English (§5.8): `technical: 'Technical stack match'`, `experienceDepth: 'Experience depth'`, `domain: 'Domain match'`, `evidenceStrength: 'Evidence strength'`.
- `resolveRequirements` preserves the input order (FIT-02 emits `jd.requirements` order) and is a pure function — no sorting, no dedupe, no mutation of arguments.
- `isNotAssessed` carries a comment naming FIT-02's D6 as the source of the predicate, so a future reader can trace it.

### 2.10 The four Fit-Report presentational components

None of them is `'use client'` and none imports anything server-only — they are rendered from **both** the server page and the client auto-runner, which is exactly why they must stay dependency-free.

**`hard-requirements-list.tsx`** — `({ items }: { items: HardRequirementCheck[] })`. Section heading "Hard requirements", rendered **first** on the page (PRD "置顶展示"). One row per item: `label` + a `Pass`/`Fail`/`Unknown` text token (D12). Empty array → D12's line.

**`sub-score-card.tsx`** — `({ label, sub, jd, ledger }: { label: string; sub: SubScore; jd: JdExtract; ledger: Ledger })`.
- `isNotAssessed(sub)` → render "Not assessed" + the explanatory clause (D7). **No number.**
- Otherwise: `{sub.score} / 100` (D11 — never `%`), then the drill-down (PRD "分数可下钻到证据"): `resolveRequirements(sub.bindings, jd, ledger)` rendered as supporting evidence (each `Binding`'s `evidence` and `projectId`, plus its `strength`), and `resolveRequirements(sub.gaps, jd, ledger)` rendered as gaps (each `Gap`'s `probe` and `play`).
- A `RequirementView` with `text === null` falls back to displaying the raw `requirementId` — it must not crash and must not render an empty bullet.
- Wrap the drill-down in `<details>` so a four-card page stays readable; the summary line must state the counts.

**`composite-score-banner.tsx`** —
```ts
export const FIT_DISCLAIMER = 'This is a heuristic match score, not a probability of being hired.';
export default function CompositeScoreBanner({ fit }: { fit: FitReport })
```
- Renders `{fit.compositeScore} / 100`, `fit.tier`, `fit.advice`, and **`FIT_DISCLAIMER` unconditionally** — no branch on score or tier may skip it (PRD's "不得暗示统计意义" is unconditional; acceptance item 3 pins it).
- When any of the four sub-scores `isNotAssessed`, append D7's "Overall is the average of the sub-scores that were assessed." line.
- **No `%` anywhere** (D11).

**`low-score-gap-callout.tsx`** — `({ fit, jd }: { fit: FitReport; jd: JdExtract })`.
- Renders **only** when `fit.tier === 'Stretch' || fit.tier === 'Long shot'`; returns `null` for `'Strong'`/`'Competitive'` (acceptance item 4). Compare against the tier values, **never** against a re-derived score threshold — `tierForScore` is FIT-02's function and duplicating its cut-points here would silently fork them.
- Heading (PRD "如果仍要投，优先补哪两个 gap"): "If you still apply, close these two gaps first" (or "…this gap first" for exactly one). Body: the first ≤ 2 of `fit.topGaps`, each with the requirement text (looked up in `jd`) plus `probe` and `play`.
- `probe === UNCOVERED_MARKER` → D13's substitute line instead of an empty `play`. Import `UNCOVERED_MARKER` from `@/lib/validation`; **never retype the string** (it contains an em dash).
- `fit.topGaps.length === 0` → return `null` (D13).

**`dropped-count-header.tsx`** —
```ts
export type DroppedItem = { label: string; detail: string };
export default function DroppedCountHeader(
  { droppedCount, items, partial = false }: { droppedCount: number; items: DroppedItem[]; partial?: boolean },
)
```
- `droppedCount === 0` → **return `null`**. No wrapper, no heading, nothing (acceptance item 5).
- `> 0` → a header line "`{droppedCount}` items were dropped" (singular "1 item was dropped") plus a `<details>` whose `<summary>` opens the list of `items` (PRD §5.7 "dropped > 0 表头计数、可展开被弃条目").
- `partial === true` → D8's note.
- **Ticket Deliverable 6 note, must be in the file header**: this component exists for the Fit tab only. `05-tailor` / `06-prep` **must not import it**; per-module duplication was the deliberate choice in `docs/prd/breakdown-plan.md` to keep file-scopes disjoint. If that duplication later hurts, raise it as a new open question there (ticket Feedback obligation #2) — do not reach across modules.

### 2.11 `app/(app)/jobs/[id]/_components/fit-report-view.tsx` (the single composition point)

```ts
export default function FitReportView({ jd, ledger, fit, dropped }: {
  jd: JdExtract; ledger: Ledger; fit: FitReport;
  dropped: { count: number; items: DroppedItem[]; partial: boolean };
}) { … }
```

Order, fixed by PRD §5.2/§5.7: `DroppedCountHeader` → `HardRequirementsList` ("置顶") → `CompositeScoreBanner` → `LowScoreGapCallout` → the four `SubScoreCard`s (using `SUB_SCORE_LABELS`).

Why this file exists at all (state it in the header): the server path and the client auto-runner path must render the **identical** report. Without one composition point they would each assemble the five components and could silently drift in order or content — and the drift would be invisible to every component-level test.

### 2.12 `app/(app)/jobs/[id]/_components/fit-auto-runner.tsx` — `'use client'` (Deliverable 7; D3/D4/D9/D10)

`export default function FitAutoRunner({ jobId }: { jobId: string })`.

- **Module-local Zod schema** (breakdown-plan §3: a module's new Zod types live in its own directory; and a **value** import of `PersistedJob` would drag `drizzle-orm` + `@/db/schema` into the client bundle — use `@/lib/schemas/pipeline` + `@/lib/schemas/persisted`, which are pure Zod):

  ```ts
  const FitRunResponse = z.object({
    jd: JdExtract,
    ledger: Ledger,
    fit: FitReport,
    dropped: z.object({
      count: z.number(),
      bindings: z.array(z.object({ item: Binding, reason: z.string() })),
      uncoveredRequirementIds: z.array(z.string()),
    }).optional(),   // absent on the GET /api/jobs/{id} recovery path (D10)
  });
  ```
  Defence in depth against a mangled body, exactly as `app/(app)/library/_lib/api.ts` validates its own responses — the server is the real trust boundary. A parse failure renders the error state, never a half-rendered report.

- **State machine**: `'running' | 'done' | 'error'`. Initial `'running'`.
- **Effect**, guarded by `const started = useRef(false)`:
  ```ts
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, []);
  ```
  D9: one mounted component issues at most one automatic POST, including under StrictMode's dev double-mount. **No retry, no backoff, no debounce.**
- `run()`: `fetch('/api/jobs/' + jobId + '/fit', { method: 'POST' })` — **no body, no `Content-Type`** (FIT-02 reads none).
  - `200` → `FitRunResponse.safeParse(body)`; success → `'done'` with `partial: false` and `items` built from `dropped.bindings` (label = the binding's `requirementId`, detail = `projectId` + `evidence` + `reason`) and `dropped.uncoveredRequirementIds`; `count = dropped.count`.
  - `409` **and** `body.error === 'already_fitted'` → `GET /api/jobs/' + jobId`, parse, `'done'` with **`partial: true`** and dropped data derived from `ledger.gaps.filter(g => g.probe === UNCOVERED_MARKER)` (D8/D10). If that GET also fails → `'error'`.
  - `409` with `error === 'no_library'` → `'error'` with a message pointing at `/library`.
  - `401` → session-expired message. `422` (`cross_failed`) → "We couldn't finish screening this job." `503` → temporarily-unavailable. `500`/other/network throw → generic.
- **Error state**: message + a **manual** "Try again" button that calls `run()` once per click and is disabled while in flight. Explicit user action only (D9).
- **Loading state**: `role="status"` with honest copy — "Generating your Fit Report… this usually takes about 30 seconds." (PRD §5.1's Fit p50 budget). Record in the comment that **PRD §5.1's "全程 streaming 展示进度" is NOT satisfied**: FIT-02's route returns one JSON body and adding streaming is a route-shape change outside this ticket's file-scope → §5 Q5.
- **No `console.*`.** The response carries the user's JD-derived ledger and library evidence.
- **No `localStorage`/`sessionStorage`/`IndexedDB`/cookie** persistence of any response content, and nothing in a URL or query string (PRD §8.1).

### 2.13 `app/(app)/jobs/[id]/page.tsx` — the Fit tab (Deliverable 7)

```ts
export const dynamic = 'force-dynamic';

export default async function JobFitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();
  const job = await getJob(userId, id);
  if (!job) notFound();

  if (job.fit === null || job.ledger === null) {
    return <FitAutoRunner jobId={id} />;
  }
  return <FitReportView jd={job.jd} ledger={job.ledger} fit={job.fit} dropped={…} />;
}
```

- The branch tests **both** `fit` and `ledger`. They are always written together (`attachLedgerAndFit` sets both in one statement), but the DB does not enforce the pairing, and TypeScript will demand the null check for `ledger` anyway. Treat "ledger without fit" as "not yet fitted" — the auto-runner will produce both.
- Server path `dropped`: `{ count: uncovered.length, items: uncovered.map(…), partial: true }` where `uncovered = job.ledger.gaps.filter(g => g.probe === UNCOVERED_MARKER)` (D8). Put this derivation in `fit-view-model.ts` as a named exported helper so `fit-auto-runner.tsx` reuses the identical logic on its 409 path — two copies of this rule will drift.
- Static import of `@/lib/db/queries/jobs` (verified import-safe). Build-guard test required.

### 2.14 Doc write-backs (mandatory — this is how a decision gets recorded rather than buried)

Append to `docs/prd/04-fit/tickets/FIT-03-jobs-list-fit-report-ui.md` a `## Changelog / Deviations` section (v0.1, dated, Builder-authored) recording at minimum:

1. **D1** — `listJobs` returns `JobListRow[]` (narrow projection), not `Job[]` as the ticket's Deliverable 3 literally says, with the three reasons.
2. **D8** — the dropped-count header is **partial** on any page load after the run that produced it, because FIT-02 does not persist dropped items. Name it as evidence for `04-fit/README.md`'s transparency requirement and as §5 Q3.
3. **D5/D15** — no active-tab highlight; Resume/Prep links 404 until `05`/`06` land, deliberately, to honour breakdown-plan §3's "不改 layout 本身" rule.
4. **§5 Q5** — PRD §5.1's streaming requirement is not met for Fit in v1.
5. **§5 Q1** — `/jobs` has no navigation entry point in the app shell.

**Do not edit `docs/prd/04-fit/README.md` in this ticket** unless a *decision* changes (none of the above overturns a decision-table row). If dogfooding produces the duplicate-call / abandoned-job evidence the ticket's Feedback obligation #1 describes, that write-back goes to the README's open-questions table — as a separate, deliberate act, not folded into this ticket silently.

### 2.15 What must not change

`pnpm test` must still report **≥ 63 files / 795 tests, all green**. No existing test may be edited to accommodate new code. The only pre-existing files touched are `lib/db/queries/jobs.ts` (append + one import-list addition) and `lib/db/queries/jobs.test.ts` (append). If anything else needs to change, stop and escalate.

---

## 3. Test plan

Conventions to follow exactly (all already in the repo):

- Component/page tests: first line `// @vitest-environment jsdom`, `afterEach(cleanup)`, `afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); })`.
- Server-module mocks use `vi.hoisted` for **stable references across `vi.resetModules()`** (`app/(app)/library/page.test.tsx`'s pattern).
- `next/navigation`'s `notFound` must be mocked **as a throwing function** — the real one throws, and a non-throwing mock lets execution continue past the guard and produces a green test for the wrong reason (`app/(admin)/admin/page.test.tsx` explains this).
- `window.location` stub for the navigation assertion: `app/(app)/settings/_components/delete-account-confirm.test.tsx`'s `Object.defineProperty` pattern.
- `fetch` is stubbed with `vi.stubGlobal('fetch', vi.fn(...))`; responses are `{ ok, status, json: async () => body }`.
- PGlite suites pass the timeout as the **third argument of `it()`** (`PGLITE_TEST_TIMEOUT_MS = 30_000`) — the only placement Vitest binds.
- `next/link` needs **no** mock and no router (§0.0 probe 1).

### Acceptance-item → test mapping (all six `[machine]` items)

| Ticket acceptance item | Test file · assertions |
|---|---|
| 1. `new-job-form` disabled + import-resume CTA when `hasLibrary === false` | `new-job-form.test.tsx`: renders the `/library` link; no enabled submit; **`fetch` never called** when the user tries to submit anyway. |
| 2. Prep tab non-navigable with the locked copy when `status !== 'interviewing'`, enabled otherwise | `layout.test.tsx`: for `screening`/`applied`/`closed` — `queryByRole('link', { name: /prep/i })` is `null` **and** `getByText(PREP_LOCKED_COPY)` is present; for `interviewing` — `getByRole('link', { name: /prep/i }).getAttribute('href') === '/jobs/<id>/prep'` **and** `queryByText(PREP_LOCKED_COPY)` is `null`. Ticket asks for two tests; write all four statuses — the enum has four values and the extra two are free. |
| 3. `composite-score-banner` always renders the disclaimer | `composite-score-banner.test.tsx`: `it.each` over all four tiers × {score 0, 100} asserts `getByText(FIT_DISCLAIMER)`. Plus: `container.textContent` contains **no `%`** (D11). |
| 4. `low-score-gap-callout` renders for `Stretch`/`Long shot`, not for `Strong`/`Competitive` | `low-score-gap-callout.test.tsx`: four tier fixtures. Plus: at most two gaps rendered when `topGaps.length === 3`; `probe`+`play` both present; the `UNCOVERED_MARKER` gap renders D13's substitute line and **no empty `play` bullet**; `topGaps: []` renders nothing. |
| 5. `dropped-count-header` renders nothing at 0, count + expandable list above 0 | `dropped-count-header.test.tsx`: `count 0` → `container.textContent === ''` (assert the whole container, not the absence of one string); `count 3` → the count text present, a `<details>` present, and clicking the `<summary>` sets `details.open === true` (§0.0 probe 3 — **do not** assert that collapsed content is invisible; jsdom still returns it); singular/plural wording; `partial: true` renders the D8 note and `partial: false` does not. |
| 6. Fit tab auto-triggers `POST /api/jobs/[id]/fit` when `fit` is absent and does **not** when present | `app/(app)/jobs/[id]/page.test.tsx`: with `getJob` → fit-less job, `await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))` and the call is `['/api/jobs/job-1/fit', { method: 'POST' }]`; with `getJob` → complete job, render, flush effects, `expect(fetchMock).not.toHaveBeenCalled()` **and** the report content is on screen. |
| 7. `pnpm test` green | Full-suite run, ≥ baseline counts. |

### Per-file test inventory (beyond the acceptance items)

**`lib/db/queries/jobs.test.ts`** (append; PGlite, node env, existing harness) — `listJobs`:
- returns **only** the caller's rows (seed two users, assert cross-user isolation) — PRD §8.3;
- ordered `createdAt DESC` (insert with explicit distinct `createdAt` values, since `$defaultFn` timestamps in one test can collide at ms resolution — **set `createdAt` explicitly**, do not rely on insertion order);
- `[]` for a user with no jobs;
- the returned objects have **exactly** the five `JobListRow` keys — assert `Object.keys(row).sort()` and that `jdRaw`/`jd`/`ledger`/`fit` are `undefined`. This is the test that keeps D1 true against a future "just select \*" edit;
- returns a fit-less job (created by `createJob` alone) — the transient FIT-01/FIT-02 state must appear in the list.

**`app/(app)/jobs/page.test.tsx`** (jsdom; mocks `@/lib/auth/session`, `@/lib/db/queries/jobs`, `@/lib/db/queries/library`):
- both reads scoped to the **session** userId;
- one `<article>` per fixture row; all four status labels present (from `JOB_LIST_FIXTURE`);
- `hasLibrary: true` → the paste form is rendered; `false` → the `/library` CTA and no usable form;
- zero jobs → the empty-state line;
- **no JD text leaks**: `container.textContent` contains none of the fixture's JD strings;
- an `UnauthorizedError` from `requireUserId` propagates **and** neither query runs;
- a throwing `hasLibrary` (drifted row) **propagates** — it must not degrade into the "no library" CTA;
- `mod.dynamic === 'force-dynamic'`;
- **build guard**: `vi.stubEnv('DATABASE_URL', ''); vi.resetModules(); vi.doUnmock('@/lib/db/queries/jobs'); vi.doUnmock('@/lib/db/queries/library');` → `await expect(import('@/app/(app)/jobs/page')).resolves.toBeDefined()`, then the sanity check `await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/)`. Keep `@/lib/auth/session` **mocked** (LIB-03's test explains why un-mocking it breaks under jsdom for unrelated reasons).

**`app/(app)/jobs/_components/status-chip.test.tsx`**: each of the four statuses renders its label; the label is real text (not conveyed by colour/attribute alone).

**`app/(app)/jobs/_components/new-job-form.test.tsx`** (beyond acceptance item 1):
- happy path posts to `/api/jobs` with `Content-Type: application/json` and body **exactly** `{ jdRaw, company, role }` — assert no `userId` key;
- `201` → `window.location.href === '/jobs/<id>'` (stubbed location);
- `201` with no `id` → generic error, **no navigation**;
- **double-click issues exactly ONE fetch** (cost control — a second submit is a second paid READ + a second `fit` quota unit);
- empty/whitespace fields and an over-cap `jdRaw` → `role="alert"`, **zero** fetch calls;
- `403 no_library` → the import CTA; `429` → the quota message; `422` → the read-failed message; `400` → the `issues` surfaced; `401` → session expired; `503` → unavailable; network throw → generic — and in **every** case the form stays usable and the typed values are preserved;
- **never logs**: `console.log`/`console.error` spies not called (LIB-03's `upload-form.test.tsx` has this verbatim).

**`app/(app)/jobs/[id]/layout.test.tsx`** (beyond acceptance item 2):
- renders company, role and the status chip;
- `getJob` → `null` → `notFound()` called (throwing mock) and **no tab nav rendered**;
- `getJob` called with the **session** userId and the awaited `params.id`;
- a throwing `getJob` (row drift) propagates rather than 404-ing;
- Fit and Resume links have the right `href`s;
- `mod.dynamic === 'force-dynamic'`; build guard as above.

**`app/(app)/jobs/[id]/_components/fit-view-model.test.ts`** (node env, no jsdom, no mocks):
- `resolveRequirements` preserves input order; resolves text and weight from `jd`; collects **all** bindings for a requirement (the multi-binding case); returns `text: null` for an id absent from `jd`;
- `isNotAssessed` true only for `{score:0,bindings:[],gaps:[]}`; false for a bucket with gaps but no bindings (**this is the case §5 Q2 is about — pin the behaviour so the disagreement is visible, not accidental**);
- the uncovered-gap derivation helper counts only gaps whose `probe === UNCOVERED_MARKER`;
- **fixture integrity**: `JD_FIXTURE`, `LEDGER_FIXTURE`, `fitFixture()` all `safeParse` green against FND-03's schemas.

**`hard-requirements-list.test.tsx`**: one row per item; each status rendered as text; empty array renders D12's line.

**`sub-score-card.test.tsx`**: `72 / 100` format and **no `%`**; not-assessed renders "Not assessed" and **no `0`**; drill-down shows each binding's `evidence`, `projectId` and `strength`, and each gap's `probe` and `play`; an unknown `requirementId` renders the raw id and does not throw.

**`fit-auto-runner.test.tsx`**:
- fires exactly **one** POST on mount, with **no body and no `Content-Type`**;
- `200` → the report renders, including the dropped header with `dropped.count` and the discarded bindings **and no "partial" note**;
- `409 already_fitted` → **no error shown**; a `GET /api/jobs/<id>` follows; the report renders with the **partial** note and the uncovered-gap count (D8/D10);
- `409 no_library` → error mentioning the library;
- `422`/`503`/`401`/network throw → their own messages, each with a "Try again" button;
- clicking "Try again" issues exactly one more POST, and is disabled while in flight;
- a `200` whose body fails `FitRunResponse` → error state, **never** a partially rendered report;
- re-rendering the same element does **not** issue a second POST (the D9 ref guard);
- `role="status"` loading copy present while in flight and gone afterwards;
- **never logs**.

**`app/(app)/jobs/[id]/page.test.tsx`** (beyond acceptance item 6): `notFound()` on a missing job; `getJob` scoped to the session userId; a job whose `ledger` is null but `fit` is not (representable in the DB) takes the auto-runner branch rather than crashing; `dynamic === 'force-dynamic'`; build guard.

### Honesty note (must appear in the test files' headers)

No test here proves the Fit Report is **correct** — every `fit`/`ledger` in these tests is a fixture this repo wrote. These tests prove wiring, gating, and copy. Model quality is `pnpm eval`'s job (Q1/Q2), and legibility/tone is the ticket's `[human]` acceptance item (Horace's P2 dogfood pass). Do not report a green run here as "the Fit Report is good".

---

## 4. Risks and edge cases

**Security / cross-user (the Reviewer will probe these first)**

- **R1 — every read is session-scoped.** `listJobs(userId)` and `getJob(userId, id)` take the id from `requireUserId()` only; no component and no fetch call ever sends a `userId`. Another user's job id yields `null` → `notFound()`, byte-identical to a non-existent id (no existence oracle). Pinned by tests in both page suites and in the query suite.
- **R2 — the `id` path parameter is fully attacker-controlled** and flows straight into `getJob` and into the two fetch URLs. It is bound as a query parameter by Drizzle (no SQL injection surface) and is interpolated into a **relative same-origin** URL path. It must never be interpolated into an `href` that could leave the origin, and it must never be rendered as HTML (React escapes it; do not add `dangerouslySetInnerHTML` anywhere in this ticket).
- **R3 — the no-library gate is UX only on the client.** FIT-01's server-side 403 is the real control. Anyone can call `POST /api/jobs` directly. The plan's `403 no_library` branch exists because the client gate can be stale, not because it is a boundary.
- **R4 — the Prep tab lock is UX only.** Typing `/jobs/<id>/prep` bypasses it entirely (today it 404s; after PRP-03 it must enforce server-side). The ticket says this explicitly; the code comment must too, so nobody later deletes PRP-03's own check on the grounds that "the tab is locked".
- **R5 — PII in logs and storage.** No `console.*` in any file in this ticket; no browser storage of any response; no JD text in a URL. The Jobs list structurally cannot leak JD text because `JobListRow` has no JD field (D1). Tests pin the logging rule and the list-page leak.

**Concurrency (the second thing the Reviewer will probe)**

- **R6 — duplicate paid CROSS calls.** Three distinct layers, and they must not be conflated:
  1. *Same component instance, StrictMode dev double-mount* — closed by D9's `useRef` guard. Testable.
  2. *Two tabs / a fast back-and-forward on the same fit-less job* — **open**. Both can POST; FIT-02's `already_fitted` guard turns the loser into a 409 in the common case, but FIT-02's own header documents the residual race where both read `fit === null` and **both pay** (~1 extra call/job). **Not fixable from this ticket** — it needs a claim column or an advisory lock in `db/schema.ts` (FND-05's file-scope) and Horace's sign-off. Handled gracefully (D10: the 409 renders the report, not an error), reported at §5 Q4, never patched over with client-side debouncing (ticket Feedback obligation #1 forbids exactly that).
  3. *User closes the tab mid-call* — the job is left `fit === null` forever, having already consumed a `fit` quota unit (FIT-01's known risk R4). The next visit auto-triggers again and pays again. Also §5 Q4.
- **R7 — the abandoned-job list entry.** A fit-less job appears in the list identically to a completed one; the user only discovers the difference by clicking (and paying). Deliberate: adding a "not yet screened" badge would require reading `fit` in `listJobs`, which reverses D1. Recorded as a deliberate exclusion, and it is the visible symptom of R6.3 — worth mentioning in the dogfood notes.
- **R8 — last-write-wins on status.** `updateJobStatus` has no version column (FIT-01, accepted). This ticket only **reads** status, so it inherits the staleness: a status changed in another tab is not reflected until reload. No new exposure.

**Correctness / rendering**

- **E1 — "not assessed" vs `0`.** Covered by D7. The failure mode if skipped: a JD with no `domain` requirement displays "Domain match 0/100", which reads as a verdict on the candidate. This is the single most likely legibility complaint from the `[human]` acceptance item.
- **E2 — the composite does not equal the mean of the four displayed numbers** whenever a bucket is excluded. Covered by D7's extra line. See §5 Q2 for the sharper sub-case.
- **E3 — a zero-requirement JD.** Legal per FND-03 (`requirements` has only `.max(11)`), and FIT-02 short-circuits it to `compositeScore 0` / `'Long shot'` with all buckets empty. Rendering: all four cards "Not assessed", the banner shows 0/100 + Long shot, the low-score callout renders **nothing** (`topGaps` empty, D13). The page must not crash and must not divide by zero anywhere. Add this fixture to `composite-score-banner.test.tsx` or `fit-report-view`'s coverage.
- **E4 — hallucinated `requirementId`s.** FIT-02 counts them in `anomalies` but never filters them, so a `SubScore.bindings` entry can reference an id absent from `jd`. `resolveRequirements` returns `text: null`; the card renders the raw id. Do **not** silently drop it (PRD "宁可暴露不完整").
- **E5 — injected `uncovered — rerun` gaps have `play: ''`** and are eligible for `topGaps` (FIT-02 D8). D13 handles it. The trap is rendering "Your bridge: " followed by nothing.
- **E6 — date formatting.** `createdAt` is epoch-ms. `toLocaleDateString()` is **locale- and timezone-dependent**, which makes an assertion on it flaky across machines and CI. Either render a fixed format derived from `new Date(ms).toISOString().slice(0, 10)`, or do not assert the exact string in tests. Choose one and say which in the code comment. No date library.
- **E7 — `'Long shot'` contains a space.** Comparisons must use the literal enum value; a `tier.toLowerCase().replace(' ','')` normalisation anywhere is a latent bug.
- **E8 — em dash in `UNCOVERED_MARKER`.** Import the constant. A retyped `'uncovered - rerun'` (hyphen) compiles, passes review at a glance, and silently never matches.
- **E9 — `<details>` in jsdom.** §0.0 probe 3. Assert `details.open`, not visibility.
- **E10 — `notFound()` inside a `try`.** It works by throwing. If any code in `layout.tsx`/`page.tsx` wraps the `getJob` call **and** the `notFound()` in one `try/catch`, the catch swallows the 404 signal. Keep `notFound()` outside any `try`.
- **E11 — `params` is a Promise.** Both the layout and the page must `await` it. A non-Promise type passes `tsc` in isolation and fails `next build`'s generated route-type check in CI — i.e. it fails **late**, after the tests are green.
- **E12 — client-bundle contamination.** Do not `import { PersistedJob } from '@/lib/db/queries/jobs'` as a **value** in any component: it pulls `drizzle-orm` and `@/db/schema` into the client bundle. `import type` is fine (fully erased). Same rule for `@/lib/db/queries/library`.
- **E13 — `'use client'` placement.** Only `new-job-form.tsx` and `fit-auto-runner.tsx` get the directive. Marking the presentational components `'use client'` is not *wrong* but is unnecessary and pushes them into the bundle on the server-rendered path; marking `fit-report-view.tsx` as client would defeat the point of the server path entirely.
- **E14 — no `error.tsx` boundary exists in this repo.** A throw from `getJob`/`hasLibrary` (row drift) surfaces as Next's default error page. That is the intended loud failure (LIB-03's precedent), not something to fix here by adding a boundary — an `app/(app)/error.tsx` would be a shell-level file outside this ticket's scope.

---

## 5. Open questions

Each has a named owner. **None of them blocks building this ticket** — the plan specifies a concrete behaviour for every one. They are the items the Reviewer should confirm were surfaced rather than silently decided.

| # | Question | Decided-for-now behaviour | Owner |
|---|---|---|---|
| **Q1** | **`/jobs` has no navigation entry point.** `app/layout.tsx`'s header links only "Groundwork" and sign-out, and `app/(app)/home/page.tsx` still says "Library and Jobs pages land in later modules". Both are **01-foundation's files** and outside this ticket's file-scope. Without an edit there, the page Horace is meant to dogfood at P2 is reachable only by typing the URL. `03-library` shipped `/library` with the identical gap. | Ship without a nav link; record it in the ticket Changelog and flag it for the P2 dogfood pass. | Horace (product) — decide whether a follow-up ticket (owned by `01-foundation` or `07-platform-launch`) adds an app-shell nav for `/library` + `/jobs`. |
| **Q2** | **`evidenceStrength` with zero bindings**: FIT-02's scorer gives it `weightSum === 0` and **excludes it from the composite**, but its `gaps` array is non-empty (every unbound requirement is listed there, informationally). So D7's `isNotAssessed` predicate — which FIT-02's own comment prescribes — reports it as **assessed**, and the UI shows a real `0` for a bucket the composite ignored. | Display the `0` (it is honest: the JD asked, the library had nothing) and rely on D7's "average of the sub-scores that were assessed" line to keep the arithmetic honest. Pinned by a `fit-view-model.test.ts` case so the disagreement is visible rather than accidental. | Horace (product) + whoever next touches `lib/scoring/score.ts` — the alternative is for the scorer to expose "assessed" explicitly instead of leaving FIT-03 to infer it. Do not change the scorer from this ticket. |
| **Q3** | **Dropped items are not persistable.** FIT-02's `dropped.bindings` exists only in the response that produced it; `jobs` has no column for it. PRD §5.5 layer 1 requires "前端可查看被弃原始条目" — which this ticket can honour only on the first render. | D8: show the recoverable count (layer-2 injections) with an explicit note that the raw discarded entries are gone. | Horace (product) — persisting them means a new column or table (**FND-05 file-scope**) and a decision about retention of model-discarded content. |
| **Q4** | **Auto-trigger fragility** (the ticket's Feedback obligation #1, verbatim): duplicate calls across tabs/navigations, and a job left permanently `fit`-less if the user closes the tab mid-call — both after the `fit` quota was already charged at job creation. | D9 closes the single-instance case only; the rest is handled gracefully (D10) and **reported, not patched**. | Horace (product) + `04-fit/README.md`'s open questions table — this is direct evidence on open question #2 (the atomic-"Fit"-operation architecture) and the ADR-0001 candidate in §6. |
| **Q5** | **PRD §5.1's "全程 streaming 展示进度" is not satisfied for Fit.** FIT-02's route returns one JSON body; a progress stream would change that route's shape, which is outside this ticket's file-scope. | A `role="status"` line with the honest p50 expectation ("about 30 seconds"). LIB-03 recorded the same shortfall for PARSE, where PRD did **not** name streaming; here PRD **does** name it, so this is a genuine, larger gap. | Horace (product) — accept the non-streaming Fit for v1, or schedule a route-shape change in a follow-up ticket. |
| **Q6** | **Resume/Prep tabs 404 until `05`/`06` ship** (D15). | Ship the links; do not add placeholders (breakdown-plan §3 forbids the later layout edit). | Architect/Horace — accepted as a time-boxed inter-module gap; flagged so the Reviewer does not file it as a defect. |

---

## 6. ADR candidate (flagged, **not** decided or implemented here)

**ADR-0001 — "Fit" is one user-facing operation delivered as two server calls, with quota charged once at job creation.**

Already flagged by `docs/prd/breakdown-plan.md` §6 #8 and `docs/prd/04-fit/README.md` open question #2, and reinforced by FIT-02's `already_fitted` gate (the cost half of the same decision). **FIT-03 is where that architecture becomes visible to the user** — as the "Generating your Fit Report…" intermediate state, the auto-trigger on load, and the abandoned-job case (R6.3). This ticket therefore produces the first real evidence for or against it.

Do **not** write the ADR in this ticket. Record the operational evidence in the ticket Changelog (§2.14) and, if the failure modes in Q4 actually occur during dogfooding, in `04-fit/README.md`'s open-questions table. `docs/adr/` stays empty until Horace signs off on writing ADR-0001.

---

## 7. Build sequence (suggested order; each step ends green)

Each step is independently testable, so a bounce lands on a small surface rather than the whole ticket.

1. **Branch**: `git checkout -b ticket/FIT-03` from `f513f09`. Confirm `corepack pnpm test` is green at **63 files / 795 tests** before writing a line.
2. **`lib/db/queries/jobs.ts` append + `jobs.test.ts` append** (§2.1). Run the single file; it is PGlite-backed and fast to iterate on. This step must not disturb any existing test in that file.
3. **`_fixtures/job-fixtures.ts` + `_components/fit-view-model.ts` + `fit-view-model.test.ts`** (§2.2, §2.9). Pure, node environment, no React — the fastest feedback loop, and the fixture-integrity assertions here protect every later step.
4. **The four presentational components + their tests** (§2.10), in order: `hard-requirements-list`, `composite-score-banner`, `low-score-gap-callout`, `dropped-count-header`, then `sub-score-card`. **Acceptance items 3, 4 and 5 are all satisfied at the end of this step** — verify them explicitly before moving on.
5. **`fit-report-view.tsx`** (§2.11). No own test; it is exercised from step 7.
6. **`status-chip` + `job-list-item` + `new-job-form` + `app/(app)/jobs/page.tsx` and their tests** (§2.3–§2.6). **Acceptance item 1 lands here.**
7. **`job-tabs` + `app/(app)/jobs/[id]/layout.tsx` + `layout.test.tsx`** (§2.7, §2.8). **Acceptance item 2 lands here.**
8. **`fit-auto-runner` + `app/(app)/jobs/[id]/page.tsx` and both tests** (§2.12, §2.13). **Acceptance item 6 lands here.**
9. **Full green**: `corepack pnpm test` (≥ 63 files / 795 tests, all green), `corepack pnpm lint` clean, and **`corepack pnpm build` with `DATABASE_URL` unset** — the last one is the end-to-end proof of the build-time-safety rule and of the Next 15 `params: Promise<…>` route types. A green test suite does **not** imply a green build; run it.
10. **Doc write-back** (§2.14), then commit. Do not merge, do not self-clear — the Reviewer runs in a fresh context on the diff.

**Manual smoke (optional, needs real credentials Horace holds — do not block on it):** `corepack pnpm dev` with a real `DATABASE_URL` + `ANTHROPIC_API_KEY`, sign in, import a library, paste a JD on `/jobs`, and confirm the single click produces a Fit Report within ~30 s. That is the only way to observe the StrictMode double-mount behaviour and the real two-call latency; if you cannot run it, say so plainly in the handoff rather than implying it passed.
