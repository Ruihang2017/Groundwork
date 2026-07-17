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
