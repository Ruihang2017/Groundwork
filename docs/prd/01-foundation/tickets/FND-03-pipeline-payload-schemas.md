---
id: FND-03
title: Pipeline stage payload Zod schemas
module: 01-foundation
lane: 01-foundation
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-01]
blocks: [FND-04, FND-07, FIT-01, TLR-01, PRP-01]
---

# FND-03 — Pipeline stage payload Zod schemas

No ADR — the decision is already made in PRD §5.1–§5.4 (per-stage rules); this is build ticket 3 of 10 against the `01-foundation` module.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-01 — Repo and toolchain bootstrap](FND-01-repo-toolchain-bootstrap.md)
**Why `builder`:** field-level shape is derivable mechanically from the per-stage rule prose in PRD §5.1–§5.4, even though (unlike FND-02) no literal code sketch exists — this is still transcription against a fixed, cited source, not open design.

## Background + basis

PRD §5.6 names these types by reference (`Job.jd: JdExtract`, `Job.ledger: Ledger`, `Job.fit: FitReport`, `TailoredResume.alignment: Alignment`, `TailoredResume.edits: Edit[]`, `Brief.intel: Intel.nullable()`, `Brief.rehearse: Rehearse`) but does not give their field-level shape in the code block. That shape must be derived from PRD §5.1's stage table and §5.2–§5.4's feature specs, quoted below per type.

**JdExtract** (READ stage, PRD §5.1 row): "requirements ≤ 11、weight 1–3（3 = 没有就不招）、每条打 category（technical / experience / domain / logistics）；atsKeywords 列表；subtext ≤ 3".

**Ledger** (CROSS stage, PRD §5.1 row): "每条 requirement 恰好落入 bindings ∪ gaps 之一；binding 必须引用库条目中的具体技术细节；无量化 PoC 遇 scale/production 类要求封顶 `partial`（P2）；gap 必须给 probe（他们会怎么问）+ play（具体桥接话术）". A binding therefore needs at minimum: which requirement it answers, which `Project.id` it binds to, a strength level, and the evidence text. PRD §5.5 layer 1 additionally requires each binding to carry a `projectId` field checkable against the library ("`projectId ∈ library`，否则从 bindings / edits / questions 中移除"). PRD §5.2 names the strength vocabulary used by SCORE: "strong=1 / partial=0.5 / gap=0" (from §5.1 SCORE row) — so binding `strength` is one of `'strong' | 'partial'`; gaps are the `strength=0` case and live in a separate `gaps` array (not a `strength: 'gap'` binding), matching "每条 requirement 恰好落入 bindings ∪ gaps 之一" (a disjoint union, not a single array with a gap variant).

**FitReport** (SCORE, pure code, PRD §5.2): "四个子分（0–100）：技术栈匹配、经验深度、领域匹配、证据强度——各自列出支撑 bindings 与 gaps，分数可下钻到证据" and "综合分 + 档位：≥75 Strong / 55–74 Competitive / 35–54 Stretch / <35 Long shot。档位给建议语 + top gaps（含 probe/play）" and "硬性条件（签证 / 地点 / 年限 / 语言）逐条 pass / fail / unknown，置顶展示".

**Alignment** (TAILOR, PRD §5.3): "JD 关键词 → 简历中 present / missing / 同义失配（如 'K8s' vs 'Kubernetes'）。missing 区分两类：库里有、简历没写 → 改写解决；库里也没有 → 显示为 gap".

**Edit** (TAILOR, PRD §5.3): "`{原文, 建议改写, 理由, 来源 projectId}`".

**Intel** (RESEARCH, PRD §5.1 row): "snapshot、recent ≤ 3（每条带 soWhat）、engineering 信号 ≤ 3、talkingPoints ≤ 3；查无实据返回空数组，禁止编造".

**Rehearse** (REHEARSE, PRD §5.1 row + §5.4): "questions[5] + askThem[3] + positioning；每个问题必须绑 projectId 且只因该项目的具体内容才可问… trap = 标准答案之后的第二问；askThem 必须是不做研究问不出的问题".

## Goal

`lib/schemas/pipeline.ts` exporting Zod v4 schemas for every type named above, with array-length/enum constraints encoded directly in the schema (not left to runtime checks elsewhere) wherever PRD gives a concrete number or enum.

## Non-goals

