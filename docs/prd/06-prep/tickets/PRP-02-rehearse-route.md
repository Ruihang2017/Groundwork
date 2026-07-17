---
id: PRP-02
title: REHEARSE API route
module: 06-prep
lane: 06-prep
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [PRP-01, FIT-02, FND-07, EVL-02]
blocks: [PRP-04]
---

# PRP-02 — REHEARSE API route

No ADR — the decision is already made in PRD §5.1 (REHEARSE row), §5.4, §5.5 layer 1; this is build ticket 2 of 4 against the `06-prep` module.
Parent sub-PRD: [06-prep README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [PRP-01 — RESEARCH API route](PRP-01-research-route.md), [FIT-02 — CROSS and SCORE route](../../04-fit/tickets/FIT-02-cross-score-route.md), [FND-07 — Server-side validation layer utilities](../../01-foundation/tickets/FND-07-server-validation-layers.md), [EVL-02 — Q1-Q3 evaluation harness](../../02-evaluation/tickets/EVL-02-eval-harness.md)
**Why `builder`:** implementing a single stage route (REHEARSE) against an already-decided schema and validation layer, being the sole writer of the `Brief` persisted entity — no open design.

## Background + basis

PRD §5.1 REHEARSE row: "**REHEARSE** | 进入 Prep | 全部上文 → `questions[5]` + `askThem[3]` + `positioning` | 每个问题必须绑 `projectId` 且只因该项目的具体内容才可问（能问任何候选人 = 无效）；trap = 标准答案之后的第二问；askThem 必须是不做研究问不出的问题 | 同上（JSON 修复重试 1 次 → 报错）". "全部上文" (everything above) means this call's input is the union of everything the funnel has produced for this job so far: `job.jdRaw`/`jd`, `job.ledger`, the caller's `Library`, and the `Intel` result from PRP-01's RESEARCH call (which this route receives as a request body field, not a DB read — per `06-prep/README.md`'s decision that `Intel` is held client-side between the two calls).

PRD §5.4: "ledger + intel + 预测问题 / askThem / positioning，MVP 已验证的四阶段 prompts 作为基线迁移。解锁条件：`job.status = interviewing`（用户点击'我拿到面试了'）——这是 P4 的门。" — the "解锁条件" is enforced at the UI layer (PRP-03) as the primary gate, but per PRD §8.3's general "no unauthorized-state path" spirit (already applied the same way in `04-fit`/FIT-01's server-side no-library gate), this route ALSO checks `job.status === 'interviewing'` server-side, rejecting the call otherwise — a client that bypasses the UI must still be rejected.

PRD §5.5 layer 1 applies directly to `Rehearse.questions[].projectId` — every question must cite a real library project.

Unlike RESEARCH, REHEARSE's failure policy is the STRICT one (PRD's own "同上" reference resolves to the READ/CROSS/TAILOR pattern: "JSON 修复重试 1 次 → 报错") — a REHEARSE failure returns an HTTP error, it does NOT degrade to a partial/null result the way RESEARCH does. This asymmetry is why RESEARCH and REHEARSE are separate routes with separate error-handling code paths (see `06-prep/README.md`'s rejected-alternatives entry on why they aren't merged into one call).

## Goal

`app/api/jobs/[id]/rehearse/route.ts` (`POST`, body `{ intel: Intel | null }` — the RESEARCH result from PRP-01, passed through by the client) that runs REHEARSE (LLM → `Rehearse`), applies FND-07's referential-integrity layer to `questions`, persists the complete `Brief` (`{ jobId, intel, rehearse }`) in one write, and returns it.

## Non-goals

- No RESEARCH call — PRP-01 (this route receives `Intel` as an input, does not call `web_search` itself).
- No UI — PRP-03/PRP-04.
- No `prep` quota re-check — already charged once at PRP-01 (per `06-prep/README.md`'s decision); this route does NOT call `checkAndIncrementQuota` again, but DOES call `checkGlobalBreaker()` again before its own paid call (same reasoning as `04-fit`/FIT-02's equivalent non-goal).

## File-scope (write-owns)

- `app/api/jobs/[id]/rehearse/route.ts`, `app/api/jobs/[id]/rehearse/route.test.ts`
- `lib/db/queries/briefs.ts`, `lib/db/queries/briefs.test.ts`
- `lib/rehearse/prompt.ts`
- Does not touch: `app/api/jobs/[id]/research/route.ts` (PRP-01), `app/(app)/jobs/[id]/prep/**` (PRP-03/PRP-04).
- Serial-safety: PRP-01 merged before this ticket starts (same lane, sequential); FIT-02, FND-07, EVL-02 merged as part of their own modules' full delivery before `06-prep` began — no in-flight contention.

## Deliverables

