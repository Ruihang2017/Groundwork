---
id: EVL-01
title: Fixture corpus — 10 JDs and 3 resumes
module: 02-evaluation
lane: 02-evaluation
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: []
blocks: [EVL-02, LIB-01]
---

# EVL-01 — Fixture corpus — 10 JDs and 3 resumes

No ADR — the decision is already made in PRD §6 (fixtures spec); this is build ticket 1 of 2 against the `02-evaluation` module.
Parent sub-PRD: [02-evaluation README](../README.md). Master spec: [PRD](../../../PRD.md).
**Why `builder`:** authoring content files against a fully specified corpus composition (counts, categories, seniority spread) from PRD §6 — no design decision beyond writing realistic text.

## Background + basis

PRD §6, quoted verbatim: "**Fixtures**：10 份真实 JD（5 × AI/ML Engineer、3 × Senior SWE、2 × 对抗样本：极薄 JD、recruiter 灌水 JD）+ 3 份简历（1 份真实授权、2 份合成，覆盖不同 seniority）。"

PRD §4: "目标用户：正在批量投递的科技岗求职者（SWE / AI / Data，英文市场 JD）" — fixtures must be English-market JDs (PRD §5.8: "v1 官方支持英文 JD"), matching the target persona.

The "1 份真实授权" (one real, consented) resume cannot be produced by this ticket — per `02-evaluation/README.md`'s open question #1, that requires a real person's consent and content, which an agent cannot fabricate or obtain. This ticket ships 3 fully agent-authored synthetic resumes as an interim stand-in (see Non-goals), with the swap-in of a real one tracked as Horace's open item.

PRD §6's two "对抗样本" (adversarial samples) are explicitly named: "极薄 JD"（extremely thin JD — minimal content, few requirements extractable) and "recruiter 灌水 JD"（recruiter-padded JD — long, buzzword-heavy, requirements diluted by fluff). These exist to stress-test READ's `requirements.length <= 11` cap and CROSS's binding quality against noisy input — `04-fit`'s Q1/Q2 acceptance criteria (cited in FIT-01/FIT-02) run against this corpus including these two adversarial cases specifically, not just the 8 "clean" JDs.

## Goal

`fixtures/jds/*.md` (10 files) and `fixtures/resumes/*.md` (3 files), each a self-contained realistic English-market document, composed exactly per PRD §6's counts and categories, plus a `fixtures/manifest.json` indexing each file with its category/seniority tag so EVL-02's harness and downstream Q1–Q3 assertions can select subsets programmatically (e.g. "run Q1 against all 10 JDs" vs. "run the adversarial-only subset").

## Non-goals