- No `Project`/`Library`/`Resume`/`Profile` — FND-02 (this ticket may reference `Project`'s `id` type conceptually for comments but must not import from `entities.ts`; requirement/binding/edit/question "project reference" fields are plain `z.string()`, validated against the library at runtime by FND-07, not by cross-schema Zod refinement — keeps FND-02 and FND-03 independent, as decided in `01-foundation/README.md`).
- No `Job`/`TailoredResume`/`Brief` (the persisted wrappers that embed these types) — FND-04.
- No actual LLM prompt text or API call code — that is each feature module's own ticket (FIT-01/02, TLR-01, PRP-01/02). This ticket is the output *contract* only.
- No SCORE computation logic (the deterministic function that produces `FitReport` from `Ledger`) — that's `04-fit`/FIT-02; this ticket only defines `FitReport`'s shape.

## File-scope (write-owns)

- `lib/schemas/pipeline.ts`
- `lib/schemas/pipeline.test.ts`
- Does not touch: `lib/schemas/entities.ts` (FND-02, no import from it — see Background), `lib/schemas/persisted.ts` (FND-04).
- Serial-safety: only FND-01 has touched the repo before this ticket; FND-02 may be in flight in parallel within the same lane (both blocked_by only FND-01) but writes a disjoint file (`entities.ts` vs `pipeline.ts`) — no contention. If FND-02 and FND-03 are executed by the same serial lane runner one after another (not literally parallel processes), this is moot; documented for completeness per the template's serial-safety requirement.

## Deliverables

1. `RequirementCategory = z.enum(['technical', 'experience', 'domain', 'logistics'])`.
2. `JdExtract = z.object({ requirements: z.array(z.object({ id: z.string(), text: z.string(), weight: z.union([z.literal(1), z.literal(2), z.literal(3)]), category: RequirementCategory })).max(11), atsKeywords: z.array(z.string()), subtext: z.array(z.string()).max(3) })`.
3. `BindingStrength = z.enum(['strong', 'partial'])`.
4. `Binding = z.object({ requirementId: z.string(), projectId: z.string(), strength: BindingStrength, evidence: z.string() })` — `evidence` is the "库条目中的具体技术细节" text the binding cites.
5. `Gap = z.object({ requirementId: z.string(), probe: z.string(), play: z.string() })`.
6. `Ledger = z.object({ bindings: z.array(Binding), gaps: z.array(Gap) })`.
7. `HardRequirementCheck = z.object({ label: z.string(), status: z.enum(['pass', 'fail', 'unknown']) })` (visa/location/years/language, per §5.2 "硬性条件（签证 / 地点 / 年限 / 语言）逐条 pass / fail / unknown").
8. `SubScore = z.object({ score: z.number().min(0).max(100), bindings: z.array(z.string()), gaps: z.array(z.string()) })` (arrays hold the referenced `requirementId`s / `Binding`/`Gap` indices that support that sub-score — code-level exact indexing convention left to FIT-02's implementation ticket, but the presence of both arrays is fixed here).
9. `FitTier = z.enum(['Strong', 'Competitive', 'Stretch', 'Long shot'])`.
10. `FitReport = z.object({ hardRequirements: z.array(HardRequirementCheck), subScores: z.object({ technical: SubScore, experienceDepth: SubScore, domain: SubScore, evidenceStrength: SubScore }), compositeScore: z.number().min(0).max(100), tier: FitTier, advice: z.string(), topGaps: z.array(Gap) })`.
11. `AlignmentEntry = z.object({ keyword: z.string(), status: z.enum(['present', 'missing_in_resume', 'missing_in_library', 'synonym_mismatch']), note: z.string().optional() })` — encodes PRD §5.3's "present / missing / 同义失配" plus the two-way missing split ("库里有、简历没写" vs "库里也没有") as two distinct enum values so downstream UI/validation can branch on them directly rather than re-deriving the split.
12. `Alignment = z.array(AlignmentEntry)`.
13. `Edit = z.object({ original: z.string(), suggested: z.string(), rationale: z.string(), projectId: z.string() })` (PRD §5.3 `{原文, 建议改写, 理由, 来源 projectId}`).
14. `IntelRecentItem = z.object({ headline: z.string(), soWhat: z.string() })`.
15. `Intel = z.object({ snapshot: z.string(), recent: z.array(IntelRecentItem).max(3), engineeringSignals: z.array(z.string()).max(3), talkingPoints: z.array(z.string()).max(3) })`.
16. `RehearseQuestion = z.object({ projectId: z.string(), question: z.string(), trap: z.string() })` (`trap` non-empty is enforced with `.min(1)`, matching PRD's "trap 非空" requirement referenced in §6 Q1).
17. `Rehearse = z.object({ questions: z.array(RehearseQuestion).length(5), askThem: z.array(z.string()).length(3), positioning: z.string() })` — `questions` fixed at exactly 5 and `askThem` at exactly 3, matching PRD's literal `questions[5]` / `askThem[3]` notation.
18. Corresponding `export type X = z.infer<typeof X>` for every schema above.

## Acceptance checklist (classified)

- [ ] `[machine]` `JdExtract` rejects a 12th requirement (array max 11) in a unit test.
- [ ] `[machine]` `JdExtract` rejects `weight: 4` and accepts `weight: 1|2|3` in a unit test.
- [ ] `[machine]` `Rehearse` rejects `questions` arrays of length 4 or 6 (must be exactly 5) and `askThem` arrays not of length 3, in unit tests.
- [ ] `[machine]` `RehearseQuestion.trap` rejects an empty string.
- [ ] `[machine]` `Intel.recent`/`.engineeringSignals`/`.talkingPoints` each accept an empty array (PRD: "查无实据返回空数组") and reject a 4th item.
- [ ] `[machine]` `FitReport.tier` only accepts the four literal PRD tier strings.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Vitest unit tests in `lib/schemas/pipeline.test.ts`, one `describe` block per schema, asserting both a valid hand-built object parses and each stated constraint (max length, exact length, enum membership) rejects an out-of-bounds example. No external fixtures needed (pure schema tests); do not reference `fixtures/**` (does not exist yet — `02-evaluation` is not built at this point in the DAG).

## Feedback obligation

1. If a stage's actual LLM output (discovered during FIT-01/FIT-02/TLR-01/PRP-01/PRP-02 implementation) needs a field this ticket didn't anticipate, those tickets extend `lib/schemas/pipeline.ts` directly (it's the foundation-owned file) and must update this ticket's Deliverables list (version +0.1, changelog line in `01-foundation/README.md`) recording exactly what was added and why, before changing calling code.
2. The `Binding`/`Gap` split (disjoint union via two arrays, not a tagged single array) is a load-bearing shape decision inferred from PRD's "恰好落入 bindings ∪ gaps 之一" phrasing. If FND-07's requirement-coverage validation (layer 2, PRD §5.5) turns out to need a different shape to detect "uncovered" requirements cleanly, that is a shape change to a shared contract — do not swap silently; update this ticket and `01-foundation/README.md`'s decisions table first, flag to Horace if it changes how any downstream ticket's acceptance criteria read.
