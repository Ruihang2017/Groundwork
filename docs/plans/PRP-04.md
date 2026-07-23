# Implementation plan — PRP-04: Brief content UI

Ticket: [docs/prd/06-prep/tickets/PRP-04-brief-content-ui.md](../prd/06-prep/tickets/PRP-04-brief-content-ui.md)
Sub-PRD: [docs/prd/06-prep/README.md](../prd/06-prep/README.md)
Master spec: [docs/PRD.md](../PRD.md) §1 F3 ("面试是在 gap 上被决定的") · §2 P3 ("Degrade, don't block") · §2 P4 ("重操作只在用户显式进入下一阶段时发生") · §4 S4 ("生成简报 … 面前按 angle 排练") · §5.1 (RESEARCH / REHEARSE rows) · §5.4 (Brief spec + unlock condition) · §5.5 layer 1 (referential-integrity dropped-count transparency) · §5.7 (产出展示: "dropped > 0 表头计数、可展开被弃条目；research fail 标红但简报照常渲染") · §5.8 ("UI 英文") · §8.1 (privacy: nothing sensitive to storage/logs) · §8.3 (session-scoped queries) · §12 ("搜索结果污染" — intel is web-sourced, best-effort)

Upstream tickets whose merged code this builds on (all merged into `main` @ `b32a7b6`, all read directly for this plan):
- [PRP-03](../prd/06-prep/tickets/PRP-03-prep-tab-shell.md) → `app/(app)/jobs/[id]/prep/page.tsx` (**this ticket extends its unlocked branch — the locked branch is preserved verbatim**), `_components/lock-screen.tsx`, `_components/status-transition-button.tsx`, `prep/page.test.tsx`. PRP-03 Feedback obligation #2 explicitly authorizes this same-file, same-lane extension.
- [PRP-02](../prd/06-prep/tickets/PRP-02-rehearse-route.md) → `app/api/jobs/[id]/rehearse/route.ts` (**call only** — the client `POST`s it), `lib/db/queries/briefs.ts` (`getBrief` — the server read path; and the `PersistedRehearse`/`PersistedBrief` relaxed shape this ticket's client read path must mirror — **D4**).
- [PRP-01](../prd/06-prep/tickets/PRP-01-research-route.md) → `app/api/jobs/[id]/research/route.ts` (**call only**). Its wire contract + degrade posture drive the orchestration (**D2**).
- [FND-03](../prd/01-foundation/tickets/FND-03-pipeline-payload-schemas.md) → `lib/schemas/pipeline.ts` — `Intel`, `IntelRecentItem`, `Rehearse`, `RehearseQuestion`, `Ledger`, `Gap`, `Binding`.
- [FND-04](../prd/01-foundation/tickets/FND-04-persisted-entity-schemas.md) → `lib/schemas/persisted.ts` — `Brief`.
- [FND-02](../prd/01-foundation/tickets/FND-02-library-entity-schemas.md) → `lib/schemas/entities.ts` — `Library`, `Project`.
- [FIT-01](../prd/04-fit/tickets/FIT-01-job-creation-status-route.md) → `lib/db/queries/jobs.ts` (`getJob`, `PersistedJob`). [LIB-02] → `lib/db/queries/library.ts` (`getLibrary`).
- [FND-08](../prd/01-foundation/tickets/FND-08-authjs-session.md) → `lib/auth/session.ts` (`requireUserId`). [FND-09] → `@testing-library/react` + jsdom test setup.

**Cross-ticket analogs — READ THESE before writing; this ticket mirrors them almost line-for-line:**
- `app/(app)/jobs/[id]/_components/fit-auto-runner.tsx` + `.test.tsx` — **the auto-fire-on-mount, single-flight, render-from-response, manual-retry client component this ticket's `brief-generator.tsx` is modelled on** (but with a TWO-call sequence).
- `app/(app)/jobs/[id]/_components/fit-report-view.tsx` — **the "one composition point, NOT a client component, rendered by both the server page and the client runner" pattern `brief-view.tsx` copies.**
- `app/(app)/jobs/[id]/resume/page.tsx` + `resume/_components/tailor-generator.tsx` + `resume/_lib/project-names.ts` + `resume/_components/dropped-count-header.tsx` (+ its test) — the persisted-entity reload path, the module-local response Zod schema, the projectId→name helper, and **the `dropped-count-header` WITHOUT a `partial` flag** (D7).
- `app/(app)/jobs/_fixtures/job-fixtures.ts` + `resume/_fixtures/tailored-fixtures.ts` — the hand-written, type-only-import fixture conventions `_fixtures/brief-fixtures.ts` follows.

ADRs: `docs/adr/` holds only `.gitkeep`. This plan creates **no** ADR file and raises **no new** ADR candidate (§6). It does, however, **land the read-path consequence of ADR-A** (the persisted-rehearse-may-be-<5 decision PRP-02 pre-registered) — see **D4**.

Base commit: `b32a7b6` on `main` (`merge: [PRP-03] ticket/PRP-03 -> main (pipeline CLEAR)`), working tree clean at planning time (2026-07-24). Branch per repo convention: `ticket/PRP-04`, cut fresh from `main`.

> **AI-generated draft.** Everything the Builder produces from this plan is a draft and must be reviewed before merge — that is exactly what the `/review-ticket` stage is for. This plan writes no production code.

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone. Every "verified" claim below was checked by direct file inspection at planning time — confirm cheaply if you like, do not re-derive.

**Standing environment rules on this machine** (carried from `docs/plans/PRP-03.md` §0, re-verified this session):

- Invoke pnpm as **`corepack pnpm ...`** — bare `pnpm` is not on the Bash tool's `PATH`.
- Every Bash invocation prints a harmless first line `/c/Users/HoraceHou/.bash_profile: line 1: $'\377\376source': command not found`. That is the user's UTF-16-BOM'd `~/.bash_profile`, **not** a repo file. Ignore it.
- `.gitattributes` is `* text=auto eol=lf` — new files are materialized LF. Do not add CRLF.
- Paths in this repo contain `(app)` and `[id]` segments. In Bash, **quote every such path** (`"app/(app)/jobs/[id]/prep/page.tsx"`), or globbing/grouping mangles it.

---

## 0. Repo-state check performed for this plan (verified 2026-07-24 at `b32a7b6`)

**Baseline `corepack pnpm test`: the last recorded green run is 95 files / 1195 tests** (PRP-03 Builder writeback). Record your OWN baseline on your fresh branch before touching anything; your final run must be ≥ it and still green. (Not re-run at planning time — the full suite is slow; the count is the documented baseline, not a guess about behavior.)

### 0.0 Facts verified by direct inspection (do not re-litigate — each costs a bounce if guessed wrong)

- **`app/(app)/jobs/[id]/prep/` exists** and currently holds exactly: `page.tsx` (PRP-03), `page.test.tsx`, `_components/lock-screen.tsx` (+ test), `_components/status-transition-button.tsx` (+ test). **No `_components/intel-card.tsx` etc., no `_lib/`, no `_fixtures/`.** This ticket adds them.
- **`prep/page.tsx` (PRP-03) is the file to extend.** Its current unlocked branch (`job.status === 'interviewing'`) is a placeholder: `<section aria-labelledby="prep-heading"><h2 id="prep-heading">Interview prep</h2><p>Your interview brief will appear here.</p></section>`. Its **locked branch** (`job.status !== 'interviewing'` → `<LockScreen jobId={id} />`) and its guard scaffolding (`requireUserId`, `getJob`, `notFound()`, `export const dynamic = 'force-dynamic'`, `await params`) **must be preserved byte-for-byte in behavior** (PRP-03 Feedback obligation #2). This ticket only replaces the placeholder block and adds two reads.
- **`getBrief(userId, jobId): Promise<PersistedBrief | null>`** (`lib/db/queries/briefs.ts`, PRP-02) — join-through-`jobs` ownership scoping; `null` = "no brief" / "unknown job" / "another user's job" (indistinguishable, PRD §8.3); **throws** on stored-row drift. **Returns the module-local RELAXED `PersistedBrief`** whose `rehearse.questions` is `.max(5)` (NOT `.length(5)`), because referential integrity may have dropped a question (PRP-02 D5). Its header states verbatim: *"Exported for PRP-04 … PRP-04 must consume THIS relaxed value directly and must NOT re-parse it against the strict FND-03 `Brief`."* Import-safe with `DATABASE_URL` unset (lazy `dbIndex()`).
- **`getLibrary(userId): Promise<Library | null>`** (`lib/db/queries/library.ts`, LIB-02) — user-scoped, loud-fail-on-drift, import-safe. Used to build the projectId→name map.
- **`getJob` / `PersistedJob`** — `job.ledger` is `Ledger | null` and `job.jd` is `JdExtract` (both on `PersistedJob`); `job.status` is `'screening'|'applied'|'interviewing'|'closed'`. A job can be `status: 'interviewing'` **with `ledger === null`** (PRP-03's button flips status regardless of whether Fit ran) — see **R3 / D2**.
- **RESEARCH wire contract** (`app/api/jobs/[id]/research/route.ts` header, transcribed — the client codes against this, branch on the `error` STRING):
  - `POST /api/jobs/{id}/research` — **NO request body read** (send `{ method: 'POST' }` only, no `Content-Type`, no body — a test in the route pins that the body is ignored).
  - `200 { intel: <Intel>, failed: false }` · `200 { intel: null, failed: true }` (degraded — PRD §2 P3) · `401 {error:'Unauthorized'}` · `403 {error:'not_interviewing'}` · `404 {error:'not_found'}` · `409 {error:'fit_not_ready'}` · `429 {error:'quota_exceeded', op:'prep', resetAt:number}` · `500 {error:'job_read_failed'}` · `503 {error:'global_breaker_tripped'|'quota_check_failed'}`.
  - **The `prep` quota (3/day) is charged by THIS call**, covering the whole two-call Prep operation. REHEARSE charges nothing.
  - Its header's **SINGLE-FLIGHT INSTRUCTION TO PRP-03/PRP-04**: *"issue AT MOST ONE automatic RESEARCH per mount behind a `useRef` single-flight guard, and offer only a MANUAL 'try again'."* (D6.)
- **REHEARSE wire contract** (`app/api/jobs/[id]/rehearse/route.ts` header, transcribed):
  - `POST /api/jobs/{id}/rehearse` — body **`{ "intel": <Intel> | null }`** (`Content-Type: application/json`). The `intel` KEY must be present (may be `null`).
  - `200 <Brief> + dropped` = `{ jobId, intel: <Intel>|null, rehearse: <Rehearse, 0..5 questions>, createdAt, updatedAt, dropped: { count: number, questions: Array<{ item: RehearseQuestion; reason: string }> } }`, `Cache-Control: no-store`. **`dropped` is NOT persisted — it exists ONLY in this response** (render-once; lost on refresh — Deliverable 6 / D3).
  - `400 {error:'invalid_body'}` · `401` · `403 {error:'not_interviewing'}` · `404 {error:'not_found'}` · `409 {error:'fit_not_ready'}` · `409 {error:'no_library'}` · `422 {error:'rehearse_failed'}` (STRICT — no degrade) · `500 {error:'job_read_failed'|'library_read_failed'|'brief_write_failed'}` · `503 {error:'global_breaker_tripped'}`.
  - Its header's **SINGLE-FLIGHT INSTRUCTION**: one automatic call per mount, manual retry only; it OVERWRITES with no replay guard and charges nothing → an auto-retry loop is unbounded paid calls (D6).
- **Schemas** (`lib/schemas/pipeline.ts`, verified): `Intel = { snapshot: string; recent: {headline,soWhat}[].max(3); engineeringSignals: string[].max(3); talkingPoints: string[].max(3) }` — **no `.min(1)` anywhere; empty arrays are the valid "查无实据" state.** `RehearseQuestion = { projectId: string; question: string; trap: string.min(1) }`. `Rehearse = { questions: RehearseQuestion[].length(5); askThem: string[].length(3); positioning: string }`. `Brief = { jobId, intel: Intel.nullable(), rehearse: Rehearse, createdAt, updatedAt }` (persisted.ts). `Intel`/`Brief` are **pure Zod** (no drizzle) — safe to import into a client component for a defensive response schema (as `fit-auto-runner.tsx`/`tailor-generator.tsx` do).
- **`Library` / `Project`** (`lib/schemas/entities.ts`): `Project = { id, name, stage, role, stack[], summary, metrics[], tags[] }`; `Library = { profile, projects: Project[] }`.
- **The two `dropped-count-header.tsx` copies already in the repo**: FIT-03's (`[id]/_components/`) HAS a `partial` flag; TLR-02's (`resume/_components/`) does NOT. **This ticket copies the TLR-02 shape** (no `partial`) — D7. Both define a local `DroppedItem = { label: string; detail: string }` and render nothing at `droppedCount === 0`, a bold count + an expandable `<details>` of items at `> 0`, item text as TEXT (never HTML). E9 (jsdom): a closed `<details>` still exposes its content to Testing Library, so its test asserts `details.open`, never visibility.
- **Test harness**: `vitest.config.ts` `include` covers `app/**/*.test.{ts,tsx}` — **no config change**. Global `environment: 'node'`; component tests opt into jsdom with a **file-top `// @vitest-environment jsdom`** comment. **There is NO `vitest.setup.ts`/`setupFiles`** (glob-confirmed: no `vitest.setup.*`) — jest-dom matchers are **not** available. Assert with raw `@testing-library` + vitest primitives only: `screen.getByRole`, `screen.queryBy*(...) === null` / `.toBeNull()`, `.toBeTruthy()`, `(el as HTMLButtonElement).disabled`, `.textContent`, `container.textContent`, `fireEvent`, `waitFor`. **Do NOT write `.toBeInTheDocument()` / `.toHaveTextContent()`** — they will not compile.
- **`package.json` / `tsconfig` / `eslint.config` / `next.config.mjs` need NO change** — no new dependency (`useEffect`/`useRef`/`useState` and `fetch` are all already in use). **ESLint import ordering IS enforced**: `'use client'` first (client files), blank line, external-package imports (alphabetized), blank line, `@/…` imports (alphabetized — `@/app/…` before `@/lib/…`), blank line, header comment. Match the surrounding files exactly or `corepack pnpm lint` bounces.
- **Next 15.5.20 / React 19.2**: `page.tsx`'s `params` is a Promise (already `await`ed by PRP-03 — keep it). `next.config.mjs` is `{}` ⇒ `reactStrictMode` defaults **true** (dev double-mount) — this is why `brief-generator.tsx`'s auto-fire needs an `autoStarted` ref (exactly as `fit-auto-runner.tsx` documents).
- **Serial-safety**: no `ticket/PRP-04` branch exists; `docs/plans/PRP-04.md` does not exist; no file under `prep/_components/` beyond PRP-03's four exists. This is the **last ticket in `06-prep`** (nothing else builds against `prep/**`). If any of that changed at build time, stop and escalate.

---

## 1. Scope

### In scope

**The one behavioural change to an existing file** — `app/(app)/jobs/[id]/prep/page.tsx`: the `job.status === 'interviewing'` (unlocked) branch stops returning the placeholder and instead reads the persisted `Brief` + the `Library`, then branches (D15):

- **`Brief` exists** → render `<BriefView …>` server-side (the reload path — no generation, no fetch; acceptance item 5).
- **no `Brief`** → render `<BriefGenerator …>` (the client component that runs RESEARCH → REHEARSE and renders the brief from the REHEARSE response — acceptance items 1, 2).

The **locked branch and all guard scaffolding are preserved verbatim** (PRP-03 Feedback obligation #2).

**New files this ticket owns (all under `app/(app)/jobs/[id]/prep/`, this module's exclusive directory):**

Deliverable components (named in the ticket File-scope):
- `_components/research-fail-banner.tsx` (Deliverable 1)
- `_components/intel-card.tsx` (Deliverable 2)
- `_components/question-list.tsx` (Deliverable 3)
- `_components/ask-them-list.tsx` (Deliverable 4)
- `_components/positioning-summary.tsx` (Deliverable 5)
- `_components/dropped-count-header.tsx` (Deliverable 6 — this module's own copy, D7)

Structurally-required files the ticket's Deliverable list does **not** individually name but which are necessary and precedented — **flagged for the Reviewer, exactly as PRP-01/PRP-02 flagged their additive gates/envelopes** (§4 R11):
- `_components/brief-view.tsx` — the single composition point (D8), the `fit-report-view.tsx` analog. Without it, the server reload path and the client generation path would each assemble the seven children and could silently drift in order/content.
- `_components/brief-generator.tsx` — `'use client'`; the RESEARCH→REHEARSE orchestrator (D2/D6), the `fit-auto-runner.tsx` analog. A server component cannot issue a client-triggered POST sequence with a progress UI, so this component is mandatory, not stylistic.
- `_lib/project-names.ts` — this module's own `projectNameMap(library)` (D12; per-module duplication, the same rule the ticket invokes for `dropped-count-header`).
- `_fixtures/brief-fixtures.ts` — test-only hand-written `Intel`/`Rehearse`/`Brief`/`Library` fixtures + a rehearse-response builder + a research-response builder.

Colocated tests (one per component/module, repo convention):
- `_components/{research-fail-banner,intel-card,question-list,ask-them-list,positioning-summary,dropped-count-header,brief-view,brief-generator}.test.tsx`
- `_lib/project-names.test.ts`
- `page.test.tsx` — **modified** (§3): keep the locked-branch tests, rewrite the unlocked-branch tests, add acceptance item 5.

**Doc write-backs** (same commit as the code):
- `docs/prd/06-prep/tickets/PRP-04-brief-content-ui.md` — append a `## Changelog` (Builder writeback, English), recording every decision below, the non-enumerated files and why, the two known limitations (D3 render-once dropped-count; D2/D6 auto-fire-per-visit quota cost), and the final test/lint/build results.
- `docs/prd/06-prep/README.md` — append a Changelog line (Chinese, matching v0.1–v0.3) and, in the 决策 table, rows for D2 (orchestration + degrade-vs-hard-fail), D4 (client read path honours ADR-A's relaxed shape), D1 (auto-fire cost boundary), D5 (intel-reuse retry). This is the **last** ticket in `06-prep`, so also flip the sub-PRD 状态 line if that is the module's convention (check the header; leave it if unsure).

### Explicitly out of scope — do not implement, even opportunistically

- **No edit to `prep/page.tsx`'s locked branch or guard scaffolding** — extend the unlocked branch only.
- **No RESEARCH/REHEARSE server logic** — PRP-01/PRP-02 (call only, never edit `app/api/jobs/[id]/research/**` or `.../rehearse/**`).
- **No edit to `layout.tsx` / `job-tabs.tsx` (FIT-03)**, no edit to any `04-fit`/`05-tailor` file. **Do NOT import** FIT-03's or TLR-02's `dropped-count-header.tsx`, or TLR-02's `resume/_lib/project-names.ts`, or FIT-03's `fit-report-view.tsx`/`fit-view-model.ts` — per-module duplication is the deliberate decision (ticket + `breakdown-plan.md`). Build this module's own.
- **No `lib/**` / `db/**` / `app/api/**` change**, no migration, no new dependency, no Anthropic SDK.
- **No `getBrief`/`upsertBrief`/schema change** — the client read path relaxation (D4) is done **module-locally in `brief-generator.tsx`** by composing pure schemas, never by editing `lib/schemas/**` or `lib/db/queries/briefs.ts`.
- **No "regenerate" button** — the ticket's Deliverable 7 closing note makes this a deliberate scope boundary (Q4). REHEARSE is triggered once per job (when no `Brief` exists), never re-triggered from the UI once a `Brief` exists. If dogfood wants regeneration, that is a logged follow-up (Feedback obligation #1), not silent scope expansion.
- **No voice/interactive rehearsal** — PRD §11 V1.4, not v1 (ticket Non-goal).
- **No `router.refresh()` on the generation path** — render from the REHEARSE response body (D3); a refresh would destroy the `dropped` envelope Deliverable 6 requires.
- **No client-side persistence** of the brief (no `localStorage`/`sessionStorage`/cookie/URL) and **no `console.*`** of brief content (S1/S2).
- **No `vitest.config.ts` / `package.json` / `tsconfig.json` / `next.config.mjs` / `eslint.config.mjs` change.**
- **No ADR file** (§6).

---

## 2. Change list

Every file carries a header comment in the repo's established style: what it is, which PRD clause forces it, and which decision from this plan it implements. A decision without a comment at its implementation site is a defect in this repo. Model the header voice on `fit-report-view.tsx` / `fit-auto-runner.tsx`.

### The decisions this plan makes (each MUST also appear as a code comment at its implementation site)

| # | Decision | Why / rejected alternative |
|---|---|---|
| **D1** | **Generation AUTO-FIRES on mount** of `brief-generator.tsx` (one automatic RESEARCH→REHEARSE sequence per mount, single-flight), NOT a click-to-generate button. | Acceptance item 1 says "On first unlocked render with no persisted `Brief`, **the page calls** `POST …/research`" ("on render", not "on click"), and PRD §5.1's RESEARCH trigger is "进入 Prep" — entering the unlocked Prep tab IS the trigger (the deliberate act was PRP-03's "I got the interview" click that unlocked it, analogous to pasting the JD for Fit). Mirrors `fit-auto-runner.tsx`. **Rejected:** the `tailor-generator.tsx` click-trigger — cleaner on cost but contradicts item 1's "on render". **Cost boundary flagged (R3, Q1):** because no `Brief` is persisted until REHEARSE succeeds, a persistently-failing REHEARSE re-fires (and re-charges `prep`) on each fresh visit — the same limitation `fit-auto-runner.tsx` documents for Fit; escalate to Horace via README open question #3 if dogfood shows real pain, do not silently switch to click. |
| **D2** | **Orchestration = RESEARCH first, then REHEARSE, with a sharp degrade-vs-hard-fail split.** On RESEARCH **`200`** (whether `failed:false` or `failed:true`, and even if the 200 body fails to parse) → capture `intel` (an `Intel` or `null`) and **proceed to REHEARSE** with `{ intel }`. On RESEARCH **non-`200`** → **STOP, show the error, and do NOT call REHEARSE.** | The ticket's "regardless of whether RESEARCH succeeded or degraded — call REHEARSE" (Background) means the **200/`failed:true`** case (PRD §2 P3 "degrade, don't block" applied at the UI). A **non-200** is a different animal: a `429 quota_exceeded` means the day's `prep` unit is exhausted, and a `403`/`404`/`503`/`500` means the operation provably cannot complete. **Proceeding to REHEARSE after a RESEARCH `429` would be a cost hole:** REHEARSE charges nothing (PRP-02), so it would happily produce a paid brief for a user who has no `prep` quota left — bypassing the single quota gate for the whole Prep operation. So a non-200 RESEARCH is a hard stop. A malformed RESEARCH 200 body → treat as degraded (`intel: null`) and proceed (maximal degrade-not-block; never blocks the brief on a cosmetic response glitch). **Rejected:** "always call REHEARSE regardless of RESEARCH's status" (the cost hole above); "hard-stop on `failed:true`" (violates PRD §2 P3 — a degraded RESEARCH must still yield a brief). |
| **D3** | **On REHEARSE `200`, render the brief FROM THE RESPONSE BODY** (not a `router.refresh()`/refetch). | Deliverable 6: the `dropped` count exists ONLY in PRP-02's immediate response and is never persisted. A refresh would re-read via `getBrief` and **lose** exactly the data PRD §5.5 layer 1 ("dropped 计数随响应返回，前端可查看被弃条目") requires. This is `fit-auto-runner.tsx`'s D4 verbatim. **Rejected:** `router.refresh()` (destroys the dropped envelope, under-delivers §5.7). |
| **D4** | **THE LOAD-BEARING READ DECISION.** The client's REHEARSE-200 response schema uses a **RELAXED `rehearse`** (`questions: z.array(RehearseQuestion).max(5)`), NOT strict FND-03 `Brief` (`.length(5)`). | This is the "PRP-04 read path" ADR-A pre-registered (PRP-02 D5 / `briefs.ts` header). Referential integrity can legitimately drop a hallucinated-`projectId` question, so a **persisted, valid** brief may carry 0–5 questions. Parsing the response against strict `Brief.length(5)` would turn a **successful** 4-question generation into a false "we could not produce your brief" error. Define the response schema module-locally in `brief-generator.tsx` by `.extend()`-ing the pure imported shapes (exactly as `briefs.ts` defines `PersistedRehearse`/`PersistedBrief`, and as `fit-auto-runner.tsx`/`tailor-generator.tsx` define their own module-local response schemas from pure pipeline schemas). The **server reload path is already safe**: `getBrief` returns the relaxed `PersistedBrief`, and `BriefView` consumes it as data (no re-parse — the `briefs.ts` header forbids re-parsing against strict `Brief`). **Rejected:** strict `Brief.parse` (false errors on dropped-question briefs); editing FND-03/`briefs.ts` (out of file-scope; ADR-A's durable fix is Horace's). |
| **D5** | **"Try again" after a REHEARSE-phase failure re-runs REHEARSE ONLY** (reusing the `intel` captured from the already-successful RESEARCH); "Try again" after a RESEARCH-phase failure re-runs the whole sequence. | RESEARCH charged the `prep` unit and spent real search money; REHEARSE is free. Re-running RESEARCH because the *free* second half failed would waste a second `prep` unit — the exact waste PRP-02 open question #3 flags. So the generator holds the RESEARCH `intel` in state and, on a rehearse-phase retry, skips straight to REHEARSE. **Rejected:** always re-run the full sequence on retry (simpler, but double-charges `prep`). **Non-blocking (Q2):** if the Reviewer finds the extra state not worth it, the full-sequence retry is acceptable with the double-charge flagged — but this plan specifies intel-reuse as the correct default. |
| **D6** | **Single-flight, NO automatic retry.** An `autoStarted` ref guards the mount effect (one auto-sequence per mount, StrictMode double-mount included); an `inFlight` ref guards each fetch phase; failures render a manual **"Try again"** button and then wait. | Both route headers' SINGLE-FLIGHT INSTRUCTION, and `fit-auto-runner.tsx`'s D9. An auto-retry loop on a degrading/failing route would be unbounded paid calls from a component the user may not be watching. |
| **D7** | This module's `dropped-count-header.tsx` copies the **TLR-02 shape (NO `partial` flag)**, not FIT-03's. | Prep's dropped set is all-or-nothing: the full `dropped.questions` exists at generation (from the response), and on any later load it is **entirely** gone (`droppedCount` is not persisted — Deliverable 6), so `droppedCount === 0` renders nothing and there is no "partial middle state" to annotate (unlike Fit, whose layer-2 injections are re-derivable). This is TLR-02's exact reasoning. |
| **D8** | `brief-view.tsx` is the **single composition point** and is **NOT a `'use client'` component**. | `fit-report-view.tsx` verbatim: it is rendered on BOTH the server reload path (`page.tsx`) and inside the client generator's `done` state; marking it `'use client'` would defeat the server-rendered path. It takes only plain data props (no hooks, no I/O), so it renders correctly in either tree. Its children are likewise presentational (no `'use client'`). |
| **D9** | `research-fail-banner.tsx` and `intel-card.tsx` each take `intel: Intel \| null` and **self-guard**: the banner renders only when `intel === null`, the card only when `intel !== null`. `BriefView` renders **both unconditionally**. | Guarantees the banner appears **alongside** the rest of the brief, "never in place of it" (Deliverable 1 / acceptance item 3), and matches Deliverable 2's "renders nothing … when intel is null". |
| **D10** | `question-list.tsx` groups the questions by `projectId` in **first-appearance order**, one header per distinct `projectId`, header text = `projectNames[projectId] ?? projectId` (raw-id fallback). | PRD §4 S4 "面前按 angle 排练" + Deliverable 3's "grouped by project / angle". First-appearance order is deterministic and preserves the model's ordering (no re-sort). Raw-id fallback mirrors `resume/_lib/project-names.ts`'s documented behaviour (a library edited after generation can drop a cited id). |
| **D11** | The **ledger recap** is a minimal inline `<section>` inside `BriefView` (a short strengths count + the gaps' `probe`/`play`), **not** a re-import of FIT-03's `fit-report-view`, and it renders nothing when `ledger` is `null`/empty. | The Goal names "ledger recap" but there is **no** dedicated component Deliverable, no File-scope entry, and no acceptance test for it — so keep it light and grounded in PRD §1 F3 ("interviews are decided on the gaps"): show what the candidate must bridge, not the full Fit sub-score breakdown (that is the Fit tab's job). Flagged as a judgment call (Q3). |
| **D12** | This module's own `_lib/project-names.ts` (`projectNameMap(library: Library \| null): Record<string,string>`), not an import of TLR-02's. | Per-module duplication (ticket + `breakdown-plan.md`); mirrors `resume/_lib/project-names.ts`. |
| **D13** | The progress UI is a **two-phase `role="status"`** line ("Researching the company…", then "Preparing your interview questions…"). | PRD §5.1 names "全程 streaming 展示进度", but the routes each return one JSON body — streaming is NOT implemented (the same gap `fit-auto-runner.tsx` records for Fit). A two-phase status line is the honest substitute across the long (RESEARCH+REHEARSE, PRD "Prep ≤ 90s" p50) sequence. Flagged, not hidden. |

### 2.1 `app/(app)/jobs/[id]/prep/page.tsx` — extend the unlocked branch (Deliverable 7; D15)

Keep the imports, header, `dynamic`, `params` await, `requireUserId`, `getJob`, `notFound()`, and the `if (job.status !== 'interviewing') return <LockScreen jobId={id} />;` branch **exactly as PRP-03 left them**. Add static imports for `getBrief` (`@/lib/db/queries/briefs`), `getLibrary` (`@/lib/db/queries/library`), `projectNameMap` (`@/app/(app)/jobs/[id]/prep/_lib/project-names`), `BriefView`, and `BriefGenerator`. Replace **only** the placeholder block after the lock check with:

```tsx
  // === UNLOCKED (job.status === 'interviewing'): render the brief, or generate it ===
  // PRP-04 Deliverable 7. Two reads, both session-scoped (PRD §8.3), both import-safe with
  // DATABASE_URL unset (lazy dbIndex — build-guard test). getBrief/getLibrary THROW on row
  // drift (loud-failure policy) — NOT wrapped (a drifted row is a 500-class bug, not a 404).
  const [brief, library] = await Promise.all([getBrief(userId, id), getLibrary(userId)]);
  const projectNames = projectNameMap(library);

  // D15 — Brief exists → render it server-side (reload path: NO generation, NO fetch;
  // acceptance item 5). `brief` is briefs.ts's RELAXED PersistedBrief (rehearse.questions may
  // be < 5, D4/PRP-02 D5) — consume it as data, do NOT re-parse against strict Brief.
  // `dropped` is not persisted, so the reload path passes 0 / [] (D3 / Deliverable 6).
  if (brief) {
    return (
      <BriefView
        intel={brief.intel}
        rehearse={brief.rehearse}
        ledger={job.ledger}
        projectNames={projectNames}
        droppedCount={0}
        droppedItems={[]}
      />
    );
  }

  // No Brief yet → the client generator runs RESEARCH → REHEARSE and renders BriefView from
  // the REHEARSE response (D2/D3). It receives job.ledger (recap) + projectNames (question
  // grouping); it does NOT need the library itself (REHEARSE re-reads it server-side).
  return <BriefGenerator jobId={id} ledger={job.ledger} projectNames={projectNames} />;
```

Extend the header comment: the unlocked branch reads the `Brief` (`getBrief`) and `Library` (`getLibrary`, for `projectNames`) — two more session-scoped reads on top of `getJob`; the `Brief`-exists path is a pure server render with **zero fetch** (item 5); the no-`Brief` path hands off to the client generator (the only path that fetches). State that `getBrief` returns the **relaxed** `PersistedBrief` and must not be re-parsed against strict `Brief` (D4). Keep the PRP-03 note that the locked branch is the page-level lock `job-tabs.tsx` promises.

### 2.2 `_components/brief-view.tsx` — the single composition point (D8) — new, NOT `'use client'`

Model on `fit-report-view.tsx` exactly (including the "why this file exists / order is fixed by PRD / not a client component" header). Props (all plain data; `import type` the schema types so nothing drags drizzle):

```tsx
export default function BriefView({
  intel,        // Intel | null
  rehearse,     // { questions: RehearseQuestion[]; askThem: string[]; positioning: string } — RELAXED (0..5 questions, D4)
  ledger,       // Ledger | null (the recap; D11)
  projectNames, // Record<string, string>
  droppedCount, // number
  droppedItems, // DroppedItem[]  (from dropped-count-header.tsx)
}: { … }) { … }
```

Render order (fixed by PRD §5.7 header-count + §5.4 content order + the ticket Goal — comment this, it is PRD-visible, not taste):

1. `<DroppedCountHeader droppedCount={droppedCount} items={droppedItems} />` — §5.7 "表头计数" (top header; renders nothing at 0).
2. `<ResearchFailBanner intel={intel} />` — §5.7 "research fail 标红" (renders only when `intel === null`; D9).
3. `<IntelCard intel={intel} />` — §5.4 "intel" (renders only when `intel !== null`; D9).
4. The ledger recap `<section>` — §5.4 "ledger" (D11; renders nothing when `ledger` is null/empty).
5. `<QuestionList questions={rehearse.questions} projectNames={projectNames} />` — §5.4 "预测问题".
6. `<AskThemList askThem={rehearse.askThem} />` — §5.4 "askThem".
7. `<PositioningSummary positioning={rehearse.positioning} />` — §5.4 "positioning".

Give it a top `<h2 id="prep-heading">Interview brief</h2>` (or similar) so the page test can assert the unlocked-brief render distinctly (§3). The ledger recap: if `ledger && (ledger.bindings.length || ledger.gaps.length)`, render a compact `<section>` — e.g. a one-line "N strengths matched · M gaps to bridge" plus, for each gap, its `probe` and `play` (the actionable rehearsal content); otherwise render nothing. Keep it small.

### 2.3 `_components/brief-generator.tsx` — `'use client'`; the RESEARCH→REHEARSE orchestrator (D2/D3/D4/D5/D6/D13) — new

Model on `fit-auto-runner.tsx` (auto-fire, single-flight, render-from-response, manual retry, no-storage, no-logging) but with a **two-call sequence** and the D5 retry split. Props: `{ jobId: string; ledger: Ledger | null; projectNames: Record<string, string> }`.

Module-local defensive schemas (compose PURE schemas only — no `@/lib/db/**` value import, so no drizzle in the client bundle; mirror `fit-auto-runner.tsx`'s `FitRunResponse`):

```tsx
import { Brief } from '@/lib/schemas/persisted';
import { Intel, RehearseQuestion } from '@/lib/schemas/pipeline';

const ResearchResponse = z.object({ intel: Intel.nullable(), failed: z.boolean() });

// D4 — RELAXED rehearse (questions .max(5), not .length(5)): a referential-integrity drop
// can leave a VALID persisted brief with < 5 questions (PRP-02 D5 / ADR-A). Strict Brief
// would false-error a successful generation.
const RehearseResponse = Brief.extend({
  rehearse: Brief.shape.rehearse.extend({ questions: z.array(RehearseQuestion).max(5) }),
  dropped: z
    .object({ count: z.number(), questions: z.array(z.object({ item: RehearseQuestion, reason: z.string() })) })
    .optional(),
});
type RehearseResponse = z.infer<typeof RehearseResponse>;
```

(If `Brief.shape.rehearse.extend(...)` proves awkward under the pinned Zod version, import `Rehearse` and write `Rehearse.extend({ questions: z.array(RehearseQuestion).max(5) })` then `Brief.extend({ rehearse: <that>, dropped: … })` — identical result, matching `briefs.ts`.)

State machine (a discriminated union `State`, mirroring `fit-auto-runner.tsx`'s):

```
| { kind: 'researching' }
| { kind: 'rehearsing' }
| { kind: 'done'; brief: RehearseResponse }
| { kind: 'error'; phase: 'research' | 'rehearse'; message: string; libraryLink?: boolean; fitLink?: boolean }
```

Refs: `autoStarted` (mount guard, StrictMode-safe — D6) and `inFlight` (per-fetch guard). A separate `intelRef = useRef<Intel | null | undefined>(undefined)` holds the RESEARCH result across a rehearse-phase retry (D5) — `undefined` = "RESEARCH not yet succeeded".

- `useEffect(() => { if (autoStarted.current) return; autoStarted.current = true; void runResearch(); }, [])` (eslint-disable exhaustive-deps with the `fit-auto-runner.tsx` comment — mount-only on purpose).
- `runResearch()`: guard `inFlight`; `setState({kind:'researching'})`; `fetch('/api/jobs/'+jobId+'/research', { method: 'POST' })` (no body, no `Content-Type`). On **200**: parse `ResearchResponse`; `intel = parsed.success ? parsed.data.intel : null` (malformed 200 → `null`, D2); `intelRef.current = intel`; call `runRehearse(intel)`. On **non-200**: `setState(failureFor('research', status, errorString))` — do **not** call REHEARSE (D2). On throw: research-phase reach-the-server error. `finally { inFlight.current = false; }`.
- `runRehearse(intel: Intel | null)`: guard `inFlight`; `setState({kind:'rehearsing'})`; `fetch('/api/jobs/'+jobId+'/rehearse', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ intel }) })`. On **200**: `RehearseResponse.safeParse` → success ⇒ `setState({kind:'done', brief})`; failure ⇒ generic error (never a half-rendered brief, D3). On **non-200**: `setState(failureFor('rehearse', status, errorString))`. On throw: rehearse-phase reach-the-server error. `finally { inFlight.current = false; }`.
- **"Try again"** (rendered in the error state): `phase === 'research'` ⇒ `void runResearch()`; `phase === 'rehearse'` ⇒ `void runRehearse(intelRef.current ?? null)` (D5 — reuse the RESEARCH intel, skip a second paid RESEARCH). Single-flight via `inFlight`.

`failureFor(phase, status, error)` — branch on the `error` STRING (both route headers mandate this), no raw server value echoed (never echo `resetAt`):
- `401` → "Your session has expired. Sign in again to continue."
- `404` → "We could not find that job."
- `409 && error === 'fit_not_ready'` → "Run the Fit report for this job first, then come back." + `fitLink` → `/jobs/${jobId}`.
- `409 && error === 'no_library'` (rehearse only) → "Your library is empty, so there is nothing to prepare from." + `libraryLink` → `/library`.
- `429` (research only) → "You've used today's prep allowance. Try again tomorrow." (no `resetAt`).
- `422` (rehearse only) → generic "We could not prepare your interview brief. Try again."
- `403` → generic (should be unreachable — the page already gated `interviewing`; a defensive generic is fine).
- `503` → "Interview prep is temporarily unavailable. Try again later."
- default / `500` → the generic prep-failed message.

Render: `researching`/`rehearsing` → the two-phase `role="status"` line (D13). `error` → `role="alert"` message + optional `fitLink`/`libraryLink` + a "Try again" `<button>`. `done` → `<BriefView intel={brief.intel} rehearse={brief.rehearse} ledger={ledger} projectNames={projectNames} droppedCount={brief.dropped?.count ?? 0} droppedItems={toDroppedItems(brief.dropped)} />`, where `toDroppedItems` maps `dropped.questions` → `DroppedItem[]` (label = `item.question` or `item.projectId`; detail = e.g. `Cites "${item.projectId}", which isn't in your library (${reason}).`). Keep `toDroppedItems` a tiny local pure function (a few lines) — or, if the Builder prefers a testable unit, a `_lib/dropped-questions.ts` (optional; not required).

Header comment must carry: the D2 orchestration + degrade-vs-hard-fail split (and the cost-hole reason a non-200 RESEARCH must NOT call REHEARSE); D3 render-from-response (and why — the dropped envelope); D4 relaxed schema (and the false-error it prevents); D5 intel-reuse retry; D6 single-flight/no-auto-retry; D13 no-streaming substitute; the D1 auto-fire-per-visit cost limitation; **NO `console.*`** (the brief carries the user's company intel + project-anchored questions — PRD §8.1) and **no browser-storage** persistence.

### 2.4 The six Deliverable components — new, NOT `'use client'` (presentational)

- **`research-fail-banner.tsx`** (D1 ticket / D9): `{ intel: Intel | null }`; returns `null` when `intel !== null`; else a red-flagged banner (`role` optional; use a distinctive style/`color: '#b00020'` like the repo's `DANGER`) with copy explaining company research wasn't available and that the rest of the brief is unaffected (PRD §5.7 "research fail 标红但简报照常渲染"). Export the copy as a constant so the test cannot drift (mirror `PREP_UNLOCK_COPY`).
- **`intel-card.tsx`** (Deliverable 2): `{ intel: Intel | null }`; returns `null` when `intel === null` (the banner covers that case). Else render `snapshot`; then `recent` (each item's `headline` — which carries the source month/year per PRP-01 D9c — and its `soWhat`), `engineeringSignals`, `talkingPoints`. Render each array section only when non-empty (empty arrays are the valid "查无实据" state — do not render an empty list). Add a short caption grounding PRD §12's "面前人工过一遍 intel 是使用规范" (e.g. "Company research is best-effort — verify before your interview."). All content interpolated as `{text}` (React-escaped; never `dangerouslySetInnerHTML`).
- **`question-list.tsx`** (Deliverable 3; acceptance item 4; D10): `{ questions: RehearseQuestion[]; projectNames: Record<string,string> }`. Group by `projectId` in first-appearance order; render one header per group (`projectNames[projectId] ?? projectId`); under each, each question's `question` and its `trap` (labelled, e.g. "Follow-up:"). If `questions` is empty, render a neutral "No rehearsal questions were generated." Use a stable React `key` (`${projectId}-${index}`).
- **`ask-them-list.tsx`** (Deliverable 4): `{ askThem: string[] }`; render the items as a list under a heading ("Questions to ask them").
- **`positioning-summary.tsx`** (Deliverable 5): `{ positioning: string }`; render under a heading ("How to position yourself"). Render nothing extra if empty.
- **`dropped-count-header.tsx`** (Deliverable 6; D7): **copy TLR-02's `resume/_components/dropped-count-header.tsx` verbatim in shape** — `{ droppedCount, items }`, no `partial` flag, `null` at 0, bold count (singular/plural) + expandable `<details>` at `> 0`, item text as TEXT. Define and export `type DroppedItem = { label: string; detail: string }`. Header comment: per-module duplication is deliberate (do not import FIT-03's/TLR-02's), and Prep's dropped set is render-once (D3/Deliverable 6) so there is no `partial` state.

### 2.5 `_lib/project-names.ts` (D12) — new, pure

Copy `resume/_lib/project-names.ts`: `export function projectNameMap(library: Library | null): Record<string, string>` — empty map when `library` is null, else `{ [project.id]: project.name }`. `import type { Library }` only.

### 2.6 `_fixtures/brief-fixtures.ts` — new, test-only

Follow `job-fixtures.ts`/`tailored-fixtures.ts` conventions **exactly**: hand-written literals only, **no `node:fs` / no `@/eval` import / no `import.meta.url`** (they throw at import under jsdom), **type-only** schema imports. Export:
- `LIBRARY_FIXTURE: Library` — **≥ 3 projects** with kebab-case ids (so the grouping test can span 3), plus profile.
- `INTEL_FIXTURE: Intel` — non-empty `snapshot`, 1–2 `recent` (headline with a "(Mon YYYY)" suffix per PRP-01 D9c + `soWhat`), some `engineeringSignals`/`talkingPoints`. Also `EMPTY_INTEL_FIXTURE: Intel` (all arrays empty — the 查无实据 case) for the intel-card empty-state test.
- `REHEARSE_FIXTURE` — **exactly 5 questions spanning 3 distinct `projectId`s** present in `LIBRARY_FIXTURE` (for item 4), each with a non-empty `trap`; 3 `askThem`; a `positioning`.
- `LEDGER_FIXTURE: Ledger` — a couple of bindings + a couple of gaps (each gap with `probe`/`play`) for the recap.
- `briefFixture(overrides?)` — a persisted `Brief` (`{ jobId, intel, rehearse, createdAt, updatedAt }`) using the above; default `intel: INTEL_FIXTURE`. Provide a variant path for `intel: null`.
- `rehearseResponseFixture(overrides?)` — the REHEARSE **200 body**: `{ ...briefFixture(), dropped: { count: 1, questions: [{ item: <a RehearseQuestion citing a projectId NOT in LIBRARY_FIXTURE>, reason: 'projectId not in library' }] } }`.
- `researchResponseFixture(overrides?)` — `{ intel: INTEL_FIXTURE, failed: false }`; and note the degraded shape `{ intel: null, failed: true }` for the degrade test.

### 2.7 What must not change

`app/(app)/jobs/[id]/prep/page.tsx`'s **locked branch + guards** · `_components/lock-screen.tsx` · `_components/status-transition-button.tsx` · `layout.tsx` · `job-tabs.tsx` · every `04-fit`/`05-tailor` file · `app/api/**` · `lib/**` · `db/**` · `eval/**` · `fixtures/**` · `vitest.config.ts` · `package.json` · `tsconfig.json` · `next.config.mjs` · `eslint.config.mjs`. If any of these *must* change for the ticket to pass, stop and escalate — that is a plan defect, not a Builder judgement call.

---

## 3. Test plan

All component/page tests are jsdom (`// @vitest-environment jsdom` as the file's first line); `project-names.test.ts` is node. No jest-dom matchers (§0.0). Every test runs fully offline (no real `fetch`, no DB). Each acceptance item is mapped to its proving test.

**`stubFetch(...replies)` helper** — copy `fit-auto-runner.test.tsx`'s exact multi-reply queue (`replies[Math.min(call, replies.length-1)]`) so a test can queue a RESEARCH reply then a REHEARSE reply and assert call order. `afterEach(cleanup)`, `afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); })`.

### `brief-generator.test.tsx` — the load-bearing file (acceptance items 1, 2; D2/D5/D6)

Render `<BriefGenerator jobId="job-1" ledger={LEDGER_FIXTURE} projectNames={projectNameMap(LIBRARY_FIXTURE)} />`.

| # | Test | Acceptance |
|---|---|---|
| 1 | **research BEFORE rehearse**: `stubFetch({200, researchResponseFixture()}, {200, rehearseResponseFixture()})`; `await waitFor` the brief; assert `fetchMock.mock.calls[0][0] === '/api/jobs/job-1/research'` and `calls[1][0] === '/api/jobs/job-1/rehearse'`; assert the research call was `{ method: 'POST' }` (no body). | ✅ item 1 |
| 2 | **degrade-not-block**: `stubFetch({200, {intel:null,failed:true}}, {200, rehearseResponseFixture({ intel: null })})`; `await waitFor` the brief; assert REHEARSE was called and `JSON.parse(calls[1][1].body)` deep-equals `{ intel: null }`; assert the research-fail banner is present alongside the questions. | ✅ item 2 |
| 3 | **success renders the brief from the response, WITH the dropped header** (D3): `stubFetch({200, research}, {200, rehearseResponseFixture()})`; `await waitFor` a distinctive brief string (e.g. the positioning); assert "1 item was dropped" is present; expand `<details>` and assert the dropped question's projectId text; assert `router.refresh` was never used (no `next/navigation` import needed — there is none). | — |
| 4 | **RESEARCH non-200 hard-stops (D2 — the cost hole)**: `stubFetch({429, {error:'quota_exceeded', op:'prep', resetAt: 1893456000000}})`; `await` the alert; assert **REHEARSE was NEVER called** (`fetchMock` called exactly once, `calls[0][0]` is the research URL); assert the message matches /prep allowance/i and does **not** contain the raw `resetAt`. | — (load-bearing) |
| 5 | **RESEARCH 409 fit_not_ready** → alert /run the fit report/i + a link to `/jobs/job-1`; REHEARSE never called. | — |
| 6 | **REHEARSE 422 rehearse_failed** → after a 200 research + 422 rehearse, alert /could not prepare your interview brief/i + a "Try again" button; the brief is not rendered. | — |
| 7 | **REHEARSE 409 no_library** → alert + a `/library` link. | — |
| 8 | **malformed REHEARSE 200** (`{200, { not: 'a brief' }}`) → generic error alert, never a half-rendered brief (no positioning text). | — |
| 9 | **relaxed schema accepts < 5 questions (D4)**: `rehearseResponseFixture({ rehearse: { ...REHEARSE_FIXTURE, questions: REHEARSE_FIXTURE.questions.slice(0, 4) } })` → renders successfully (4 questions), NOT an error. **This directly pins ADR-A's read-path consequence.** | — (load-bearing) |
| 10 | **single-flight on mount (D6)**: `render` then `rerender` twice (StrictMode analog, as `fit-auto-runner.test.tsx` does) → RESEARCH fetched exactly once. | — |
| 11 | **NO auto-retry (D6)**: `stubFetch({429,…})`; after the alert, `setTimeout(50)` flush → `fetchMock` called exactly once. | — |
| 12 | **research-phase retry re-runs the full sequence**: `stubFetch({503,…}, {200, research}, {200, rehearse})`; after the alert click "Try again"; `await` the brief; assert `calls[1][0]` is research, `calls[2][0]` is rehearse. | — |
| 13 | **rehearse-phase retry re-runs REHEARSE ONLY (D5)**: `stubFetch({200, research}, {422,…}, {200, rehearse})`; after the alert (research+rehearse = 2 calls) click "Try again"; `await` the brief; assert exactly **3** calls total and `calls[2][0]` is the **rehearse** URL (no second research); assert the retry's rehearse body carried the SAME `intel` as the first rehearse call. | — (load-bearing) |
| 14 | **network throw** on research → reach-the-server alert + Try again; REHEARSE not called. | — |
| 15 | **PRIVACY (S1/S2)**: spy `console.log/error/warn` — after a successful generation none is called; and after generation `window.localStorage.length === 0`, `sessionStorage.length === 0`, `document.cookie === ''` (mirror `fit-auto-runner.test.tsx`). | — |

### `brief-view.test.tsx` (acceptance item 3; D8/D9/D11)

Render `<BriefView …>` with fixtures.

1. **item 3 — banner alongside content**: `intel={null}`, a valid `rehearse` → the research-fail banner's copy is present **AND** a question, an askThem item, and the positioning are all present in the same render (assert several `getByText`). Proves the banner never replaces the brief.
2. `intel={INTEL_FIXTURE}` → the intel snapshot renders and the fail banner is **absent** (`queryByText(bannerCopy) === null`).
3. **order**: assert `DroppedCountHeader` (when `droppedCount>0`) precedes the intel/banner precedes questions precedes positioning (compare `compareDocumentPosition` or index of `textContent` — mirror the repo's ordering assertions where present; otherwise assert each section's presence and rely on `fit-report-view`'s documented fixed order).
4. **ledger recap (D11)**: with a `ledger` carrying a gap, the gap's `probe`/`play` render; with `ledger={null}`, no recap section renders (no crash).
5. `droppedCount={0}` → no dropped header (the reload-path shape).

### `question-list.test.tsx` (acceptance item 4; D10)

1. **item 4 — grouping**: 5 questions spanning 3 distinct `projectId`s + a `projectNames` map → exactly **3 group headers** render (assert 3 headings, each = the project name), and all 5 questions + their traps render.
2. raw-id fallback: a `projectId` absent from `projectNames` → its header renders the raw id.
3. empty `questions` → the neutral "no questions" line, no crash.

### `intel-card.test.tsx` (Deliverable 2)

1. `intel={null}` → renders nothing (`container.textContent === ''`).
2. `intel={INTEL_FIXTURE}` → snapshot, each `recent` headline + soWhat, engineeringSignals, talkingPoints all present; the §12 verify caption present.
3. `intel={EMPTY_INTEL_FIXTURE}` (all arrays empty) → snapshot present, no empty list rendered, no crash.
4. content rendered as TEXT (a `<script>`-looking snapshot renders as text, no `<script>`/`<img>` element) — mirror the dropped-count-header text-not-HTML test.

### `research-fail-banner.test.tsx` (Deliverable 1)

1. `intel={null}` → the exported copy renders.
2. `intel={INTEL_FIXTURE}` → renders nothing.

### `ask-them-list.test.tsx` / `positioning-summary.test.tsx` (Deliverables 4/5)

- ask-them: 3 items render; empty array → neutral/none.
- positioning: the string renders; empty → nothing extra.

### `dropped-count-header.test.tsx` (Deliverable 6; D7)

Copy TLR-02's `dropped-count-header.test.tsx` cases exactly: nothing at 0 (even with items), count + expandable list at `>0`, singular vs plural, text-not-HTML.

### `project-names.test.ts` (D12)

`null` → `{}`; a library → `{ id: name }` for each project. (node environment.)

### `page.test.tsx` — MODIFY (acceptance item 5; preserve PRP-03 locked behavior — R9)

The existing file mocks `@/lib/auth/session`, `@/lib/db/queries/jobs`, `next/navigation`. **Add mocks** for `@/lib/db/queries/briefs` (`getBrief`) and `@/lib/db/queries/library` (`getLibrary`); default them in `beforeEach` (`getBrief` → `null`, `getLibrary` → `LIBRARY_FIXTURE`). Keep the default `mockGetJob.mockResolvedValue(jobFixture())` (status `screening` → locked, so the two new reads are never reached on the default).

- **KEEP** unchanged (locked-branch regression — PRP-03 Feedback #2): tests 1–3 (`screening`/`applied`/`closed` → LockScreen button present, unlocked heading absent), the auth/scoping test (`getJob` called with `TEST_USER_ID, JOB_ID`), the missing-job `notFound`, the throwing-`getJob` propagation, the `UnauthorizedError` propagation, and `dynamic === 'force-dynamic'`.
- **REWRITE test 4** (`interviewing`): split into two —
  - `interviewing` + `getBrief → null` → renders the **generator's progress UI** (assert `getByRole('status')` with the researching copy). **Stub `fetch`** (research 200 + rehearse 200) so the auto-fire has something to resolve; the full orchestration is proven in `brief-generator.test.tsx`, so here just assert the generator mounted (the progress line, or `await waitFor` the brief). Do **not** re-assert the old placeholder heading.
  - `interviewing` + `getBrief → briefFixture()` → renders `<BriefView>` (assert the positioning text / a question is present) and the LockScreen button is absent.
- **ADD acceptance item 5** — `interviewing` + `getBrief → briefFixture()` + `stubFetch()` → after a `setTimeout(20)` flush, assert **`fetch` was never called** (no regeneration when a Brief exists). This is item 5's machine proof.
- **REWRITE the "no API call on any render" test**: assert zero fetch for the three LOCKED statuses **and** for `interviewing`-with-Brief; the `interviewing`-without-Brief case now legitimately fetches (the generator) and is covered above.
- **BUILD GUARD**: extend `vi.doUnmock` to `@/lib/db/queries/briefs` and `@/lib/db/queries/library` as well; assert `import('@/app/(app)/jobs/[id]/prep/page')` resolves with `DATABASE_URL` unset while `import('@/db/index')` rejects. (`getBrief`/`getLibrary` are import-safe — lazy `dbIndex()` — so the page import stays clean; R8.)

Note in the file header that the unlocked-branch assertions changed from PRP-03's transient placeholder to real brief content (PRP-03 Feedback #2), and that the locked-branch tests are unchanged regressions.

### Suite-level exit criteria

`corepack pnpm test` green with ≥ 95 files / 1195 tests plus this ticket's additions; `corepack pnpm lint` clean; **`corepack pnpm build` with `DATABASE_URL` unset exits 0** (CI parity — catches the Next-15 async-`params` type error and the lazy/static-import class of bug; verify `/jobs/[id]/prep` still in the route table). Run a `git grep -n "dropped-count-header\|fit-report-view\|resume/_lib/project-names" "app/(app)/jobs/[id]/prep"` and confirm **zero cross-module imports** (per-module duplication — D7/D12).

---

## 4. Risks and edge cases

**Security / privacy (the Reviewer will check these specifically)**

- **S1 — no client-side persistence.** `brief-generator.tsx` holds the brief in component state only; nothing to `localStorage`/`sessionStorage`/cookie/URL. The brief carries the user's company intel + project-anchored questions (PRD §8.1 sensitivity). Test 15 pins it.
- **S2 — no logging of brief content.** No `console.*` anywhere in the generator/view/components. A logging failure would leak intel/questions. Test 15 pins it. (`fit-auto-runner`/`tailor-generator` pin the same.)
- **S3 — cross-user isolation (PRD §8.3).** The client sends only the `jobId` (URL path) and the `intel` it received from its own RESEARCH call; it never sends a `userId`. `getBrief`/`getLibrary` (server) and both routes re-derive `userId` from the session and scope every read/write. `getBrief` returns `null` for another user's job (indistinguishable). Reviewer: confirm no `userId` is ever client-supplied and no new server surface was added.
- **S4 — the page-level lock still holds.** The unlocked branch (and thus the paid generator) is reachable only when `job.status === 'interviewing'` (PRP-03's check, preserved). Defense in depth: RESEARCH/REHEARSE both re-gate `not_interviewing` server-side. Reviewer: confirm the generator is never rendered for a non-`interviewing` job and the locked branch is byte-for-byte behaviourally unchanged.
- **S5 — model/web-sourced content rendered as TEXT, never HTML.** Intel (web-sourced, PRD §12 "搜索结果污染"), questions, and dropped items are all interpolated as `{text}` (React auto-escapes); **no `dangerouslySetInnerHTML` anywhere.** Tests pin text-not-HTML for the intel card and dropped header. The intel card also carries the §12 "verify before your interview" caption.
- **S6 — the `intel` passed to REHEARSE is re-validated server-side.** The client passes through the `intel` from its RESEARCH response; PRP-02's route re-parses it (`BodySchema` + NUL guard → 400). No new trust is placed in the client body. (Note: the client does not need to NUL-guard — PRP-01 already guards what it returns and PRP-02 guards the body.)

**Concurrency / cost**

- **R1 — single-flight within a mount (D6).** `autoStarted` + `inFlight` refs ⇒ one auto-sequence per mount, StrictMode-safe. Two tabs / a fast back-forward can each mount a fresh generator and both fire — **not fixable here** (same limitation `fit-auto-runner.tsx` documents; a claim column is FND-05's file-scope + Horace). REHEARSE overwrites with no replay guard (PRP-02 D13), so concurrent REHEARSE is last-write-wins (`getBrief` orders `updatedAt DESC`); the cost asymmetry is already escalated (README open Q#3). Do **not** add a client debounce that hides it.
- **R2 — no refresh window to guard (D3).** Because the generator renders from the response (no `router.refresh`), there is no post-success re-render/re-fetch. A manual browser reload after success → `getBrief` → `BriefView` (no regen).
- **R3 — auto-fire re-charges `prep` across visits until success (D1/D2).** No `Brief` is persisted until REHEARSE succeeds, so a persistently-failing REHEARSE (or a user who leaves mid-RESEARCH) re-fires on each fresh unlocked visit, each RESEARCH charging a `prep` unit (bounded by 3/day → then 429). This is inherent to auto-fire and mirrors `fit-auto-runner.tsx`'s documented limitation. Recorded as a known limitation + Q1 (escalate to Horace if dogfood shows pain), **not** worked around with client state that would defeat item 1's "on render" behaviour.

**Correctness / build**

- **R4 — the relaxed response schema (D4) is load-bearing.** Without `questions.max(5)`, a valid dropped-question brief false-errors. Test 9 pins it non-vacuously.
- **R5 — `brief-view.tsx` and its children must NOT be `'use client'`** (D8) — else the server reload path breaks. Mirror `fit-report-view.tsx`. The only `'use client'` file this ticket adds is `brief-generator.tsx`.
- **R6 — no jest-dom.** Use raw `@testing-library`/vitest assertions only (§0.0). `.toBeInTheDocument()` will not compile.
- **R7 — client bundle purity.** The generator's response schemas compose **pure** `@/lib/schemas/**` (no `@/lib/db/**` value import → no drizzle in the client bundle), and `_fixtures` use type-only imports. Mirror `fit-auto-runner.tsx`/`job-fixtures.ts` (E12).
- **R8 — build guard.** `page.tsx` statically imports `getBrief`/`getLibrary`; both are import-safe with `DATABASE_URL` unset (lazy `dbIndex()`). The build-guard test must `doUnmock` all three query modules and confirm a clean import. Run `corepack pnpm build` with `DATABASE_URL` unset before calling the ticket done.
- **R9 — PRP-03 shared-file regression.** The locked-branch tests (page.test.tsx 1–3 + auth/scoping/guard) must stay green after this edit; the unlocked-branch tests are the transient ones PRP-03 Feedback #2 authorized changing. Regression-test, do not just trust the diff. Keep the branch boundary clean (`if (status !== 'interviewing') return <LockScreen …>` unchanged; only the code after it changes).
- **R10 — Next 15 async `params`.** Already handled by PRP-03 (`await params`) — keep it. A dynamic-segment page still needs `export const dynamic = 'force-dynamic'` (present).
- **R11 — non-enumerated files.** `brief-view.tsx`, `brief-generator.tsx`, `_lib/project-names.ts`, `_fixtures/brief-fixtures.ts` are not named in the ticket's Deliverable list but are structurally required and squarely within `06-prep`'s own `prep/**` directory (no cross-module reach). Flag them explicitly in the ticket Changelog (as PRP-01/PRP-02 flagged their gates/envelopes), with the `fit-auto-runner`/`fit-report-view`/`project-names`/`job-fixtures` precedents. This is not scope creep; it is the minimal file set that satisfies the Deliverables without duplicating the composition across two paths.

---

## 5. Open questions

| # | Question | Owner / how it gets decided |
|---|---|---|
| Q1 | Auto-fire on mount vs a click-to-generate button for a paid (RESEARCH `prep`-charged) operation. | **Decided in this plan: auto-fire** (acceptance item 1's "on render", PRD §5.1 "进入 Prep", the Fit precedent). The per-visit re-charge risk (R3) is a real cost boundary — if Horace's P4 dogfood finds it wasteful, switching to a click-trigger (Tailor-style) is a small, localized change; log it in `06-prep/README.md` open question #3. **Non-blocking.** |
| Q2 | "Try again" after a rehearse-phase failure re-runs REHEARSE only (reusing intel) vs re-running the full sequence. | **Decided in this plan: intel-reuse (D5)** — avoids double-charging `prep` for a failure of the free half. If the Reviewer judges the extra state not worth it, the full-sequence retry is acceptable **with the double-charge flagged**. **Non-blocking.** |
| Q3 | The ledger-recap's depth (D11) — there is no acceptance test or named component for it. | **Decided in this plan: minimal (gaps' probe/play + a strengths count), grounded in PRD §1 F3.** If dogfood wants a richer ledger view, that is a UI iteration logged in `06-prep/README.md`'s changelog (no API contract touched). **Non-blocking.** |
| Q4 | No user-facing "regenerate" button for an already-generated `Brief`. | **Carried as the ticket's stated scope boundary** (Deliverable 7 note + Feedback obligation #1). Adding one later changes the ticket's non-goal — log it as a new item in `06-prep/README.md` before building. **Non-blocking; recorded, not acted on.** |
| Q5 | The dropped-count header is shown only right after generation, never on later visits (Deliverable 6 / D3). | **Inherent, not a workaround:** `droppedCount` is not part of the persisted `Brief` (FND-04), so a later `getBrief` cannot re-derive it. The durable fix (a `droppedCount` column) is a foundation-schema change owned by Horace + `01-foundation` (ticket Feedback obligation #2). Documented as a known limitation; **do not** fake it with disappearing client state. **Non-blocking (documented limitation).** |

No blocking open questions. This ticket builds entirely on already-merged, already-reviewed contracts.

---

## 6. ADR candidates

**None new from this ticket.** The ticket header states "No ADR — the decision is already made in PRD §5.4 and §5.7." The one hard-to-reverse decision that touches this ticket — "a persisted `Brief` may carry fewer than 5 REHEARSE questions" — was **already pre-registered as ADR-A** by PRP-02 (`briefs.ts` header + `docs/plans/PRP-02.md` §6). This ticket **lands ADR-A's read-path consequence** (D4: the client response schema must relax `questions` to `.max(5)`); it implements the read side ADR-A named, it does not introduce a new architectural fork. The auto-fire-vs-click choice (D1) and the intel-reuse retry (D5) are conventional, trivially-reversible client patterns recorded as plan decisions + ticket-Changelog notes, not ADR material. **Do NOT create any file in `docs/adr/`.**

---

## 7. Build sequence (suggested order; each step ends green)

0. `git switch main && git switch -c ticket/PRP-04` at `b32a7b6`. Confirm the baseline: `corepack pnpm test` → ≥ 95 files / 1195 tests green (record the real number).
1. **`_fixtures/brief-fixtures.ts`** (§2.6) + **`_lib/project-names.ts`** (§2.5) + its test. Green. (Leaf, no deps.)
2. **The six Deliverable components** (§2.4) + their tests, in this order: `dropped-count-header` (copy TLR-02), `research-fail-banner`, `intel-card`, `question-list` (acceptance item 4), `ask-them-list`, `positioning-summary`. Green after each.
3. **`brief-view.tsx`** (§2.2) + its test (acceptance item 3, order, ledger recap). Green.
4. **`brief-generator.tsx`** (§2.3) + its test — the load-bearing file (acceptance items 1, 2 + D2/D4/D5/D6). Green. (Build against the `fit-auto-runner.tsx` skeleton.)
5. **`page.tsx` extension** (§2.1) + **modify `page.test.tsx`** (§3: keep locked tests, rewrite unlocked, add item 5, extend build guard). Green.
6. **`corepack pnpm build` with `DATABASE_URL` unset** → exit 0; `/jobs/[id]/prep` still in the route table (catches R8/R10).
7. **Cross-module-import check**: `git grep` per §3 exit criteria → zero hits.
8. **Doc write-backs** (§1) — the PRP-04 ticket Changelog (all decisions, the non-enumerated files + why, the two known limitations, test/lint/build results) + the `06-prep/README.md` Changelog line and 决策 rows. This is the last ticket in the module — check whether the README 状态 line should flip.
9. Final `corepack pnpm test` (≥ baseline + new) and `corepack pnpm lint` clean.

> Note the honest limit of a green suite: every test here stubs `fetch` and hand-writes every fixture, so green proves **wiring** (call order, degrade routing, single-flight, the relaxed read, the render composition) and **nothing about the real quality of an interview brief**. The real end-to-end brief (a live RESEARCH+REHEARSE against a real job) is Horace's P4 dogfood `[human]` acceptance — the ticket's own acceptance item 7.