- Does not include the PRD 附录A "seed library（9 个项目）" or a real consented resume — those are open questions owned by Horace (see `02-evaluation/README.md`'s open questions #1); this ticket's 3 resumes are ALL agent-authored synthetic content, containing no real person's data, explicitly filling in for the "1 份真实授权" slot as a documented interim stand-in — not a resolution of that open question.
- Does not include any resume/JD pairing logic or expected-output "golden" fixtures (e.g. a pre-computed expected `Ledger` for a given JD+resume pair) — EVL-02's Q1/Q2/Q3 assertions evaluate actual pipeline output against rules (schema shape, groundedness) not against golden fixtures, per PRD §6's assertion column, which never mentions golden-output comparison.
- Does not implement the harness that consumes these files — EVL-02.

## File-scope (write-owns)

- `fixtures/jds/*.md` (10 files), `fixtures/resumes/*.md` (3 files), `fixtures/manifest.json`
- Does not touch: `eval/**`, `scripts/eval.mjs` (EVL-02), any `lib/**` or `app/**` path.
- Serial-safety: greenfield for this path — no prior ticket has touched `fixtures/**`; this ticket has no `blocked_by` and needs no other module's code to exist first (pure content authoring).

## Deliverables

1. `fixtures/jds/ai-ml-engineer-01.md` through `-05.md` — 5 realistic AI/ML Engineer JDs, English, varied companies/seniority (junior through staff), each containing enough requirement-bearing text (skills, years of experience, domain, logistics like visa/location) for READ to extract a non-trivial `requirements` list.
2. `fixtures/jds/senior-swe-01.md` through `-03.md` — 3 realistic Senior SWE JDs, English, varied domains (backend/infra/full-stack).
3. `fixtures/jds/adversarial-thin.md` — an extremely thin JD (a few sentences, sparse requirements) — stresses READ's ability to still produce a valid (if short) `JdExtract` without inventing requirements not present in the text.
4. `fixtures/jds/adversarial-recruiter-fluff.md` — a long, buzzword-heavy, requirement-diluted JD (mimicking real recruiter postings padded with generic corporate language) — stresses READ's `requirements.length <= 11` cap and CROSS's ability to bind against genuinely substantive requirements rather than fluff.
5. `fixtures/resumes/synthetic-junior.md`, `fixtures/resumes/synthetic-mid.md`, `fixtures/resumes/synthetic-senior.md` — 3 agent-authored synthetic resumes (no real person's data) covering distinct seniority levels, each with realistic project descriptions including a mix of projects WITH real-looking metrics and at least one project with an intentionally empty/no-metrics section (to give `03-library`/LIB-03's empty-metrics UI something real to render against in fixture-driven testing) — per PRD §5.6: "metrics: z.array(z.string())…空数组是合法且被显式展示的状态".
6. `fixtures/manifest.json` — `{ jds: [{ file, category: 'ai-ml'|'senior-swe'|'adversarial', label }], resumes: [{ file, seniority: 'junior'|'mid'|'senior' }] }` indexing every file above by category/label for programmatic selection.

## Acceptance checklist (classified)

- [ ] `[machine]` `fixtures/manifest.json` lists exactly 10 JD entries (5 `ai-ml`, 3 `senior-swe`, 2 `adversarial`) and exactly 3 resume entries — a unit test in `02-evaluation` (or a small script) asserts the manifest's counts match PRD §6's composition exactly.
- [ ] `[machine]` Every file referenced in the manifest exists on disk (unit test resolving each `file` path).
- [ ] `[machine]` `fixtures/jds/adversarial-thin.md` has a substantially shorter word count than the average of the 8 non-adversarial JDs (a mechanical proxy for "极薄", asserted in a test — e.g. under 150 words vs. the others' 400+).
- [ ] `[machine]` At least one resume fixture contains a project entry with an empty metrics list representation (asserted by a lightweight text-pattern check, since these are markdown files, not yet parsed — full Zod-schema-level validation of "empty metrics" happens downstream once `03-library`/LIB-01 actually parses these files, not here).
- [ ] `[machine]` `pnpm test` green (this ticket's manifest/count checks run under the existing `01-foundation`/FND-01 `pnpm test` command, not `pnpm eval`, since they are deterministic content-shape checks, not judge-based quality checks).
- No `[fixture]`/`[human]` criteria for this ticket — it produces the fixtures other tickets' `[fixture]` criteria consume; validating the fixtures' own existence/shape is a `[machine]` concern.

## Test plan

A small Vitest test (`fixtures/manifest.test.ts`) reads `fixtures/manifest.json`, resolves every listed file, and asserts the category counts and file-existence checks from the acceptance checklist. No external services or judge calls — pure filesystem + JSON assertions, fully reproducible offline.

## Feedback obligation

1. General rule: once Horace supplies open question #1's real consented resume (or explicitly declines and confirms the synthetic stand-in is permanent for v1), this ticket's Deliverable 5 and `fixtures/manifest.json` must be updated to reflect it, with a changelog line in `02-evaluation/README.md` recording the swap — this is not a silent content edit, since downstream Q2 groundedness fixtures may have been tuned against the synthetic text's specific wording.
2. If, once `04-fit`/FIT-01 and FIT-02 are actually built and run against `adversarial-recruiter-fluff.md`, the fixture turns out not to actually stress the `requirements.length <= 11` cap (e.g. READ under-extracts even without the cap being hit), the fixture itself needs to be made noisier/longer — update this ticket's Deliverable 4 and note the revision in `02-evaluation/README.md`'s changelog, don't just adjust the assertion threshold in EVL-02 to paper over a fixture that isn't doing its job.
3. If PRD 附录A's actual seed-library/prompt assets are handed off by Horace after this ticket has shipped, treat that as new information requiring a version +0.1 update to this ticket (not a separate ad hoc ticket), since the fixture corpus is this module's single source of truth for downstream quality gates.
