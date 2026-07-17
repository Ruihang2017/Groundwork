---
id: FIT-02
title: CROSS and SCORE route
module: 04-fit
lane: 04-fit
size: L
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FIT-01, FND-07, EVL-02]
blocks: [FIT-03, TLR-01, PRP-02]
---

# FIT-02 — CROSS and SCORE route

No ADR — the decision is already made in PRD §5.1 (CROSS/SCORE rows), §5.2 (Fit Report spec), §5.5 (validation layers 1+2); this is build ticket 2 of 3 against the `04-fit` module.
Parent sub-PRD: [04-fit README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FIT-01 — Job creation and lifecycle status route](FIT-01-job-creation-status-route.md), [FND-07 — Server-side validation layer utilities](../../01-foundation/tickets/FND-07-server-validation-layers.md), [EVL-02 — Q1-Q3 evaluation harness](../../02-evaluation/tickets/EVL-02-eval-harness.md)
**Why `builder`:** implementing the CROSS (LLM) + SCORE (deterministic code) sequence, wiring FND-07's already-decided validation layers — no open design beyond the size justification below.

**Size L justification (per this repo's ticket template requirement that any L ticket state why it can't split):** `Job.ledger` and `Job.fit` are both required, non-nullable fields (FND-04) that are only ever set together in this one route — PRD's own stage table lists CROSS's trigger and SCORE's trigger as both "Fit" (the same user action), and SCORE is "纯代码" running immediately on CROSS's output within the same request, with no PRD-sanctioned intermediate persisted state of "ledger without fit". Splitting the CROSS LLM call from the SCORE computation into two tickets would require inventing a persisted half-state FND-04's schema doesn't model, or coordinating two tickets around one atomic write — neither is a clean split, so this ticket keeps both in one route, one deliverable.

## Background + basis

PRD §5.1 CROSS row: "**CROSS** | Fit | `JdExtract × Library` → `Ledger` | 每条 requirement 恰好落入 bindings ∪ gaps 之一；binding 必须引用库条目中的具体技术细节；无量化 PoC 遇 scale/production 类要求封顶 `partial`（P2）；gap 必须给 probe（他们会怎么问）+ play（具体桥接话术） | JSON 修复重试 1 次 → 报错". The "无量化 PoC 遇 scale/production 类要求封顶 `partial`" clause is a specific prompt-level rule: if a `Project` has no metrics (empty `metrics[]`, i.e. a PoC/unquantified project) and the requirement it's matched against involves scale/production language, the binding's `strength` must be `'partial'`, never `'strong'` — this directly implements PRD §2 P2's "无量化…绑定强度封顶 `partial`".

PRD §5.1 SCORE row: "**SCORE** | Fit（纯代码） | `Ledger` + weights → `FitReport` | 子分与综合分是 ledger 的确定性函数（strong=1 / partial=0.5 / gap=0，按 requirement weight 加权归一）；**模型不输出分数** | n/a". This is a pure function — no LLM call, no `usage_events` row of its own (per `04-fit/README.md`'s decision, its cost is folded into the `cross` op's single usage event).

PRD §5.2, quoted verbatim (the Fit Report spec this SCORE function must produce): "**硬性条件**（签证 / 地点 / 年限 / 语言）逐条 pass / fail / unknown，置顶展示。**四个子分**（0–100）：技术栈匹配、经验深度、领域匹配、证据强度——各自列出支撑 bindings 与 gaps，分数可下钻到证据。**综合分 + 档位**：≥75 Strong / 55–74 Competitive / 35–54 Stretch / <35 Long shot。档位给建议语 + top gaps（含 probe/play）。**诚实标注**：分数是启发式匹配度，**不是录取概率**". Hard requirements (visa/location/years/language) are NOT part of `JdExtract.requirements` (which are weighted/categorized technical-etc. requirements per FND-03) — they must be separately extracted; per `04-fit/README.md`'s no-legacy-prompt caveat, this ticket's CROSS prompt (or a small dedicated extraction step within the same call) must also produce `FitReport.hardRequirements` inputs. Document this as this ticket's own design resolution: CROSS's prompt additionally asks the model to classify hard-requirement-bearing JD text (visa/location/years/language) as pass/fail/unknown against the library's `Profile`, returned alongside `Ledger` in the same LLM call (not a separate stage — PRD's stage table has no dedicated "hard requirements" stage, so this is folded into CROSS as the most natural home, since both read `JdExtract` and produce Fit-Report-feeding output).

PRD §5.5 layers 1 and 2 apply here specifically: "1. Referential integrity: `projectId ∈ library`… 2. Requirement 覆盖检查：READ 提取的 requirement 未在 CROSS 输出中出现 → 自动补入 gaps（标记 `uncovered — rerun`）." — both implemented via FND-07's `filterByReferentialIntegrity` and `ensureRequirementCoverage`.

## Goal

