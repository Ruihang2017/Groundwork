---
id: FND-02
title: Core simple-entity Zod schemas
module: 01-foundation
lane: 01-foundation
size: S
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-01]
blocks: [FND-05, FND-07, LIB-01]
---

# FND-02 — Core simple-entity Zod schemas

No ADR — the decision is already made in PRD §5.6 (data model sketch); this is build ticket 2 of 10 against the `01-foundation` module.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-01 — Repo and toolchain bootstrap](FND-01-repo-toolchain-bootstrap.md)
**Why `builder`:** transcribing PRD §5.6's explicit code sketch into real Zod v4 schemas is mechanical translation with a fixed source of truth, not a design task.

## Background + basis

PRD §5.6 gives this literal sketch (quoted verbatim, the load-bearing source for this ticket):

```ts
const Project = z.object({
  id: z.string(),               // kebab-case，如 "voice-agent"
  name: z.string(), stage: z.string(), role: z.string(),
  stack: z.array(z.string()),
  summary: z.string(),          // 2–3 句技术实质：架构决策、tradeoff，不是职责描述
  metrics: z.array(z.string()), // 只允许真实数字；空数组是合法且被显式展示的状态
  tags: z.array(z.string()),
});
const Library = z.object({ profile: Profile, projects: z.array(Project) });
const Resume  = z.object({ sourceMd: z.string(), updatedAt: z.number() }); // 原件解析后即弃，不落盘
```

Note `Profile` is referenced by `Library` but not itself defined in §5.6's code block — PRD §5.1 PARSE row says the stage produces "`resumeMd` + 草稿 Library", and §5.6 says `Resume` only carries `sourceMd`/`updatedAt` (no structured fields) — meaning candidate identity/contact fields must live in `Profile`. This ticket must define `Profile` reasonably (name, headline/target role, contact fields) since no other PRD section defines it; PRD §5.2/§5.3/§5.4 never reference `Profile` fields directly (they use `Library.projects`), so keep `Profile` minimal and mark any invented field as a design choice in the file's code comments, not a load-bearing contract other modules must match exactly.

PRD §5.6 also states the P2 principle in force here: "metrics: z.array(z.string()), // 只允许真实数字；空数组是合法且被显式展示的状态" — this governs LIB-01/LIB-03's later UI behavior; this ticket's job is only to encode the type (`z.array(z.string())`, no `.min(1)`), not the UI.

## Goal

`lib/schemas/entities.ts` exporting Zod v4 schemas `Profile`, `Project`, `Library`, `Resume` (and their inferred TS types `type Profile = z.infer<typeof Profile>` etc.), matching PRD §5.6's sketch exactly for the fields it specifies, with `Profile` added as a minimal reasonable extension (documented as such).

## Non-goals

- No `JdExtract`/`Ledger`/`FitReport`/`Alignment`/`Edit`/`Intel`/`Rehearse` schemas — FND-03.
- No `Job`/`TailoredResume`/`Brief`/`UsageEvent`/`EvalRun` schemas — FND-04.
- No Drizzle table definitions — FND-05. This ticket is Zod-only (request/response and in-memory validation), not persistence.
- No validation logic (referential integrity etc.) — FND-07.
- No UI/empty-metrics banner — that's `03-library`/LIB-03; this ticket only makes `metrics: []` a valid, non-error state at the type level.

## File-scope (write-owns)

- `lib/schemas/entities.ts`
- `lib/schemas/entities.test.ts` (unit tests for this file)
- Does not touch: `lib/schemas/pipeline.ts` (FND-03), `lib/schemas/persisted.ts` (FND-04), any `db/**` file (FND-05).
- Serial-safety: only FND-01 has touched the repo before this ticket (toolchain files only, no `lib/` directory yet) — no in-flight contention.

## Deliverables

1. `lib/schemas/entities.ts` exporting (named exports, not default):
   - `Profile = z.object({ name: z.string(), headline: z.string().optional(), targetRole: z.string().optional(), contact: z.object({ email: z.string().email().optional(), links: z.array(z.string()).default([]) }).optional() })` — inline comment noting this is an FND-02 design addition, not literally specified in PRD §5.6, kept minimal because no downstream stage in §5.1–§5.4 reads individual `Profile` fields directly.
   - `Project = z.object({ id: z.string(), name: z.string(), stage: z.string(), role: z.string(), stack: z.array(z.string()), summary: z.string(), metrics: z.array(z.string()), tags: z.array(z.string()) })` exactly matching the §5.6 field list and comments above.
   - `Library = z.object({ profile: Profile, projects: z.array(Project) })`.
   - `Resume = z.object({ sourceMd: z.string(), updatedAt: z.number() })`.
   - Corresponding `export type X = z.infer<typeof X>` for each.
2. A `PROJECT_ID_PATTERN` exported regex or a `.refine()` on `Project.id` enforcing kebab-case (PRD §5.6 comment: `// kebab-case，如 "voice-agent"`) — reject uppercase/spaces/underscore.

## Acceptance checklist (classified)

- [ ] `[machine]` `Project`, `Library`, `Resume`, `Profile` schemas parse a hand-written fixture object matching PRD §5.6's field list without error (unit test).
- [ ] `[machine]` `Project.parse({...metrics: []})` succeeds — empty metrics array is explicitly a valid state (PRD §5.6 comment, unit test asserting no error thrown).
- [ ] `[machine]` `Project.id` rejects a non-kebab-case string (e.g. `"Voice_Agent"`) in a unit test.
- [ ] `[machine]` `pnpm test` green (includes this ticket's new tests plus FND-01's smoke test).

## Test plan

Vitest unit tests in `lib/schemas/entities.test.ts`, following the pattern established by `tests/smoke.test.ts` (FND-01) for file location/config reuse. No fixtures/mocks needed — pure schema-parsing assertions against hand-constructed objects inline in the test file (these are NOT the PRD §6 fixture corpus; that's `02-evaluation`'s `fixtures/**`, which does not exist yet at this point in the dependency graph and must not be referenced here).

## Feedback obligation

1. If `Profile`'s shape turns out to need fields that later modules (e.g. `03-library`'s confirm UI) require and this ticket didn't anticipate, `03-library`'s ticket must extend `lib/schemas/entities.ts` itself (it is a foundation-owned file) rather than defining a competing shape elsewhere — update this ticket file's Deliverables list retroactively (version +0.1, changelog line in `01-foundation/README.md`) to record the addition, then change the code.
2. If PRD §5.6's literal sketch is found to be inconsistent with how `Library`/`Project` are actually consumed downstream (e.g. a stage needs a field not in the sketch), that overturns a §5.6 decision — escalate for human re-review (Horace) rather than silently adding fields; document the gap in `01-foundation/README.md`'s open questions table first.
