---
id: EVL-02
title: Q1-Q3 evaluation harness (pnpm eval)
module: 02-evaluation
lane: 02-evaluation
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-04, FND-05, FND-06, FND-07, EVL-01]
blocks: [FIT-01, FIT-02, TLR-01, PRP-02]
---

# EVL-02 — Q1-Q3 evaluation harness (pnpm eval)

No ADR — the decision is already made in PRD §6 (the three CI-integrated quality gates and their thresholds); this is build ticket 2 of 2 against the `02-evaluation` module.
Parent sub-PRD: [02-evaluation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-04 — Persisted entity Zod schemas](../../01-foundation/tickets/FND-04-persisted-entity-schemas.md), [FND-05 — Drizzle schema, Neon Postgres client, and migrations](../../01-foundation/tickets/FND-05-drizzle-schema-neon.md), [FND-06 — Model, pricing, and quota configuration](../../01-foundation/tickets/FND-06-model-pricing-quota-config.md), [FND-07 — Server-side validation layer utilities](../../01-foundation/tickets/FND-07-server-validation-layers.md), [EVL-01 — Fixture corpus](EVL-01-fixture-corpus.md)
**Why `builder`:** implementing three fully-specified assertion types (deterministic checks, two LLM-judge checks) against an already-decided fixture corpus and validation-layer utilities — no open design beyond harness plumbing.

## Background + basis

PRD §6 quality-gate table, quoted verbatim (the load-bearing spec for this ticket):

| 门 | 类型 | 断言 | 阈值 |
|---|---|---|---|
| **Q1 结构门** | 确定性 | schema 通过率（含 1 次 repair）；requirement 覆盖恰好一次；questions == 5 且 trap 非空；**tailor 数字完整性违规 = 0**；dropped 率 | 通过率 100%；dropped < 15%（高 dropped 说明 prompt 在瞎绑） |
| **Q2 接地门** | LLM judge（Haiku 4.5） | evidence 能否从对应库条目推出；**每条简历改写能否从源简历/库推出**；gap 的 play 是否具体可执行 | 接地 ≥ 95%；fail 样本人工复核，属实则修 prompt 并固化为回归用例 |
| **Q3 特异门** | judge | 预测问题能否问任何一个随机候选人？能 → fail | ≥ 90% 特异 |

PRD §6 additionally: "前三道进 CI 习惯（`pnpm eval`，每次 prompt / 模型改动必跑，报告落 `eval_runs`）" — this is what names the command and the persistence target this ticket must produce.

PRD §8.1's model-upgrade policy directly depends on this harness existing and being runnable on demand: "任何升级必须先全量通过 Q1–Q3 再切；这条政策本身就是 Q1–Q3 存在的理由之一。"

