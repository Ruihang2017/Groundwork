---
id: FND-07
title: Server-side validation layer utilities
module: 01-foundation
lane: 01-foundation
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-02, FND-03]
blocks: [EVL-02, FIT-02, TLR-01, PRP-02]
---

# FND-07 — Server-side validation layer utilities

No ADR — the decision is already made in PRD §5.5 (the four validation layers, stated as a fixed list); this is build ticket 7 of 10 against the `01-foundation` module.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-02 — Core simple-entity Zod schemas](FND-02-core-entity-schemas.md), [FND-03 — Pipeline stage payload Zod schemas](FND-03-pipeline-payload-schemas.md)
**Why `builder`:** PRD §5.5 fully specifies the four layers' behavior; implementing them as pure functions against FND-02/FND-03's already-decided types is mechanical, not a design task.

## Background + basis

PRD §5.5, quoted verbatim in full (this is the entire load-bearing spec for this ticket):

> 所有 stage 输出先过 Zod v4 schema，再执行四层过滤：
>
> 1. **Referential integrity**：`projectId ∈ library`，否则从 bindings / edits / questions 中移除，dropped 计数随响应返回，前端可查看被弃原始条目（透明性）。
> 2. **Requirement 覆盖检查**：READ 提取的 requirement 未在 CROSS 输出中出现 → 自动补入 gaps（标记 `uncovered — rerun`）。宁可暴露不完整，不静默吞掉。
> 3. **数字完整性（TAILOR）**：产出中的数值不存在于源简历/库 → 剔除并计数（P2 的机器实现）。
> 4. **废话黑名单**（regex）：`be honest` / `stay calm` 类命中即标记 low-quality，记录不阻断——作为 prompt 回归信号。

Layer 1 applies to three different payload shapes (`Ledger.bindings`, `TailoredResume.edits`, `Rehearse.questions`) — each carries a `projectId: z.string()` field (FND-03). Layer 1 must be generic over "any array of objects with a `projectId` field", not three copies.

