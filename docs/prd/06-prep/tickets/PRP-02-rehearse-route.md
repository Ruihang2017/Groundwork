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

## Changelog

- v0.1 (2026-07-24, Builder writeback): implemented against `docs/plans/PRP-02.md`. Three new source files + two new test files — `lib/rehearse/prompt.ts`, `lib/db/queries/briefs.ts` (+ `briefs.test.ts`), `app/api/jobs/[id]/rehearse/route.ts` (+ `route.test.ts`). No migration, no new dependency, no Anthropic SDK, no change to any file outside this ticket's write-scope (`lib/schemas/**`, `lib/config/**`, `lib/validation/**`, `lib/usage/**`, `lib/db/queries/{jobs,library,tailored-resumes}.ts`, `db/**`, `eval/**`, `fixtures/**`, and every peer route all untouched).

  ### The load-bearing decision — flagged for the Reviewer (plan D5)

  - **D5 — a persisted `Brief` may carry FEWER than 5 REHEARSE questions.** FND-03's `Rehearse.questions` is `.length(5)` EXACTLY, but PRD §5.5 layer 1 (Deliverable 3f) drops a question whose `projectId` is not in the library, and acceptance item 5 requires that dropped question to be *removed from the persisted `rehearse.questions` and counted*. So a stored `Brief` can legitimately have 0–5 questions — not a valid FND-03 `Rehearse`/`Brief`. Since `lib/schemas/**` is 01-foundation's file-scope, this ticket resolves it **module-locally** in `lib/db/queries/briefs.ts`: `const PersistedRehearse = Rehearse.extend({ questions: z.array(RehearseQuestion).max(5) })` and `PersistedBrief = Brief.extend({ rehearse: PersistedRehearse })` (allowed by `breakdown-plan.md` §3, same as FIT-02's local `CrossOutput`). The strict `.length(5)` still applies to the route's **pre-filter model-output parse** (`validateCall`); only the persistence round-trip uses the relaxed shape. A machine test pins that a 4-question value round-trips through `briefs.ts` **and** fails a strict `Rehearse.safeParse`. **This is a hard-to-reverse schema/product choice** — the durable fix (relax FND-03, or hard-fail on a hallucinated `projectId` instead of drop-and-persist) belongs to Horace + 01-foundation, coordinated with EVL-02's `assertQ1Questions` (which FAILS on < 5) and PRP-04's read path (plan §5 Q1 / §6 ADR-A). NOT changed in FND-03 here.

  ### Deliberate extensions of Deliverable 3 (flagged for the Reviewer)

  - **409 `no_library` gate ADDED (plan D3).** Deliverable 3 is silent on it. Without a library `getValidProjectIds` is empty and referential integrity would drop **all 5** questions, and the prompt would have no ids to cite; FIT-02 returns `no_library` for the same defence-in-depth reason. Practically unreachable (REHEARSE is gated behind `fit_not_ready`, and a fit implies a library existed), kept anyway. A `getLibrary` **throw** is a 500 `library_read_failed`, NOT `no_library` (telling a user who HAS a library to import one is a wrong CTA on a real bug — FIT-02's reasoning).
  - **Additive `dropped` envelope on the 200 (plan D2).** The ticket says "return the Brief" (3i), but PRD §5.5 layer 1 MANDATES "dropped 计数随响应返回，前端可查看被弃原始条目（透明性）", and FIT-02 already returns exactly this. The 200 body is the persisted `Brief` plus `dropped: { count, questions: Array<{ item, reason }> }`, `Cache-Control: no-store`. `Brief.parse()` strips the extra key harmlessly. KNOWN LIMITATION (same as FIT-02): `dropped.questions` is not persisted → render-once, lost on refresh (PRP-04 then sees only surviving questions via `getBrief`).

  ### Design resolutions implemented (plan §0.1 — each recorded at its implementation site)

  - **D1** — REHEARSE receives `job.jd` (JdExtract) + `job.ledger` (Ledger) + the caller's `Library` with `profile.contact` STRIPPED + the body's `intel` (`Intel | null`). **Never `job.jdRaw`.** Unlike RESEARCH there is no `web_search`, so nothing leaves the Anthropic boundary. A test pins that `jdRaw` and the contact email never appear in the request body, and that the JD extract does.
  - **D4 — STRICT failure, the deliberate contrast with PRP-01.** A reply unusable after ONE JSON-repair turn ⇒ **HTTP 422 `rehearse_failed`**, NOT a degraded 200: PRD §5.1 REHEARSE failure is "同上" (READ/CROSS's "JSON 修复重试 1 次 → 报错") and `Brief.rehearse` is non-nullable (FND-04), so a partial brief cannot even be persisted. A transport/HTTP/timeout failure on the paid call is likewise 422 with no repair; a `getJob`/`getLibrary`/`upsertBrief` throw is a 500 (infra, not a model failure). Tests pin 422 (not 200) with no row written, exactly-one-fetch on a transport failure, and exactly-two-fetch on a two-reply-unusable case.
  - **D6/D7** — hard-failure classes in order: truncation; no extractable JSON; `Rehearse.safeParse` failure (**including `questions.length !== 5`, `askThem.length !== 3`, empty `trap` — over-length arrays are REPAIRED, never sliced**); a NUL byte; a blank required string not covered by Zod (`question`/`projectId`/`positioning`/`askThem[]` — FND-03 gives `.min(1)` only to `trap`). One repair turn, deadline-aware, re-sending STRUCTURE only (no jd/ledger/library/intel). A table-driven test drives every hard case through repair-then-succeed; a test pins the repair body carries neither the input payloads nor a `tools` key but does repeat the count/citation rules.
  - **D8** — body parsed against `z.object({ intel: Intel.nullable() })` (`intel` KEY required, may be `null`); a JSON-parse throw or Zod failure ⇒ 400 `invalid_body`; a NUL byte in `body.intel` ⇒ also 400 (protects the `briefs.intel` jsonb write). The `null` case emits an explicit "No company research is available" sentinel inside `<intel>` and proceeds.
  - **D9** — output language follows the JD (REHEARSE receives `job.jd`, unlike RESEARCH). Accepted minor caveat: `intel` arrives in English (PRP-01 D9d), so a non-English JD yields a small in-brief language mix (reversible — plan §5 Q4).
  - **D10** — `REHEARSE_MAX_TOKENS = 4096`, `ANTHROPIC_TIMEOUT_MS = 40_000`, `HANDLER_DEADLINE_MS = 55_000`, `MIN_REPAIR_BUDGET_MS = 8_000`, `maxDuration = 60`, `runtime = 'nodejs'`. **No `tools` key** (a test pins its absence).
  - **D11** — `recordUsage` on SUCCESS only, exactly once, `op: 'rehearse'`, `searches: 0`, `droppedCount` = referential-integrity drop count, tokens summed across both calls; wrapped in try/catch so a logging failure never turns a committed Brief into a 500. A 422 records nothing (known gap, below).
  - **D12** — only PRD §5.5 layer 1 (referential integrity) applies to `rehearse.questions`; not layers 2–4 (recorded as a decision, not an omission).
  - **D13 — overwrite, NO replay guard.** `upsertBrief` overwrites one Brief per `jobId` (TLR-01's re-run pattern); a test pins that a second POST returns 200 (NOT FIT-02's 409 `already_fitted`) and leaves one row. **Cost asymmetry flagged (plan §4 R1 / §5 Q2):** unlike TLR-01 (charges `tailor` every call), this route charges NOTHING per call (the `prep` unit was charged upstream at PRP-01), so unguarded overwrite = unbounded paid REHEARSE per single `prep` unit, bounded only by the org-wide breaker + the single-flight instruction the route header gives PRP-03/PRP-04. The ticket SPECIFIES overwrite, so the guard is escalated to Horace, NOT added silently.

  ### Confirmations required by upstream tickets

  - **FND-06's `QUOTA_OP_TO_USAGE_OP` re-confirmed** (its comment names PRP-02 explicitly): `prep → 'research'`, charged once by PRP-01. This route records `op: 'rehearse'`, which is NOT a quota-mapped op, and calls **no `checkAndIncrementQuota`** — a test asserts the quota module's increment fn is never invoked. `lib/config/quota.ts` needs no change and was not edited.
  - **Known gap carried forward, not fixed here (plan §5 Q3 / §4 R5)**: a 422 path writes no `usage_events` row, so the global breaker under-counts REHEARSE's token spend. FND-10 supports `status:'failure'`, but recording it would consume `prep` quota (FND-06 counts rows regardless of status) — a repo-wide product/cost decision for Horace; all stage routes change together or not at all. NOT changed unilaterally here.

  ### `[fixture]` Q1/Q3 acceptance — what the mocked suite does and does NOT prove

  Acceptance items 3 (Q1) and 4 (Q3) run the route end-to-end over the first N `loadFixtures().jds`, with the **model mocked** (canned valid `Rehearse`, all projectIds valid → nothing dropped → 5 survive) and the **Q3 judge mocked** (`judgeCallImpl`). `assertQ1Questions(brief.rehearse).pass === true` and `assertQ3SpecificBatch(...).passRate >= 0.90` therefore prove **WIRING only** — that the route persists 5 unmodified questions and surfaces them in a shape EVL-02's assertions accept — feeding PRD §10 P4's "Q1 全绿 / Q3 ≥ 90%" plumbing. They say **nothing** about real question quality.

  ### Manual smoke run (P4 sign-off status)

  **NOT performed — no `ANTHROPIC_API_KEY` in the build environment.** This is a **P4 sign-off BLOCKER for Horace** (plan §7 step 7 / ticket Feedback obligation #1): `pnpm test` stubs `globalThis.fetch` and injects the judge on every test, so a green suite proves wiring only. The real Q3 specificity pass rate against a real model + real judge (the recipe at the bottom of `lib/rehearse/prompt.ts`, plus `pnpm eval`'s Q3 suite) must clear the PRD §6 / §10 P4 90% gate before P4 sign-off; a sub-90% result means fixing the prompt (project-specific technical depth over generic behavioural framing) and固化ing the failing case in 02-evaluation's corpus — never lowering the threshold.

  ### Test results

  `pnpm test`: **80 files / 1087 tests green** (baseline before this ticket on `main` @ `92f5ea0`: 78 files / 1040 tests; this ticket adds 2 files / 47 tests — 8 in `briefs.test.ts`, 39 in `rehearse/route.test.ts`). `pnpm lint`: clean. `pnpm build` with `DATABASE_URL` unset: exit 0 ("Compiled successfully"), with `/api/jobs/[id]/rehearse` in the route table. The plan §3 mutation check was executed and confirms the suite is non-vacuous: (1) flipping the STRICT 422 → 200 fails 3 tests; (2) removing the `not_interviewing` gate fails 1 test; (3) relaxing `validateCall`'s `questions.length` check fails 3 tests (incl. the length-4 repair case); (4) skipping the referential-integrity filter fails the acceptance-5 drop test.
