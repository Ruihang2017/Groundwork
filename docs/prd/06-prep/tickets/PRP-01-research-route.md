---
id: PRP-01
title: RESEARCH API route
module: 06-prep
lane: 06-prep
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-03, FND-06, FND-10, FIT-01]
blocks: [PRP-02, PRP-04]
---

# PRP-01 — RESEARCH API route

No ADR — the decision is already made in PRD §5.1 (RESEARCH row), §2 P3 (degrade posture); this is build ticket 1 of 4 against the `06-prep` module.
Parent sub-PRD: [06-prep README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-03 — Pipeline stage payload Zod schemas](../../01-foundation/tickets/FND-03-pipeline-payload-schemas.md), [FND-06 — Model, pricing, and quota configuration](../../01-foundation/tickets/FND-06-model-pricing-quota-config.md), [FND-10 — Usage and cost observability recording helper](../../01-foundation/tickets/FND-10-usage-recording.md), [FIT-01 — Job creation and lifecycle status route](../../04-fit/tickets/FIT-01-job-creation-status-route.md)
**Why `builder`:** implementing a single stage route (RESEARCH) against an already-decided schema and explicit degrade-not-block failure policy — no open design.

## Background + basis

PRD §5.1 RESEARCH row: "**RESEARCH** | 进入 Prep | `company + role` → `Intel`（web_search tool） | snapshot、recent ≤ 3（每条带 soWhat）、engineering 信号 ≤ 3、talkingPoints ≤ 3；查无实据返回空数组，禁止编造 | 失败标记 fail，简报照常（P3）". The trigger "进入 Prep" means this is called when the user first navigates into (or explicitly starts) the Prep flow for a job — per `06-prep/README.md`'s decision, this is the FIRST of the two calls comprising the single user-facing "Prep"/"生成简报" action, and where the `prep` quota (PRD §8.3: "3 prep"/day) is charged, once, covering both this call and PRP-02's REHEARSE call that follows.

PRD §2 P3: "**Degrade, don't block。** 公司情报等外部依赖是 best-effort：失败标记 fail，主产出照常。任何单阶段故障不得阻塞整条 pipeline 的可用输出。" — this is the load-bearing principle: a RESEARCH failure (web_search error, no results, API timeout) must NOT propagate as an HTTP error that blocks the user from proceeding to REHEARSE; it returns a structured "failed" result instead.

PRD §5.1's "查无实据返回空数组，禁止编造" — this is a prompt-level instruction (like PARSE's metrics rule): the model must return empty arrays for `recent`/`engineeringSignals`/`talkingPoints` when web search turns up nothing substantive, never invent plausible-sounding company news. There is no server-side cross-check possible here (unlike TAILOR's number-integrity check) since there's no independent source of truth to validate "is this actually true" against — this is why PRD frames it as "禁止编造" (a prompt discipline) rather than a validation layer in §5.5's four-layer list (Intel is notably absent from §5.5's layers).

## Goal

`app/api/jobs/[id]/research/route.ts` (`POST`, no body needed beyond the job id) that runs RESEARCH (LLM with `web_search` tool → `Intel`), charges the `prep` quota once (covering this call and the following REHEARSE call), and returns `{ intel: Intel | null; failed: boolean }` — never a 5xx for a research-specific failure.

## Non-goals