1. `lib/rehearse/prompt.ts` exporting the REHEARSE stage prompt, written fresh (no legacy asset assumed — see `06-prep/README.md` open question #2), instructing the model per PRD §5.4/§5.1's full spec (Background): exactly 5 questions each bound to a `projectId` and specific enough that it "couldn't be asked of a random candidate" (the Q3 specificity criterion), each with a `trap` (the follow-up after a textbook answer), exactly 3 `askThem` items that require research to formulate, and a `positioning` summary.
2. `lib/db/queries/briefs.ts` exporting `upsertBrief(jobId, intel, rehearse)` (one `Brief` per `jobId`, overwrite semantics matching `05-tailor`/TLR-01's `TailoredResume` re-run pattern) and `getBrief(userId, jobId)` (joins through `jobs` for `userId` scoping, same pattern as TLR-01's `tailored_resumes` query).
3. `app/api/jobs/[id]/rehearse/route.ts` `POST` handler: (a) `requireUserId()`; (b) `getJob(userId, jobId)` (FIT-01) — HTTP 404 if absent; HTTP 403 `{ error: 'not_interviewing' }` if `job.status !== 'interviewing'` (server-side mirror of PRD §5.4's unlock condition — see Background); HTTP 409 `{ error: 'fit_not_ready' }` if `job.fit`/`job.ledger` are absent (REHEARSE needs a completed Fit's ledger, same defensive pattern as TLR-01); (c) parse request body against `z.object({ intel: Intel.nullable() })`; (d) `checkGlobalBreaker()` — HTTP 503 if tripped; (e) call Anthropic with `PRIMARY_MODEL`, the REHEARSE prompt, `job.jd`, `job.ledger`, the caller's `Library`, and the request body's `intel`; parse against `Rehearse` (FND-03), one JSON-repair retry, HTTP 422 on unrecoverable failure (per the STRICT failure policy — Background); (f) apply `filterByReferentialIntegrity` (FND-07) to `rehearse.questions` using `getValidProjectIds(library)`; (g) `upsertBrief(jobId, intel, filteredRehearse)`; (h) `recordUsage()` with `op: 'rehearse'`, `droppedCount` = (f)'s dropped count; (i) return the `Brief` with HTTP 200.

## Acceptance checklist (classified)

- [ ] `[machine]` `POST /api/jobs/[id]/rehearse` for a job with `status !== 'interviewing'` returns HTTP 403 `{ error: 'not_interviewing' }` and never calls the Anthropic client — direct machine proof of PRD §5.4's unlock gate, enforced server-side.
- [ ] `[machine]` A mocked REHEARSE failure (JSON repair also fails) returns HTTP 422 (NOT a degraded null result) — direct proof of the strict failure policy, contrasted explicitly with PRP-01's degrade behavior.
- [ ] `[fixture]` For a set of EVL-01 JD+resume fixture pairs (with a completed `Ledger` from FIT-02's own fixture pairing, and `intel: null` simulating a degraded RESEARCH), calling this route (Anthropic client mocked with a canned valid `Rehearse` response per fixture pair) produces a `Rehearse` where `questions.length === 5` and every `trap` is non-empty — via `02-evaluation`/EVL-02's `assertQ1Questions`, the concrete `[fixture]` acceptance item feeding PRD §10 P4's "Q1 全绿" for REHEARSE.
- [ ] `[fixture]` For the same fixture set, running EVL-02's `assertQ3Specific` against each generated question achieves `passRate >= 0.90` — the concrete `[fixture]` acceptance item feeding PRD §10 P4's "Q3 ≥ 90%" (mocked judge in CI-bound tests; separate manually-triggered real-model+real-judge run documented before P4 sign-off, same convention as FIT-02).
- [ ] `[machine]` A mocked question with a `projectId` not in the library is dropped from the persisted `rehearse.questions` and counted.
- [ ] `[machine]` `Brief` persists with `intel: null` successfully when the request body's `intel` is `null` (degrade-carried-through case).
- [ ] `[machine]` `pnpm test` green.

## Test plan

Unit/integration tests mocking the Anthropic client and using the local/in-memory Postgres substitute for `upsertBrief`/`getBrief` assertions. `[fixture]` items follow the same mocked-model/mocked-judge, real-assertion-logic pattern established in FIT-02/TLR-01's own tests, with a separate manually-triggered real-model+real-judge smoke run documented before P4 sign-off.

## Feedback obligation

1. General rule: the REHEARSE prompt (`lib/rehearse/prompt.ts`) is new, hand-authored content — if the real Q3 specificity pass rate (from the manually-triggered real run) comes in below 90%, that is the PRD §6 Q3 gate failing; fix the prompt (emphasizing project-specific technical depth over generic behavioral-question framing) and record the failing case in `02-evaluation`'s fixture corpus per that module's changelog convention, per PRD §6's "fail 样本人工复核，属实则修 prompt 并固化为回归用例".
2. If the server-side `status === 'interviewing'` gate (Deliverable 3b) is found to be too strict once real usage patterns emerge (e.g. Horace's dogfood wants to preview REHEARSE before formally marking a job as interviewing), that is a product decision reversal of PRD §5.4's stated gate — escalate to Horace, do not silently loosen the check.
3. The single-quota-charge-at-RESEARCH / two-call Prep design (inherited from PRP-01's Background) means a REHEARSE failure after a successful RESEARCH still consumes the day's `prep` quota with no completed `Brief` to show for it — if this proves to be a real user-facing frustration, escalate to `06-prep/README.md`'s open question #3, do not silently add a refund path here.