Layer 2 applies specifically to CROSS's output: every `JdExtract.requirements[].id` must appear as either a `Binding.requirementId` or a `Gap.requirementId` in the produced `Ledger`; any requirement id missing from both must be auto-inserted into `Ledger.gaps` with a marker. PRD says "标记 `uncovered — rerun`" — this ticket encodes that marker as the `Gap.probe` field's value (the only free-text field available on `Gap` per FND-03's schema) since `Gap` has no separate "reason" field — document this mapping explicitly in code comments so `04-fit`/FIT-02 (the only consumer) knows to check for this literal marker string when deciding whether to surface a "rerun" affordance.

Layer 3 applies specifically to `TailoredResume.fullDraftMd` (and arguably `Edit.suggested`, since edits also carry rewritten text) — PRD §5.3: "输出中任何数值必须存在于源简历或库 metrics（服务端 regex 交叉校验，违规条目剔除并计数展示）" — the source-of-truth number pool is `Resume.sourceMd` (FND-02) plus the union of every `Project.metrics[]` string in the user's `Library` (FND-02). This is a regex-based numeric-token extraction and cross-check, per PRD's own "regex 交叉校验" phrasing — not an LLM-based check.

Layer 4 is a static regex blacklist over any generated free-text field; PRD names two example phrases ("`be honest`" / "`stay calm`") as "类" (a category), implying a short list of similar filler/hedging phrases, not just those two literal strings — this ticket picks a small, documented starter list and flags it as adjustable (see Feedback obligation), since PRD does not enumerate the full list.

Each layer's counted/dropped output feeds PRD §5.7's UI requirement ("产出展示 | dropped > 0 表头计数、可展开被弃条目") and PRD §6 Q1's threshold ("dropped < 15%") — this ticket's functions must return both the filtered result AND a structured record of what was dropped/flagged (not just filter silently), since both downstream needs (UI display, eval assertions) read the dropped list, not just a count.

## Goal

`lib/validation/` exporting four independent, pure (no DB/network access) functions — one per layer — each taking a stage output object plus the context it needs (library, resume, jd) and returning `{ result: <filtered output>, dropped: <array of removed items with reason>, flagged?: <array, layer 4 only> }`.

## Non-goals

- No DB queries — these are pure functions over already-fetched data (the caller fetches `Library`/`Resume`/`Job` and passes them in); no `db/**` import.
- No wiring into any actual API route — that's each stage-owning ticket's job (FIT-02 for layers 1+2, TLR-01 for layers 1+3, PRP-02 for layer 1 on `Rehearse.questions`). Layer 4 (blacklist) is generic and any ticket producing free text may call it, but this ticket does not decide which tickets must call it beyond what PRD §5.5 implies (a general regression signal, "记录不阻断") — non-blocking by design, so omission by a downstream ticket is a quality gap, not a correctness bug; flagged in this ticket's Feedback obligation as something the Reviewer stage should check per-consumer.
- No UI (dropped-count banners, expandable dropped-item lists) — PRD §5.7's UI requirement is each feature module's own page ticket (FIT-03, TLR-02, PRP-04).
- No eval-harness Q1/Q2 assertion logic — `02-evaluation`/EVL-02 reuses this ticket's dropped-rate output but owns the assertion/threshold logic itself.

## File-scope (write-owns)

- `lib/validation/referential-integrity.ts`, `lib/validation/requirement-coverage.ts`, `lib/validation/number-integrity.ts`, `lib/validation/blacklist.ts`, `lib/validation/index.ts` (barrel re-export)
- `lib/validation/*.test.ts` (one per layer)
- Does not touch: `lib/schemas/**` (FND-02/03/04, read/import only), any `app/api/**` route file (downstream modules wire these functions in, this ticket does not call itself from a route).
- Serial-safety: FND-02/03 merged before this ticket starts; no in-flight contention (FND-04/05/06 may be building concurrently within the same lane per the DAG in `docs/prd/breakdown-plan.md`, but none of them write to `lib/validation/**`).

## Deliverables

1. `lib/validation/referential-integrity.ts` exporting `filterByReferentialIntegrity<T extends { projectId: string }>(items: T[], validProjectIds: Set<string>): { result: T[]; dropped: Array<{ item: T; reason: 'projectId not in library' }> }` — generic over `Binding`/`Edit`/`RehearseQuestion`, all of which carry `projectId` (FND-03). Also export a convenience `getValidProjectIds(library: Library): Set<string>` (from FND-02's `Library.projects[].id`).
2. `lib/validation/requirement-coverage.ts` exporting `ensureRequirementCoverage(jd: JdExtract, ledger: Ledger): { result: Ledger; injectedGaps: Gap[] }` — for every `jd.requirements[].id` not present in `ledger.bindings[].requirementId` or `ledger.gaps[].requirementId`, appends a new `Gap` to the returned `Ledger.gaps` with `probe: 'uncovered — rerun'` and `play: ''` (empty — there is nothing to bridge for a requirement the model never addressed; document this literal empty-string choice inline since PRD does not specify a `play` value for the injected case).
3. `lib/validation/number-integrity.ts` exporting `filterNumberIntegrity(text: string, sourcePool: { resumeMd: string; libraryMetrics: string[] }): { result: string; dropped: Array<{ token: string; reason: 'number not found in source resume or library metrics' }> }` — extracts numeric tokens from `text` via regex (covering integers, decimals, percentages, currency amounts, and common suffixes like "K"/"M"/"x" as used in resume metrics, e.g. "40%", "$1.2M", "3x"), checks each against the numeric tokens present in `sourcePool.resumeMd` + the concatenation of `sourcePool.libraryMetrics`, and removes (not just flags) any numeric claim not found in the source pool from the returned `result` text, counting each removal in `dropped`. Also export `extractNumericTokens(text: string): string[]` as a reusable primitive (used both internally and potentially by `02-evaluation`'s Q1 dropped-rate assertions).
4. `lib/validation/blacklist.ts` exporting `BLACKLIST_PATTERNS: RegExp[]` (starter list: phrases matching "be honest", "stay calm", "at the end of the day", "it's important to note" — documented inline as an initial, adjustable set per PRD's "类" wording) and `flagBlacklistedPhrases(text: string): { flagged: Array<{ pattern: string; match: string }> }` — non-mutating (per PRD: "记录不阻断"), returns matches only, never removes text.
5. `lib/validation/index.ts` re-exporting all of the above for a single import surface (`import { filterByReferentialIntegrity, ensureRequirementCoverage, filterNumberIntegrity, flagBlacklistedPhrases } from '@/lib/validation'`).

## Acceptance checklist (classified)

- [ ] `[machine]` `filterByReferentialIntegrity` removes an item whose `projectId` is not in the provided set and reports it in `dropped`, leaving valid items in `result` (unit test with a mixed-validity array).
- [ ] `[machine]` `ensureRequirementCoverage` injects exactly one `Gap` with `probe: 'uncovered — rerun'` for a `JdExtract` requirement absent from both `bindings` and `gaps` in a test `Ledger`, and injects nothing when every requirement is already covered (two unit tests, positive and negative case).
- [ ] `[machine]` `filterNumberIntegrity` removes a numeric claim (e.g. `"grew revenue 45%"`) from `text` when `"45%"` appears in neither `sourcePool.resumeMd` nor any `sourcePool.libraryMetrics` entry, and retains it when it does appear in either source (two unit tests).
- [ ] `[machine]` `flagBlacklistedPhrases` matches `"be honest"` case-insensitively and does not alter the input text (unit test comparing input/output equality plus a non-empty `flagged` array).
- [ ] `[machine]` `pnpm test` green.
- No `[human]` criteria — pure logic, fully machine-checkable against the PRD §5.5 spec quoted in Background.

## Test plan

Vitest unit tests, one file per layer (`lib/validation/referential-integrity.test.ts`, etc.), each with hand-built fixture objects covering the happy path and the PRD-cited edge case (missing projectId, uncovered requirement, out-of-source number, blacklisted phrase). No external fixtures/DB needed — these are pure functions; do not reference `fixtures/**` (not yet built at this point in the DAG — `02-evaluation` starts after this ticket).

## Feedback obligation

1. General rule: every downstream ticket that produces model output containing a `projectId`-bearing array (FIT-02's `Ledger.bindings`, TLR-01's `TailoredResume.edits`, PRP-02's `Rehearse.questions`) MUST call `filterByReferentialIntegrity` and surface its `dropped` count in the response — if any of those tickets' implementation finds this function's signature doesn't fit their exact call shape, they update this ticket's Deliverable 1 (version +0.1, changelog line in `01-foundation/README.md`) and widen the generic type, rather than reimplementing the filter locally.
2. Layer 4's starter blacklist (Deliverable 4) is explicitly a judgment call, not a PRD-specified exhaustive list — if real usage (post-P5) shows the list under- or over-triggers, that is a prompt/config tuning question for Horace, not a ticket-level code change without a decision record; note the adjustment in `01-foundation/README.md`'s open questions if it needs to change materially (e.g. adding many more phrases would push this from "starter list" toward "policy list" requiring product sign-off).
3. Layer 3's numeric-token regex (Deliverable 3) is the P2 principle's actual enforcement mechanism ("Retrieve, don't generate。数字永不虚构… 服务端校验") — if the regex is found to have false negatives (a fabricated number slips through because its format wasn't anticipated) during `05-tailor`/TLR-01's own Q1/Q2 fixture testing, that is a P0-severity quality gap per PRD §7 ("质量 | 证据 / 改写幻觉 P0 | = 0（发现 → 24h 修 prompt + 样本固化进 Q2 回归）") — TLR-01 must fix the regex here (this file is foundation-owned but the fix is urgent and narrowly scoped) and record the fixture that caught it as a new EVL-01 regression case, not just patch silently and move on.