- No REHEARSE — PRP-02 (this route does NOT persist anything to `briefs`; per `06-prep/README.md`'s decision, `Intel` is held client-side and passed into PRP-02's REHEARSE call, which does the one-time `Brief` persistence).
- No Prep tab UI — PRP-03/PRP-04.
- No RESEARCH-front-loaded-into-Fit — PRD §13 Q3, explicitly not v1 (see `06-prep/README.md` open question #1).

## File-scope (write-owns)

- `app/api/jobs/[id]/research/route.ts`, `app/api/jobs/[id]/research/route.test.ts`
- `lib/research/prompt.ts`
- Does not touch: `app/api/jobs/[id]/rehearse/route.ts` (PRP-02), `lib/db/queries/briefs.ts` (PRP-02), any `app/(app)/**` path (PRP-03/PRP-04).
- Serial-safety: all of `01-foundation`, `02-evaluation`, `03-library`, and `04-fit` are fully merged before this ticket starts (per the module execution order in `docs/prd/breakdown-plan.md` §4) — no in-flight contention. `05-tailor` may be building in parallel (no dependency either direction, per that module's own README) — disjoint file paths, no contention.

## Deliverables

1. `lib/research/prompt.ts` exporting the RESEARCH stage prompt, written fresh (no legacy asset assumed — see `06-prep/README.md` open question #2), instructing the model to use the `web_search` tool against `company`/`role`, producing `Intel` (FND-03: `snapshot`, `recent` ≤ 3 each with `soWhat`, `engineeringSignals` ≤ 3, `talkingPoints` ≤ 3), with the explicit "return empty arrays rather than invent findings" instruction (Background).
2. `app/api/jobs/[id]/research/route.ts` `POST` handler: (a) `requireUserId()`; (b) `getJob(userId, jobId)` (FIT-01) — HTTP 404 if absent; (c) `checkAndIncrementQuota(userId, 'prep')` (FND-06) — HTTP 429 if not allowed (this is the ONE quota charge for the whole Prep operation, per `06-prep/README.md`'s decision — PRP-02's REHEARSE call does NOT check `prep` quota again); (d) `checkGlobalBreaker()` (FND-06) — HTTP 503 if tripped; (e) call Anthropic with `PRIMARY_MODEL`, the `web_search` tool enabled, and the RESEARCH prompt with `job.company`/`job.role`; parse against `Intel` (FND-03), one JSON-repair retry; (f) ON ANY FAILURE (search error, timeout, unrecoverable parse failure) — per PRD's degrade policy, catch it and return HTTP 200 `{ intel: null, failed: true }`, NOT an HTTP error status (an HTTP error would signal "something is wrong with your request/session"; this is a best-effort external dependency failing, a distinct and expected case the client must handle gracefully, not an exceptional one); (g) on success, `recordUsage()` (FND-10) with `op: 'research'`, `searches` = the actual number of web_search tool invocations the model made; (h) return `{ intel: Intel, failed: false }` with HTTP 200.

## Acceptance checklist (classified)

- [ ] `[machine]` A mocked web_search failure (Anthropic client mocked to throw/return a tool-error) results in HTTP 200 `{ intel: null, failed: true }`, never a 4xx/5xx — direct proof of PRD §2 P3's "失败标记 fail，简报照常" applied at the HTTP layer.
- [ ] `[machine]` `checkAndIncrementQuota(userId, 'prep')` is called exactly once per request, before the Anthropic call.
- [ ] `[machine]` A mocked successful response with `recent: []`, `engineeringSignals: []`, `talkingPoints: []` (the "查无实据" case) parses successfully against `Intel` and is NOT treated as a failure (`failed: false`) — distinguishing "found nothing, honestly reported" from "the call itself failed".
- [ ] `[machine]` `recordUsage()` is called with `op: 'research'` and a `searches` count matching the number of tool-use blocks in the mocked response.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Unit/integration tests mocking the Anthropic client (including a `web_search`-tool-enabled mocked response shape, and separately a mocked throw to exercise the degrade path) — no real web searches in CI (non-deterministic, costed). A separate manually-triggered real-model smoke run (documented in a code comment, same convention as prior stage-route tickets) validates the real `web_search` tool integration before P4 sign-off.

## Feedback obligation

1. General rule: the RESEARCH prompt (`lib/research/prompt.ts`) is new, hand-authored content — if it produces low-quality or overly generic `Intel` during real fixture/dogfood testing, fix here and record the case per `02-evaluation`'s changelog convention (RESEARCH's output isn't part of Q1–Q3's PRD-defined assertions since Intel has no groundedness/specificity gate named in §6's table — but PRD §12's risk table does flag "搜索结果污染" as a named risk with mitigation "禁编造 + intel 展示来源年份 + 面前人工过一遍 intel 是使用规范" — if real usage shows fabrication despite the prompt instruction, that IS a P0-severity PRD §7 finding regardless of Q1–Q3 not formally gating it, since P1/P2's "don't fabricate" principle is product-wide, not stage-scoped).
2. The single-quota-charge-at-RESEARCH design (Background/Deliverable 2c) is explicitly flagged as ADR-candidate material, same family as `04-fit`'s equivalent decision — if real usage shows problems (e.g. a user's REHEARSE call fails after RESEARCH succeeded and consumed the quota, effectively wasting it since PRP-02 does not re-attempt or refund), escalate to Horace via `06-prep/README.md`'s open question #3 rather than silently adding a refund/retry mechanism.

## Changelog

- v0.1 (2026-07-23, Builder writeback): implemented against `docs/plans/PRP-01.md`. Two new source files + one new test file — `lib/research/prompt.ts`, `app/api/jobs/[id]/research/route.ts` (+ `route.test.ts`). No migration, no new dependency, no Anthropic SDK, no change to any file outside this ticket's write-scope (`lib/schemas/**`, `lib/config/**`, `lib/validation/**`, `db/**`, `eval/**`, `fixtures/**` all untouched).

  ### Deviations from Deliverable 2's gate list (the load-bearing ones — flagged for the Reviewer)

  1. **Two server-side funnel gates ADDED that Deliverable 2 does not list (plan D3).** Before quota and before any spend: `403 not_interviewing` when `job.status !== 'interviewing'`, then `409 fit_not_ready` when `job.ledger === null || job.fit === null`. Rationale: PRD §5.4 makes `status = 'interviewing'` *the* unlock condition for Prep and §2 P4 names this exact web-search call as the thing being gated; without them the cheap half of Prep (PRP-02 already gates both server-side) would be gated while the **expensive** half — the only call in the app that spends real money on web searches — would not, and a Prep that provably cannot finish (PRP-02 409s without `ledger`/`fit`) would still burn the day's `prep` unit **plus** real search money. RESEARCH itself does not read `ledger`/`fit`; the 409 is a whole-Prep-operation integrity gate, not an input requirement. **Merging this ticket ratifies the gates**; loosening them later (e.g. to preview intel earlier) is a product decision for Horace (plan §5 Q6), not a silent Builder change.

  ### Design resolutions implemented (plan §0.1 — each recorded at its implementation site)

  - **D1** — RESEARCH receives `job.company` and `job.role` and NOTHING else (never `jdRaw`/`jd`/`ledger`/`Library`/resume). This is a security decision first: RESEARCH is the only call in the app with a server-side `web_search` tool, so anything in the context can leak into a third-party search query, outside PRD §8.3's "第三方处理方仅 Anthropic API" promise. A test pins that a distinctive `jdRaw`/`jd` never appears in the request body.
  - **D4/D5 — the degrade taxonomy (PRD §2 P3).** Everything from the paid call outward returns `200 { intel: null, failed: true }`, never a 4xx/5xx: transport error, timeout, non-2xx from Anthropic, a reply unusable after the one repair, **and** two search-mechanism failures — **zero searches** (`no_search`: findings came from parametric memory, PRD §12's pollution at its worst) and **every search errored** (`search_error`). Everything before the paid call is an ordinary HTTP status; a `getJob` throw (row drift) is a 500, not a degrade.
  - **D5c — divergence from the prior `origin/ticket/PRP-01` branch, per the plan.** An **empty** `web_search_tool_result` array counts as a real search and PROCEEDS (a genuinely obscure/fake company legitimately finds nothing — an honest `failed: false` success), where the prior branch treated only a non-empty array as a real search and would have degraded that honest case. The gate is "≥ 1 result block with array content", not "≥ 1 hit".
  - **D6** — `searches` recorded = `max(count of web_search server_tool_use blocks, usage.server_tool_use.web_search_requests)`, from the first call only. The max over-reports on disagreement — the safe direction for a cost breaker.
  - **D7/D8/D11** — one JSON-repair turn with **no tools** (fixes structure only, buys no more paid searches) and deadline-aware skip below 8s remaining budget; `extractFinalText` takes the text after the last tool block (falling back to all text blocks) so a search preamble is not spliced into the payload; hard-failure classes = truncation, no JSON, `Intel.safeParse` failure (**including `.max(3)` — over-cap arrays are repaired, never sliced**), a NUL byte, or a blank required string (`Intel` has no `.min(1)`, so `''` is schema-legal and must be caught in the route).
  - **D9c** — the source's month/year rides inside `recent[].headline` (e.g. `"(Mar 2026)"`), which is how PRD §12's "intel 展示来源年份" mitigation is met **without** a schema change (`IntelRecentItem` has no url/date field, and `lib/schemas/**` is `01-foundation`'s file-scope — plan §5 Q3). Output language is **English** (D9d): D1 forbids sending the JD, so §5.8's "language follows the JD" cannot apply, and §5.8 fixes v1 to English JDs (reversible — plan §5 Q5).
  - **D12/D13** — none of PRD §5.5's four validation layers apply to `Intel` (`droppedCount: 0`, `lib/validation/**` not imported). `recordUsage` is called on **success only**.

  ### Confirmations required by upstream tickets

  - **FND-06's `QUOTA_OP_TO_USAGE_OP` re-confirmed** (that table's comment names PRP-01 explicitly and obliges this re-check): this route charges the `prep` bucket **exactly once**, before the paid call, and on success records **exactly one** `usage_events` row with `op: 'research'` (the mapped op). **PRP-02's REHEARSE must NOT re-check `prep` quota** — counting its `op: 'rehearse'` row would be a second charge. `lib/config/quota.ts` needs no change and was not edited.
  - **Known gap carried forward, not fixed here (plan §4 R1/D13)**: a **degraded** call writes no `usage_events` row, so it consumes no `prep` quota and its real spend — including paid searches — is invisible to the global breaker. Sharper here than on any peer route because the failure is a friendly 200 a UI may treat as retryable; the route header therefore instructs PRP-03/PRP-04 to single-flight RESEARCH (one automatic call per mount, manual "try again" only). Recording `status: 'failure'` would consume quota (FND-06 counts rows regardless of status) — a repo-wide product/cost decision for Horace (plan §5 Q4); NOT changed unilaterally here.

  ### Manual smoke run (P4 sign-off status)

  **NOT performed — no `ANTHROPIC_API_KEY` in the build environment.** This is a **P4 sign-off BLOCKER for Horace** (plan §4 R4 / §7 step 7): `pnpm test` stubs `globalThis.fetch` on every test, so a green suite proves WIRING only and says **nothing** about whether the `web_search` tool integration works at all. In particular the tool version string `web_search_20250305` and whether an `anthropic-beta` header is required are Anthropic-side contracts this repo cannot type-check; a wrong string is an HTTP 400 that this route (by design, PRD §2 P3) degrades to a friendly `failed: true` **forever**, with a fully green suite. The manual recipe at the bottom of `lib/research/prompt.ts` must be run against the real API before P4 sign-off, and it must verify the fake-company case yields a "found nothing" snapshot + empty arrays (a fabricated profile there is a PRD §7 P0, not a tuning nit).

  ### Test results

  `pnpm test`: **76 files / 986 tests green** (baseline before this ticket on `main` @ `edf0a0c`: 75 / 947; this ticket adds 1 file / 39 tests). `pnpm lint`: clean. `pnpm build` with `DATABASE_URL` unset: exit 0, with `/api/jobs/[id]/research` in the route table. The plan §3 mutation check confirmed the degrade-status invariant is non-vacuous (flipping the degrade 200 → 503 fails 6 tests); the zero-search-guard and interviewing-gate mutations were reasoned-through but not executed under the sandbox (its classifier blocks *running* code with an intentionally weakened access/security guard).