This ticket builds the **harness** (the runnable machinery: fixture loader, judge caller, assertion functions, report writer). It does NOT itself run the harness against real `04-fit`/`05-tailor`/`06-prep` stage outputs to prove those modules meet the thresholds — that happens later, as `[fixture]` acceptance items baked directly into FIT-01/FIT-02/TLR-01/PRP-02's own tickets (per `docs/prd/breakdown-plan.md` §6 item and the milestone mapping in §5), which import and call this harness's functions. This ticket's own acceptance proves the harness's assertion LOGIC is correct against hand-built mock inputs, not that any real stage passes it yet (those stages don't exist when this ticket runs — `02-evaluation` precedes `03-library` in the DAG).

## Goal

`eval/` (assertion functions for Q1/Q2/Q3, a judge-calling wrapper, a fixture loader) and `scripts/eval.mjs` (the CLI entry point wired as the `pnpm eval` script), such that any downstream stage-owning ticket can `import { assertQ1Schema, assertQ1Coverage, assertQ1Questions, assertQ1NumberIntegrity, assertQ1DroppedRate, assertQ2Grounded, assertQ3Specific } from '@/eval'` and call them against its own stage's real output, and `pnpm eval` runs the full suite end to end (loading fixtures, calling the real stage functions if wired, writing a report to `eval_runs`).

## Non-goals

- No actual stage implementation calls wired in yet — this ticket's own `pnpm eval` run, absent any stage routes existing, operates in a "harness self-check" mode (see Deliverable 6) using mocked stage-output fixtures, not real API calls. `04-fit`/FIT-01/FIT-02 etc. are the tickets that wire real stage outputs into this harness for their own acceptance.
- No Q4 (human, real-world hit-rate) — out of v1 automation entirely, per PRD §6.
- No `eval_runs` table schema changes — FND-04/FND-05 already define it; if insufficient, this ticket appends per FND-04's own Feedback obligation note, not silently.
- No admin-page reporting UI — `07-platform-launch`/PLT-03 reads `eval_runs` for its own purposes if needed; this ticket only writes rows.

## File-scope (write-owns)

- `eval/index.ts` (barrel export), `eval/judge.ts`, `eval/fixtures.ts` (loader for `fixtures/**`), `eval/assertions/q1.ts`, `eval/assertions/q2.ts`, `eval/assertions/q3.ts`, `eval/report.ts` (writes to `eval_runs` via FND-05's `db`)
- `scripts/eval.mjs`
- `eval/**/*.test.ts`
- `package.json` — append `"eval": "node scripts/eval.mjs"` script only (append-only per `docs/prd/breakdown-plan.md` §3; `01-foundation`/FND-01 owns the file's creation).
- Does not touch: `fixtures/**` (EVL-01, read-only import), any `app/api/**` route, `lib/validation/**` (FND-07, read-only import for reuse in Q1's dropped-rate/coverage assertions).
- Serial-safety: FND-04/05/06/07 and EVL-01 are merged before this ticket starts; `package.json`'s append here follows FND-01's creation and FND-05/FND-06's own prior appends (`db:generate`/`db:migrate` scripts, env vars) — sequential, no in-flight contention.

## Deliverables

1. `eval/fixtures.ts` exporting `loadFixtures(): { jds: Array<{ id, category, text }>; resumes: Array<{ id, seniority, text }> }` — reads `fixtures/manifest.json` and the referenced files (EVL-01).
2. `eval/judge.ts` exporting `async function judgeCall(prompt: string): Promise<{ verdict: 'pass' | 'fail'; reasoning: string }>` — calls the Anthropic Messages API with `model: JUDGE_MODEL` (from FND-06's `lib/config/models.ts`), records its own cost via FND-10's `recordUsage()` (op fixed to whichever `UsageOp` the caller is evaluating, e.g. `'cross'` when judging groundedness of CROSS output) so judge-call spend is itself observable per PRD §8.4. Must be mockable (accept an injected fetch/client for tests — do not hardcode the real Anthropic client with no seam, since this ticket's own tests must not make real paid API calls).
3. `eval/assertions/q1.ts` exporting the deterministic checks, each a pure function over already-produced stage output plus context, all operating on FND-03's payload schemas and FND-07's validation-layer outputs:
   - `assertQ1Schema(rawOutput: unknown, schema: ZodType, repairAttempted: boolean): { pass: boolean; detail: string }` — parses `rawOutput` against `schema`; PRD's "含 1 次 repair" means this function accepts a `repairAttempted` flag and the caller is responsible for having already retried once before calling this (this function only checks the FINAL parse result, it does not itself perform the repair retry — that's each stage route's own JSON-repair logic per PRD §5.1's per-stage "JSON 修复重试 1 次 → 报错" failure policy).
   - `assertQ1Coverage(jd: JdExtract, ledger: Ledger): { pass: boolean; uncoveredCount: number }` — reuses FND-07's `ensureRequirementCoverage` to detect any requirement not covered "恰好一次" (exactly once: this function additionally checks no requirement appears in BOTH `bindings` and `gaps`, which `ensureRequirementCoverage` alone doesn't check — that's this assertion's own added check, since PRD says "恰好一次" not just "at least once").
   - `assertQ1Questions(rehearse: Rehearse): { pass: boolean; detail: string }` — checks `questions.length === 5` (already Zod-enforced by FND-03, but re-asserted here as an explicit named Q1 check per PRD's own explicit "questions == 5" wording) and every `trap` is non-empty.
   - `assertQ1NumberIntegrity(tailorOutput: { fullDraftMd: string }, sourcePool: { resumeMd: string; libraryMetrics: string[] }): { pass: boolean; violationCount: number }` — reuses FND-07's `filterNumberIntegrity`; PRD requires "违规 = 0" exactly, so `pass` is `violationCount === 0`.
   - `assertQ1DroppedRate(droppedCount: number, totalCount: number): { pass: boolean; rate: number }` — `pass` is `rate < 0.15` (PRD's "dropped < 15%").
4. `eval/assertions/q2.ts` exporting `async function assertQ2Grounded(claim: string, sourceContext: string): Promise<{ pass: boolean; reasoning: string }>` — builds a judge prompt asking whether `claim` (an evidence string, a resume rewrite, or a gap's `play`) can be derived from `sourceContext` (the cited library project's `summary`/`metrics`/`stack`, or the source resume text), calls `judgeCall()`, returns the verdict. A batch variant `assertQ2GroundedBatch(claims: Array<{claim, sourceContext}>): Promise<{ passRate: number; results: ... }>` computes the aggregate rate against PRD's "≥ 95%" threshold.
5. `eval/assertions/q3.ts` exporting `async function assertQ3Specific(question: RehearseQuestion, candidateContext: string): Promise<{ pass: boolean; reasoning: string }>` — builds a judge prompt asking "could this question be asked of any random candidate, or does it require this specific project's details?" per PRD's exact framing ("预测问题能否问任何一个随机候选人？能 → fail"), and a batch variant computing the aggregate rate against "≥ 90%".
6. `eval/report.ts` exporting `async function writeEvalRun(suite: EvalSuite, op: UsageOp, passRate: number, details: Record<string, unknown>): Promise<void>` — inserts one `eval_runs` row via FND-05's `db` client (schema from FND-04).
7. `scripts/eval.mjs` — CLI entry, wired as `pnpm eval`. In this ticket's own scope (no real stage routes exist yet), it runs a **self-check mode**: loads `fixtures/manifest.json`, constructs hand-built mock stage outputs (e.g. a mock `Ledger`, a mock `Rehearse`) covering both a passing and a deliberately-violating case per assertion, runs every Q1/Q2/Q3 assertion against them, and prints a report — proving the harness itself is correct. Exports a documented extension point (e.g. a `runSuite(stageOutputs)` function) that `04-fit`/`05-tailor`/`06-prep`'s own tickets call with REAL stage output once those stages exist, without needing to modify this script.

## Acceptance checklist (classified)

- [ ] `[machine]` `assertQ1Schema` passes for a Zod-valid mock output and fails for an invalid one.
- [ ] `[machine]` `assertQ1Coverage` fails when a requirement id is absent from both `bindings` and `gaps`, and fails when a requirement id appears in both (the "恰好一次" double-check from Deliverable 3) — two unit tests.
- [ ] `[machine]` `assertQ1Questions` fails when `trap` is an empty string on any of the 5 questions.
- [ ] `[machine]` `assertQ1NumberIntegrity` fails when `violationCount > 0` and passes at exactly `0`.
- [ ] `[machine]` `assertQ1DroppedRate` fails at `rate = 0.15` and passes at `rate = 0.1499...` (boundary test — "< 15%" is strict, not "≤").
- [ ] `[fixture]` `assertQ2Grounded`/`assertQ3Specific`, with `judgeCall` mocked to return deterministic pass/fail verdicts (no real API spend in this ticket's own tests), correctly propagate the mocked verdict through to the batch pass-rate computation — asserted against a hand-built batch with a known expected pass rate (e.g. 3 of 4 passing → 0.75).
- [ ] `[machine]` `writeEvalRun` inserts a row matching FND-04's `EvalRun` schema (integration test against the local/in-memory Postgres substitute established in FND-05).
- [ ] `[machine]` `pnpm eval` (self-check mode) exits 0 and prints a report when run with no real stage output wired in.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Vitest unit tests per assertion function in `eval/assertions/*.test.ts`, using hand-built mock `JdExtract`/`Ledger`/`Rehearse`/`TailoredResume`-shaped objects (reusing FND-03/FND-04's construction patterns from their own test files) — both a clean-passing case and a deliberately-violating case per PRD-cited rule, matching the acceptance checklist above. `judge.ts` is tested with its Anthropic client dependency injected/mocked — no real API calls, no real cost, fully reproducible offline. `eval/report.ts` uses the same local/in-memory Postgres substitute (or mocked Drizzle client) as prior foundation tickets. `scripts/eval.mjs`'s self-check mode is run as a subprocess in one integration test asserting exit code 0.

## Feedback obligation

1. General rule: `04-fit`/FIT-01/FIT-02, `05-tailor`/TLR-01, `06-prep`/PRP-02 each add a `[fixture]` acceptance item that imports this harness and calls `runSuite()` (Deliverable 7) against their real stage output — if any of those tickets finds `runSuite()`'s signature doesn't fit (e.g. needs stage-specific context this ticket didn't anticipate), they extend this ticket's `eval/` files directly (foundation-adjacent, evaluation-owned) and must update this ticket's Deliverables (version +0.1, changelog line in `02-evaluation/README.md`) recording the change before wiring their own stage.
2. If real Q2/Q3 judge runs (once wired to real stage output in later modules) reveal the judge prompts in `q2.ts`/`q3.ts` produce inconsistent verdicts (e.g. the same claim judged pass on one run, fail on another), that is a prompt-quality problem this ticket's Builder — or whichever later ticket first discovers it — must fix in `eval/assertions/q2.ts`/`q3.ts` directly and record the specific failing case as a new fixture/regression entry (extending EVL-01's corpus with a changelog note in `02-evaluation/README.md`), per PRD §6's own instruction: "fail 样本人工复核，属实则修 prompt 并固化为回归用例."
3. Any P0-severity finding (PRD §7: "证据 / 改写幻觉 P0 = 0") surfaced by this harness once real stages are wired must be escalated immediately, not batched — the ticket that discovers it (FIT-02 or TLR-01, most likely) owns the 24h-fix commitment per PRD §7, using this harness's fixture/regression mechanism to lock in the fix.