`app/api/jobs/[id]/fit/route.ts` (`POST`, no body needed beyond the job id — operates on the already-persisted `job.jd` and the caller's `Library`) that runs CROSS (LLM → raw `Ledger` + hard-requirement classifications), applies FND-07's referential-integrity and requirement-coverage layers, then runs SCORE (pure function, `lib/scoring/score.ts`) to produce `FitReport`, persists both via FIT-01's `attachLedgerAndFit`, and returns the completed `Job`.

## Non-goals

- No Tailor/Prep content — `05-tailor`/`06-prep`.
- No re-checking the `fit` quota — already charged once at FIT-01's job-creation step (per `04-fit/README.md`'s decision); this route does NOT call `checkAndIncrementQuota` again, but DOES call `checkGlobalBreaker()` again immediately before its own paid LLM call (the breaker is a point-in-time global check, not a per-operation allowance, so re-checking it here — potentially seconds after FIT-01's check — is correct and required, not redundant).
- No Fit Report UI — FIT-03.

## File-scope (write-owns)

- `app/api/jobs/[id]/fit/route.ts`, `app/api/jobs/[id]/fit/route.test.ts`
- `lib/scoring/score.ts`, `lib/scoring/score.test.ts`
- `lib/cross/prompt.ts` (the CROSS stage prompt)
- Does not touch: `app/api/jobs/route.ts`/`app/api/jobs/[id]/route.ts` (FIT-01, this ticket only calls FIT-01's exported `lib/db/queries/jobs.ts` functions), `lib/validation/**` (FND-07, read/import only).
- Serial-safety: FIT-01 merged before this ticket starts (same lane, sequential); FND-07 and EVL-02 merged as part of their own modules' full delivery before `04-fit` began.

## Deliverables

1. `lib/cross/prompt.ts` exporting the CROSS stage prompt, instructing the model to: (a) produce `Ledger.bindings`/`Ledger.gaps` per PRD's "每条 requirement 恰好落入 bindings ∪ gaps 之一" and the partial-strength-on-unquantified-scale-requirements rule (Background); (b) additionally classify hard requirements (visa/location/years/language, extracted from the JD text) as pass/fail/unknown against the library `Profile`, per this ticket's Background resolution.
2. `lib/scoring/score.ts` exporting `computeFitReport(ledger: Ledger, jd: JdExtract, hardRequirements: HardRequirementCheck[]): FitReport` — pure function: for each of the four sub-score categories (technical/experienceDepth/domain/evidenceStrength), maps each `jd.requirements[]` entry's `category` to the relevant sub-score bucket (technical→technical, experience→experienceDepth, domain→domain; PRD names a fourth sub-score "证据强度"/evidenceStrength with no corresponding `RequirementCategory` value — resolve this by computing `evidenceStrength` from the overall `strong`/`partial` ratio across ALL bindings regardless of category, not from a requirement-category subset, since no PRD requirement category maps to "evidence strength" directly; document this inline), computes each bucket's score as `weightedSum(strong=1, partial=0.5, gap=0) / weightedSum(all weights in bucket) * 100`, rounds to an integer 0–100; computes `compositeScore` as the weighted average of the four sub-scores (equal weighting across the four, since PRD specifies no differential weighting between them); maps `compositeScore` to `tier` via the exact PRD thresholds (`>=75` Strong, `55-74` Competitive, `35-54` Stretch, `<35` Long shot); populates `topGaps` as the highest-weight `Gap`s (by originating requirement weight, descending, capped at a small number — PRD doesn't state a cap for `topGaps` specifically, unlike the 5/3-capped Rehearse fields; use the requirement weight-3 gaps first, falling back to weight-2 if none, and note this as a documented judgment call, not a literal PRD number); generates `advice` text templated from the tier (per PRD's "档位给建议语").
3. `app/api/jobs/[id]/fit/route.ts` `POST` handler: (a) `requireUserId()`; (b) `getJob(userId, jobId)` (FIT-01) — HTTP 404 if not found/not owned; (c) `getLibrary(userId)` (LIB-02) — HTTP 409 `{ error: 'no_library' }` if somehow absent (defensive — should be unreachable since FIT-01 already gated job creation, but a library could theoretically be deleted between job creation and Fit, though `03-library`/LIB-02's Non-goals says no delete endpoint exists in v1, making this genuinely unreachable in practice; keep the check anyway as defense-in-depth, documented as such); (d) `checkGlobalBreaker()` (FND-06) — HTTP 503 if tripped; (e) call Anthropic with `PRIMARY_MODEL`, the CROSS prompt, `job.jd` and the `Library`; parse the raw response against a Zod shape covering both `Ledger` and the hard-requirement classifications, one JSON-repair retry, HTTP 422 on unrecoverable failure; (f) apply `filterByReferentialIntegrity` (FND-07) to `rawLedger.bindings` and to any `RehearseQuestion`-like reference — N/A here, only bindings carry `projectId` at this stage — using `getValidProjectIds(library)`; (g) apply `ensureRequirementCoverage` (FND-07) to the filtered `Ledger` against `job.jd`; (h) call `computeFitReport` (Deliverable 2) with the final `Ledger` + hard-requirement classifications; (i) `attachLedgerAndFit(userId, jobId, ledger, fit)` (FIT-01's exported query function); (j) `recordUsage()` (FND-10) with `op: 'cross'`, `droppedCount` = the sum of layers 1+2's dropped/injected counts; (k) return the completed `Job` with HTTP 200.

## Acceptance checklist (classified)

- [ ] `[machine]` `computeFitReport` is deterministic: called twice with byte-identical `Ledger`/`JdExtract`/`hardRequirements` inputs produces byte-identical `FitReport` output (unit test, directly proving PRD's "确定性函数").
- [ ] `[machine]` `computeFitReport` maps `compositeScore = 75` to tier `'Strong'`, `74` to `'Competitive'`, `55` to `'Competitive'`, `54` to `'Stretch'`, `35` to `'Stretch'`, `34` to `'Long shot'` — exact PRD boundary tests (all four thresholds, both sides of each boundary, 8 assertions).
- [ ] `[machine]` A binding whose evidence project has `metrics: []` and whose matched requirement text contains a scale/production keyword (e.g. "at scale", "production") is capped at `strength: 'partial'` in the CROSS prompt's expected output — this is a prompt-quality property validated via the `[fixture]` item below, not a pure unit test (the capping is the model's job per the prompt, not code-enforced — flagged explicitly here as a prompt responsibility, unlike the machine-enforced items).
- [ ] `[fixture]` For each of EVL-01's 10 JD fixtures (paired with one of EVL-01's 3 resume fixtures, cycling deterministically e.g. `jd[i] × resume[i % 3]`), calling this route (Anthropic client mocked to return a canned valid `Ledger` + hard-requirement response per fixture pair) produces a `Ledger` where every `jd.requirements[].id` appears in `bindings` or `gaps` exactly once (via `02-evaluation`/EVL-02's `assertQ1Coverage`), and a `dropped` rate `< 15%` (via `assertQ1DroppedRate`) — the concrete `[fixture]` acceptance item feeding PRD §10 P2's "Q1 全绿" for the CROSS half of Fit.
- [ ] `[fixture]` For a subset of the same fixture pairs, running `02-evaluation`/EVL-02's `assertQ2GroundedBatch` against each binding's `evidence` text (checking it can be derived from the matched `Project`'s `summary`/`metrics`/`stack`) achieves `passRate >= 0.95` — the concrete `[fixture]` acceptance item feeding PRD §10 P2's "Q2 接地 ≥ 95%". (This item requires a real or realistically-mocked judge call — if run against a mocked judge in this ticket's own CI-bound tests, ALSO document a manual/scheduled real-judge run before P2 sign-off, same pattern as `03-library`/LIB-01's manual-smoke note.)
- [ ] `[machine]` `pnpm test` green.

## Test plan

Unit tests for `computeFitReport` (pure function, no mocks needed — exhaustive boundary-value tests per the acceptance checklist). Route-level integration tests mock the Anthropic client and use the local/in-memory Postgres substitute for `attachLedgerAndFit`. `[fixture]` items run against EVL-01's fixture corpus with the Anthropic client and (for the Q2 item) EVL-02's `judgeCall` both mocked with deterministic canned responses for CI-reproducibility; a separate manually-triggered real-model smoke run (documented in a code comment, same convention as LIB-01) validates against the real Anthropic and Haiku APIs before P2 milestone sign-off, since real Q1/Q2 pass rates against the ACTUAL model cannot be proven by a mocked CI run alone.

## Feedback obligation

1. General rule: `computeFitReport`'s `evidenceStrength` sub-score definition (Deliverable 2 — computed from the overall strong/partial ratio, not a requirement-category subset) is this ticket's own resolution of a real PRD ambiguity (four sub-scores named, only three map cleanly to `RequirementCategory`) — if this reads wrong once real Fit Reports are reviewed (FIT-03's dogfood pass), that is a scoring-formula reversal requiring Horace's sign-off (PRD §13 Q1's spirit: "没有 ground truth 时调参数是迷信" applies to changing the FORMULA, not just weights) — escalate, do not silently retune.
2. If the real Q2 groundedness pass rate (from the manually-triggered real-model run, Test plan) comes in below 95%, that is a P0-severity PRD §7 finding ("证据 / 改写幻觉 P0 = 0" is the stricter zero-tolerance metric for outright hallucination; a sub-95%-but-nonzero groundedness rate is the milder Q2 gate, still requires the 24h-fix-and-regression-fixture commitment per PRD §6's own text: "fail 样本人工复核，属实则修 prompt 并固化为回归用例") — fix `lib/cross/prompt.ts` and add the failing case to `02-evaluation`'s fixture corpus via that module's own changelog convention, do not lower the threshold to make the gate pass.
3. The `topGaps` cap (Deliverable 2, "no literal PRD number, judgment call") should be revisited once FIT-03's actual report page is built and Horace's dogfood pass shows whether the chosen cap reads well — if changed, update this ticket (version +0.1, changelog line in `04-fit/README.md`) rather than silently tuning in the UI layer to compensate for a wrong API-level cap.
