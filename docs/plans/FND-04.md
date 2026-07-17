# Implementation plan — FND-04: Persisted entity Zod schemas

Ticket: [docs/prd/01-foundation/tickets/FND-04-persisted-entity-schemas.md](../prd/01-foundation/tickets/FND-04-persisted-entity-schemas.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §5.6 (data model sketch — Job/TailoredResume/Brief/UsageEvent code block, Postgres table list), §6 (quality gates — `eval_runs` reporting), §5.5 (server-side trust boundary), §5.1 (per-stage failure policy referenced for `Brief.rehearse`)
Breakdown plan file-ownership table: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) §3 (`lib/schemas/**` → `01-foundation`), §6 open question #8 (Fit/Prep atomicity — ADR-candidate provenance)
Depends on (merged): [docs/plans/FND-03.md](FND-03.md) (pipeline stage payload schemas — hard dependency, `blocked_by: [FND-03]`); sibling (not a hard dependency): [docs/plans/FND-02.md](FND-02.md) (core simple-entity schemas — explicitly NOT imported by this ticket)

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-18) by direct inspection, not assumption:

- `git log --oneline`: `38cf3f4` (merge ticket/FND-03 into main), `94cc86c` (FND-03), `fca5058` (merge ticket/FND-02 into main), `6a1e590` (FND-02), `9c8f7e1` (merge FND-01), `fc6d27a`/`5287044` (FND-01), `ecb55a8` (bootstrap). `git branch -a` shows `main`, `ticket/FND-01`, `ticket/FND-02`, `ticket/FND-03`, `remotes/origin/main` — **no `ticket/FND-04` branch exists yet**. Working tree clean, `main` up to date with `origin/main`. **`38cf3f4` is the base commit** the Builder's diff should be measured against (see §3 item 4).
- `lib/schemas/pipeline.ts` (FND-03, merged) exists and exports exactly the named schemas + inferred types this ticket needs to import: `JdExtract`, `Ledger` (composed of `Binding`/`Gap`/`BindingStrength`), `FitReport` (composed of `HardRequirementCheck`/`SubScore`/`FitTier`), `Alignment` (a bare `z.array(AlignmentEntry)`, confirmed NOT object-wrapped), `Edit`, `Intel` (composed of `IntelRecentItem`), `Rehearse` (composed of `RehearseQuestion`). Confirmed by direct read of the file — no drift from what this ticket's Deliverables assume. `pipeline.ts`'s own file header states it does **not** import from `lib/schemas/entities.ts` and is a leaf module (`import { z } from 'zod'` only) — this ticket's own file will be the first cross-file import within `lib/schemas/**`.
- `lib/schemas/entities.ts` (FND-02, merged) exists (`Profile`, `Project`, `Library`, `Resume`, `PROJECT_ID_PATTERN`) but **this ticket does not import from it** — confirmed against the ticket's own Non-goals ("Job/TailoredResume/Brief reference library data only via `userId`, never embed `Library`/`Project` directly... no import from `entities.ts` needed"). No `Library`/`Project`/`Profile`/`Resume` reference anywhere in this ticket's Deliverables.
- No `lib/schemas/persisted.ts` or `lib/schemas/persisted.test.ts` exists yet — this ticket creates both, net new.
- `vitest.config.ts` already has `test.include: ['tests/**/*.test.ts', 'lib/**/*.test.ts']` (widened by FND-02's writeback, confirmed present, unchanged since). `lib/schemas/persisted.test.ts` is already reachable by this glob — **no `vitest.config.ts` change needed.**
- `tsconfig.json`'s `include` (`["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "tests/**/*.ts"]`) already covers a future `lib/schemas/persisted.ts`/`persisted.test.ts` for both `tsc`/`next build` type-checking and the `@/*` path alias. **No tsconfig change needed.**
- `eslint.config.mjs` applies `next/core-web-vitals` + `next/typescript` globally except `.next/**`, `node_modules/**`, `out/**`, `build/**`, `next-env.d.ts` — `lib/**` is linted by default already. **No eslint config change needed.**
- `package.json`: `zod@^4.4.3` is already an installed runtime dependency (added by FND-02, confirmed present in `dependencies`, resolved version `4.4.3` in `node_modules/zod/package.json`). **No new dependency, no `package.json`/`pnpm-lock.yaml` change needed** — this ticket adds zero new npm dependencies.
- Zod v4 API check on the installed `zod@4.4.3`: `z.record(keyType, valueType)` is a **two-argument** function in v4 (`node_modules/zod/v4/classic/schemas.d.ts` line 534: `record<Key extends core.$ZodRecordKey, Value extends core.SomeType>(keyType: Key, valueType: Value, ...)`), matching the ticket's Deliverable 8 literal snippet `z.record(z.string(), z.unknown())` exactly — no v3-style single-argument form, no API mismatch to work around.
- `.nullable()` is a standard Zod v4 method available on any schema instance (used on `Intel` for `Brief.intel: Intel.nullable()`) — no special import or v4-specific caveat found beyond ordinary `.optional()`/`.nullable()` semantics (nullable allows `null`, distinct from optional which allows `undefined`; `Brief.intel: Intel.nullable()` requires the key to be present with value `Intel`-shaped-or-`null`, not omittable).
- Import style precedent: the only existing cross-`lib/schemas/**`-file relationship is test-file-to-source-file, both of which use the `@/lib/schemas/...` alias (`lib/schemas/pipeline.test.ts` imports `from '@/lib/schemas/pipeline'`; `lib/schemas/entities.test.ts` imports `from '@/lib/schemas/entities'`). No existing **source**-to-source import within `lib/schemas/**` exists yet (`entities.ts` and `pipeline.ts` are both leaf files, by design — sub-PRD decision: "两个独立文件/票据，互不 import"). This ticket's `persisted.ts` is the first source file to import another source file in this directory. This plan specifies a **relative** import (`from './pipeline'`) for `persisted.ts` itself, reserving the `@/lib/schemas/...` alias for the test file only — this matches ordinary same-directory sibling-import idiom and avoids inventing a new pattern with no precedent either way; flagged as a low-stakes implementation call in §5 Open Questions in case the Reviewer prefers alias-only consistency instead.
- Serial-safety: per `docs/prd/breakdown-plan.md`'s lane-serial-execution note, tickets within `01-foundation` execute strictly serially by `blocked_by`/numeric order. FND-01/02/03 are merged; FND-03 (`blocked_by: [FND-04]`'s own hard dependency) is confirmed merged at `38cf3f4`. No other `01-foundation` ticket is in flight — this ticket has exclusive, uncontended access to every file in its File-scope (`lib/schemas/persisted.ts`, `lib/schemas/persisted.test.ts`, both net-new).

## 1. Scope

**In scope:**
- New file `lib/schemas/persisted.ts` exporting Zod v4 schemas (and inferred TS types via `export type X = z.infer<typeof X>`) for every type named in the ticket's Deliverables 1–9: `JobStatus`, `Job`, `TailoredResume`, `Brief`, `UsageOp`, `UsageEvent`, `EvalSuite`, `EvalRun`.
- New file `lib/schemas/persisted.test.ts` — Vitest unit tests, one `describe` block per schema, covering every acceptance-checklist item plus a valid-object happy path per schema (per the ticket's own Test plan, reusing the fixture-construction pattern established in `lib/schemas/pipeline.test.ts`).
- A single relative import in `persisted.ts` (`import { ... } from './pipeline';`) pulling in `JdExtract`, `Ledger`, `FitReport`, `Alignment`, `Edit`, `Intel`, `Rehearse` from the already-merged FND-03 file. No modification to `pipeline.ts` itself (read/import only, per File-scope).
- `createdAt`/`updatedAt` fields on `Job`/`TailoredResume`/`Brief` and `createdAt` on `UsageEvent`/`EvalRun`, each as `z.number()` (epoch-ms, matching the existing `Resume.updatedAt: z.number()` precedent in `entities.ts` — no `Date`/`z.date()` anywhere), added beyond PRD §5.6's literal code sketch per the ticket's own explicit instruction (Deliverables 2 and 6), each documented inline in the schema file as an FND-04 extension with its PRD-prose justification (写操作留 `updatedAt`; daily-window quota queries need `UsageEvent.createdAt`).

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):
- No Drizzle table definitions or any file under `db/**` — FND-05, blocked on this ticket, comes next. Do not create `db/schema.ts` or any stub for it.
- No `Project`/`Library`/`Resume`/`Profile` import or redefinition — already done in FND-02 (merged); `persisted.ts` must not import from `lib/schemas/entities.ts` under any circumstance. Any "library reference" on `Job`/`TailoredResume`/`Brief` is the plain `userId: z.string()` (on `Job`) or an implicit join through `jobId`/`Job.userId` (on `TailoredResume`/`Brief`, which carry `jobId` only, no direct `userId` field, matching the ticket's Deliverable 3/4 literal shape) — never an embedded `Library`/`Project` object.
- No invite-code table, no admin/usage-aggregation query schema — `07-platform-launch` (PLT-04, PLT-03) define anything they need locally, not here.
- No actual API route, no DB read/write code, no usage-recording call site — those are FND-05/06/07/10 and every downstream feature module's own tickets. This ticket is the output/persistence *contract* only, same category of scope as FND-03's stage-payload contract.
- No change to `lib/schemas/pipeline.ts` or `lib/schemas/entities.ts` — read-only awareness of `pipeline.ts`'s exports (via import), zero edits to either file.
- No change to `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `tsconfig.json`, or `eslint.config.mjs` — confirmed in §0 that none of the ticket's acceptance criteria require touching any of them this time (same "no shared-file writeback needed" situation as FND-03, unlike FND-02).

## 2. Change list

### 2.1 `lib/schemas/persisted.ts` (new file)

Named exports (not default). Write in the dependency order below so later schemas can reference earlier ones in the same file (top-to-bottom, no forward references needed):

File-level imports:
```ts
import { z } from 'zod';

import { Alignment, Edit, FitReport, Intel, JdExtract, Ledger, Rehearse } from './pipeline';
```

1. **`JobStatus`**
   ```ts
   export const JobStatus = z.enum(['screening', 'applied', 'interviewing', 'closed']);
   export type JobStatus = z.infer<typeof JobStatus>;
   ```
   Source: PRD §5.6's literal `Job.status` field — `z.enum(['screening', 'applied', 'interviewing', 'closed'])`. Ticket Deliverable 1, transcribed verbatim.

2. **`Job`**
   ```ts
   export const Job = z.object({
     id: z.string(),
     userId: z.string(),
     company: z.string(),
     role: z.string(),
     status: JobStatus,
     jdRaw: z.string(),
     jd: JdExtract,
     ledger: Ledger,
     fit: FitReport,
     createdAt: z.number(),
     updatedAt: z.number(),
   });
   export type Job = z.infer<typeof Job>;
   ```
   Source: PRD §5.6's literal `Job` sketch (ticket Deliverable 2), transcribed field-for-field. **`jd`, `ledger`, `fit` are required (no `.optional()`/`.nullable()` anywhere on these three)** — this is the ticket's single load-bearing constraint (Background: a `Job` row is only ever created once READ has produced a `JdExtract`, and `ledger`/`fit` are set together atomically because CROSS+SCORE execute in one API call, per `04-fit/README.md`'s decision, carried from `breakdown-plan.md` §6 open question #8). `createdAt`/`updatedAt: z.number()` are an FND-04 extension beyond §5.6's literal code block — add an inline comment citing PRD §5.6 prose ("写操作留 `updatedAt`") as the justification, and note both fields as an explicit addition (do not silently blend them into the "literal transcription" comment block — distinguish transcribed-from-code-sketch fields from prose-justified additions, matching FND-02's `entities.ts` commenting convention for its own `Resume.updatedAt`/similar additions).

3. **`TailoredResume`**
   ```ts
   export const TailoredResume = z.object({
     jobId: z.string(),
     alignment: Alignment,
     edits: z.array(Edit),
     fullDraftMd: z.string(),
     createdAt: z.number(),
     updatedAt: z.number(),
   });
   export type TailoredResume = z.infer<typeof TailoredResume>;
   ```
   Source: PRD §5.6 literal sketch (ticket Deliverable 3) + `createdAt`/`updatedAt` extension (same "写操作留 `updatedAt`" justification as `Job`). `alignment: Alignment` reuses the bare-array `Alignment` schema from `pipeline.ts` as-is — do not re-wrap it in an object here.

4. **`Brief`**
   ```ts
   export const Brief = z.object({
     jobId: z.string(),
     intel: Intel.nullable(),
     rehearse: Rehearse,
     createdAt: z.number(),
     updatedAt: z.number(),
   });
   export type Brief = z.infer<typeof Brief>;
   ```
   Source: PRD §5.6 literal sketch (ticket Deliverable 4) + same `createdAt`/`updatedAt` extension. **`intel: Intel.nullable()`** (RESEARCH may fail per P3 "degrade, don't block" — a `Brief` can persist with `intel: null`) versus **`rehearse: Rehearse`, required, no `.nullable()`/`.optional()`** (REHEARSE failure is NOT degraded — PRD §5.1's REHEARSE row failure policy errors out rather than persisting a partial `Brief`). This asymmetry is the second load-bearing constraint in this ticket — do not make `rehearse` nullable "for symmetry" with `intel`; that would silently misrepresent REHEARSE's actual failure-handling policy.

5. **`UsageOp`**
   ```ts
   export const UsageOp = z.enum(['parse', 'read', 'cross', 'tailor', 'research', 'rehearse']);
   export type UsageOp = z.infer<typeof UsageOp>;
   ```
   Source: PRD §5.1's six pipeline stages (ticket Deliverable 5). **`'score'` is deliberately excluded** — SCORE is pure code with no model call, never producing its own `UsageEvent`; it is folded into the single `cross` op's usage event (FND-10's "usage recorded once per user-facing operation" design, carried from `04-fit`'s decision). This is directly exercised by acceptance-checklist item 4 (`UsageEvent.op` rejects `'score'`) — do not add `'score'` to this enum even though it is a real pipeline stage name elsewhere in the codebase (`pipeline.ts`'s comments reference SCORE as a stage, but it has no corresponding `UsageOp` member).

6. **`UsageEvent`**
   ```ts
   export const UsageEvent = z.object({
     userId: z.string(),
     op: UsageOp,
     tokensIn: z.number(),
     tokensOut: z.number(),
     searches: z.number(),
     costUsd: z.number(),
     durationMs: z.number(),
     createdAt: z.number(),
   });
   export type UsageEvent = z.infer<typeof UsageEvent>;
   ```
   Source: PRD §5.6 literal sketch (ticket Deliverable 6) + `createdAt: z.number()` extension, justified by FND-06's daily-window quota/breaker queries needing a timestamp to window against (not in the literal §5.6 sketch — document inline as an FND-04 extension, same treatment as `Job`/`TailoredResume`/`Brief`'s `updatedAt` additions but note `UsageEvent` gets only `createdAt`, no `updatedAt` — usage events are append-only/immutable records, never updated in place, so there is no `updatedAt` to add).

7. **`EvalSuite`**
   ```ts
   export const EvalSuite = z.enum(['q1', 'q2', 'q3']);
   export type EvalSuite = z.infer<typeof EvalSuite>;
   ```
   Source: PRD §6's Q1/Q2/Q3 quality-gate suites (ticket Deliverable 7).

8. **`EvalRun`**
   ```ts
   export const EvalRun = z.object({
     id: z.string(),
     suite: EvalSuite,
     op: UsageOp,
     passRate: z.number().min(0).max(1),
     details: z.record(z.string(), z.unknown()),
     createdAt: z.number(),
   });
   export type EvalRun = z.infer<typeof EvalRun>;
   ```
   Source: ticket Deliverable 8, explicitly flagged (both in the ticket and in `01-foundation/README.md`'s decisions table) as an **FND-04 design inference** — PRD names the `eval_runs` table (§5.6) and states "每次 prompt / 模型改动必跑，报告落 `eval_runs`" (§6) but gives no field-level schema. `z.record(z.string(), z.unknown())` is Zod v4's two-argument record form (confirmed in §0) — do not use a single-argument `z.record(z.unknown())`, which is v3 syntax and will not type-check against the installed v4 API. `passRate.min(0).max(1)` is a fraction (0–1), not a percentage (0–100) — verify this against how `02-evaluation`/EVL-02 actually reports pass rate once that module exists; if EVL-02 finds this insufficient, per the ticket's Feedback obligation #1 it edits `persisted.ts` directly and writes back to this ticket + `01-foundation/README.md`, not silently in its own module.

9. **Inferred types**: every schema above already pairs `export const X = z.object(...)` with `export type X = z.infer<typeof X>` inline (ticket Deliverable 9) — no separate step; do this as each schema is written, not as a final pass.

Order note: `JobStatus` before `Job`; `UsageOp` before `UsageEvent` and before `EvalRun` (both reference it); `EvalSuite` before `EvalRun`. This matches the ticket's own Deliverables numbering and requires no forward references.

### 2.2 `lib/schemas/persisted.test.ts` (new file)

Vitest unit tests, pattern-matched to `lib/schemas/pipeline.test.ts`'s (FND-03, merged) `describe`/`it`/`expect` style and fixture-construction convention (per the ticket's own Test plan: "reusing the same construction pattern as `lib/schemas/pipeline.test.ts` from FND-03"). Import schemas under test from `@/lib/schemas/persisted`; import the minimal valid sub-object builders needed for fixtures from `@/lib/schemas/pipeline` (both aliased, matching the two existing test files' precedent — see §0's import-style note; only the test file uses the alias, the source file uses the relative import).

```ts
import { describe, expect, it } from 'vitest';

import {
  Brief,
  EvalRun,
  EvalSuite,
  Job,
  JobStatus,
  TailoredResume,
  UsageEvent,
  UsageOp,
} from '@/lib/schemas/persisted';
```

Build one minimal-but-valid nested fixture per pipeline sub-type needed (`JdExtract`, `Ledger`, `FitReport`, `Alignment`, `Edit`, `Intel`, `Rehearse`) inline in this file — do **not** import fixture builders from `pipeline.test.ts` (test files are not meant to import from each other; each ticket's test file is self-contained, matching both existing test files' own "Hand-built valid fixtures... pure inline schema-parsing assertions" framing). Reuse the same minimal-object shapes `pipeline.test.ts` already validated (e.g. an 11-or-fewer-item `requirements` array for `JdExtract`, a 5-question/3-askThem `Rehearse`, a 4-key `subScores` object for `FitReport`) so the nested fixtures are known-valid against FND-03's already-merged schemas, not re-derived from scratch.

Required coverage, mapped 1:1 to the ticket's acceptance checklist:

1. **`Job`** (acceptance item 1 — the load-bearing atomicity guarantee):
   - A fully valid `Job` object (all fields present, `jd`/`ledger`/`fit` each a minimal valid nested fixture) parses without throwing — happy path.
   - `Job.safeParse({ ...valid, jd: undefined })` (or the object spread with `jd` key omitted) → `.success === false`.
   - `Job.safeParse({ ...valid, ledger: undefined })` (omitted) → `.success === false`.
   - `Job.safeParse({ ...valid, fit: undefined })` (omitted) → `.success === false`.
   - Each of the three above as a **separate, explicit `it(...)` block** — do not collapse into one assertion — the acceptance item's own wording ("rejects an object missing `jd`, `ledger`, or `fit`") calls for proving each independently, not just proving "the object is invalid" once. Prefer constructing the invalid object with the destructured-omit pattern (`const { jd, ...rest } = validJob; void jd;`) over setting the key to `undefined`, since a literal `undefined` value can behave differently from a truly absent key depending on how the object is spread — mirrors `pipeline.test.ts`'s `FitReport` "rejects a missing subScores key" test's destructuring pattern (see that file's `FitReport` describe block).
   - `JobStatus` accepts each of the four enum values (`screening`, `applied`, `interviewing`, `closed`) and rejects a fifth arbitrary string.

2. **`TailoredResume`**:
   - A valid object (`alignment` a bare array with at least one `AlignmentEntry`-shaped item, `edits` an array with at least one valid `Edit`) parses without throwing.
   - `alignment: []` and `edits: []` both parse (neither array has a `.min(1)` per the ticket's literal Deliverable 3 shape — do not add one).

3. **`Brief`** (acceptance items 2 and 3 — the `intel` nullable / `rehearse` required asymmetry):
   - `Brief.parse({ jobId: ..., intel: null, rehearse: <valid Rehearse>, createdAt: ..., updatedAt: ... })` succeeds (acceptance item 2, exact scenario from the ticket).
   - `Brief.safeParse({ jobId: ..., intel: <valid Intel>, createdAt: ..., updatedAt: ... })` with `rehearse` omitted → `.success === false` (acceptance item 3, exact scenario from the ticket).
   - A valid object with a non-null `intel` (a valid `Intel` fixture) and a valid `rehearse` also parses — third, non-degraded happy path (not itself a separately numbered acceptance item, but needed so the suite proves the non-null-intel path is also accepted, not just tolerated).

4. **`UsageOp`/`UsageEvent`** (acceptance item 4):
   - `UsageOp` accepts each of the six enum values (`parse`, `read`, `cross`, `tailor`, `research`, `rehearse`).
   - `UsageOp.safeParse('score').success === false` — direct enum-level assertion.
   - `UsageEvent.safeParse({ ...valid, op: 'score' }).success === false` — the literal acceptance-item wording ("`UsageEvent.op` rejects `'score'`"), asserted at the `UsageEvent` object level, not just the bare `UsageOp` enum level; include both (bare-enum test above + this one) since they check different things (enum membership vs. the field actually wired to reject it inside the parent object).
   - A valid `UsageEvent` object (all seven fields present, `op` one of the six valid values) parses without throwing — happy path.

5. **`EvalSuite`/`EvalRun`**:
   - `EvalSuite` accepts `q1`/`q2`/`q3` and rejects a fourth string (e.g. `q4`).
   - A valid `EvalRun` object (`passRate` in `[0, 1]`, `details` a small `Record<string, unknown>` such as `{ failures: ['case-3'] }`) parses without throwing.
   - `EvalRun.safeParse({ ...valid, passRate: -0.1 }).success === false` and `EvalRun.safeParse({ ...valid, passRate: 1.1 }).success === false` (bounds check, mirrors `pipeline.test.ts`'s `SubScore`/`FitReport` score-bounds test pattern).
   - `EvalRun.safeParse({ ...valid, op: 'score' }).success === false` — `EvalRun.op` reuses `UsageOp`, so the same `'score'`-exclusion applies here too; not a separately numbered ticket acceptance item, but directly follows from Deliverable 8 reusing `UsageOp`, worth asserting explicitly so a future accidental widening of `UsageOp` is caught from both call sites.

No test should reference `fixtures/**` (does not exist yet — `02-evaluation` builds it later; the ticket's Test plan explicitly forbids this, matching FND-02/FND-03's precedent).

### 2.3 No writeback to `01-foundation/README.md` or shared config files expected

Same situation as FND-03's plan §2.3: this ticket's §0 check confirms `vitest.config.ts`, `tsconfig.json`, `eslint.config.mjs`, and `package.json` all already support this ticket's needs with zero changes, and no new npm dependency is added. **Do not preemptively add a changelog entry or bump the ticket's version.** Only do so if implementation actually falsifies something in this plan or the ticket — in particular, watch for exactly the two scenarios the ticket's own Feedback obligation already names: (1) `EvalRun`'s shape proving insufficient once `02-evaluation`/EVL-02 builds the real harness (that ticket's job to fix and write back, not this one, unless this Builder itself discovers a concrete reason `EvalRun` as specified cannot even be written correctly right now — e.g. a genuine zod v4 API mismatch beyond what §0 already checked); (2) `Job.jd`/`ledger`/`fit`'s non-nullability being found unworkable — that is explicitly **not** a local fix, see §6 ADR-candidate flag below.

## 3. Test plan

Maps directly to the ticket's acceptance checklist; each item is what the Builder/Reviewer actually runs.

1. **`pnpm test` exits 0** and output includes `lib/schemas/persisted.test.ts`'s suite alongside the existing `tests/smoke.test.ts`, `lib/schemas/entities.test.ts`, and `lib/schemas/pipeline.test.ts` suites (four files total contributing passing tests) — confirms `vitest.config.ts`'s already-widened `include` picks up the new file with no further config change (§0/§2.3).
2. **Targeted assertions**, all covered by §2.2's test file — re-verify each is actually present and actually exercised:
   - `Job.parse(...)` rejects an object missing `jd`, `ledger`, or `fit` — three separate, independently-asserted cases (acceptance item 1).
   - `Brief.parse({..., intel: null, rehearse: {...valid...}})` succeeds (acceptance item 2).
   - `Brief.parse({..., intel: {...valid...}})` with `rehearse` omitted fails (acceptance item 3).
   - `UsageEvent.op` rejects `'score'` (acceptance item 4).
3. **Recommended, not ticket-mandated:** run `pnpm build` (or `pnpm exec tsc --noEmit`) once after adding `persisted.ts`. Vitest's esbuild-based transpile does not perform full TypeScript type-checking, so a type error (e.g. a malformed `z.infer` reference, an incorrect relative-import path to `./pipeline`, or an accidental mismatch between `Alignment`'s bare-array shape and how it's used here) could pass `pnpm test` while still breaking `next build`'s project-wide `tsc` pass. Not a formal acceptance item, but cheap insurance — flag any failure here to the Reviewer, mirroring FND-02/FND-03's plan §3 precedent.
4. **No file outside File-scope was touched**: `git diff --stat 38cf3f4..HEAD` (base = the FND-03 merge commit, confirmed current `main` HEAD in §0) should list exactly `lib/schemas/persisted.ts` and `lib/schemas/persisted.test.ts`. Anything else in the diff (in particular `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `tsconfig.json`, `lib/schemas/entities.ts`, `lib/schemas/pipeline.ts`) is a File-scope violation and must be reverted before merge.
5. All of the above are reproducible fully offline (no DB, no Anthropic API, no network) — pure schema-parsing unit tests, consistent with the ticket's own Test plan framing. This ticket introduces zero I/O, zero async code, and zero new runtime dependencies.

## 4. Risks & edge cases

- **Concurrency: none applies.** `lib/schemas/persisted.ts` is a pure, side-effect-free module — schema object literals evaluated once at import time, no I/O, no shared mutable state, no async code, no request-handling. There is nothing here that can race. (Same category of finding as FND-02/FND-03's plans — carried forward because the file shape is identical in kind: a leaf-ish schema-definition module, this time with one internal import.)
- **Security-sensitive path: `Job`'s non-nullable `jd`/`ledger`/`fit` is this ticket's single most consequential correctness property, and it is a data-integrity/atomicity guarantee, not merely a validation nicety.** If this constraint is silently loosened (e.g. someone later adds `.optional()` to "make Job creation easier," as the ticket explicitly warns against), every downstream reader of a `Job` row (FIT-03's UI, TLR-01's tailoring input, PRP-04's prep-gating logic) could receive a `Job` with a missing `jd`/`ledger`/`fit` and either crash on `undefined` access or silently branch into incorrect behavior — this is exactly the kind of boundary-weakening PRD §5.5's "所有 stage 输出先过 Zod v4 schema" trust-boundary design exists to prevent. The Reviewer should specifically check:
  - `jd`, `ledger`, `fit` have no `.optional()`/`.nullable()`/`.default()` anywhere on the `Job` schema — a model that only checks the happy-path fixture could miss a `.optional()` added "just in case."
  - The three independent missing-field tests in §2.2 item 1 are all actually present and actually failing-as-expected (not accidentally testing the same field three times via a copy-paste error — a known easy mistake when writing near-identical negative test cases).
- **Security-sensitive path (second, distinct guarantee): `Brief.intel`/`Brief.rehearse`'s nullable/required asymmetry encodes a real product policy (P3 "degrade, don't block" for RESEARCH vs. hard-fail for REHEARSE), not an arbitrary schema choice.** Getting this backwards (making `rehearse` nullable, or `intel` required) would silently misrepresent PRD §5.1's stated per-stage failure policy to every consumer of `Brief` rows. Flag to the Reviewer as a two-line diff with outsized correctness impact — verify both directions are tested (§2.2 item 3), not just the one direction the ticket's acceptance checklist happens to spell out in full (acceptance items 2 and 3 together cover both directions; do not treat item 2 alone as sufficient).
- **`UsageOp`'s exclusion of `'score'` is a quota/billing-adjacent correctness property, not just an enum-completeness nicety.** SCORE is pure code with no model call, so if `'score'` were accidentally admitted as a valid `UsageOp`, it would open a path for a future caller to double-record usage for a single CROSS+SCORE API call (once as `'cross'`, once as `'score'`) — directly contradicting FND-10's "usage recorded once per user-facing operation" design this ticket's Background cites. This is a narrow, single-enum-member risk but has real cost/observability blast radius if it regresses later (e.g. someone extends `UsageOp` for a new stage and accidentally widens it further without re-reading this ticket's Background). The acceptance checklist's item 4 exists specifically to pin this — make sure the test asserts rejection, not just omission-from-a-happy-path-list.
- **`EvalRun`'s shape is an explicit design inference, not a PRD-given contract — treat any test coverage of it as "coverage of this ticket's own reasonable guess," not "coverage of a PRD requirement."** This is lower-stakes than the `Job`/`Brief`/`UsageOp` risks above (no other ticket in this module depends on `EvalRun`'s exact fields; only `02-evaluation`/EVL-02 downstream does, and that module's own Feedback-obligation path already exists for correcting it). Do not over-invest in defending this shape at review time beyond confirming it type-checks and the `z.record` two-argument v4 syntax is used correctly (§0/§2.1 item 8) — the real validation of "is this shape sufficient" happens later, by EVL-02, not by this ticket's Reviewer.
- **First-ever source-to-source import within `lib/schemas/**` (`persisted.ts` → `./pipeline`).** Low risk mechanically (Node/TS relative imports within the same directory are unremarkable), but worth the Reviewer double-checking that (a) the import path is `./pipeline` (relative), not an accidental `../pipeline` or a typo'd alias path that happens to still resolve via `tsconfig`'s broad `paths` mapping, and (b) nothing was accidentally re-exported redundantly (e.g. re-exporting `JdExtract` from `persisted.ts` — not requested by any Deliverable, would blur the "which file owns this type" boundary the sub-PRD's decisions table establishes).
- **No change to any already-merged file's runtime behavior.** This ticket only adds two new files; `pipeline.ts` and `entities.ts` are imported (in `pipeline.ts`'s case) but never modified. There is no risk of this ticket regressing FND-02/FND-03's own already-passing tests, and the diff-scope check in §3 item 4 exists specifically to catch any accidental edit to either file.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Whether `persisted.ts` should import from `./pipeline` (relative, this plan's choice) or `@/lib/schemas/pipeline` (alias, matching the two existing test files' style) — no existing source-file precedent settles this either way (§0). | Reviewer, at review time — low-stakes, one-line change if disagreed with; no cascading impact since nothing else in this ticket depends on the import-path style. |
| 2 | `EvalRun`'s field-level shape (§2.1 item 8) is this ticket's own design inference per the ticket's explicit framing and `01-foundation/README.md`'s decisions table row 3 — already flagged as provisional in both the ticket and this plan; not re-litigated here as a new open question, just carried forward. If `02-evaluation`/EVL-02 finds it insufficient, that ticket's Builder edits `persisted.ts` directly per the ticket's Feedback obligation #1 (version +0.1, changelog line in `01-foundation/README.md`). | `02-evaluation`/EVL-02's Builder, when that ticket is actually implemented — not blocking for this ticket. |
| 3 | Whether `EvalRun.passRate` should be a 0–1 fraction (this plan's reading, `.min(0).max(1)`, matching the ticket's literal Deliverable 8 code) or a 0–100 percentage — the ticket's own snippet uses `.min(0).max(1)`, so this plan follows it literally; flagged only because "pass rate" is colloquially often expressed as a percentage and a future consumer (EVL-02) could misread the convention if not documented clearly in the schema file's inline comment. | This plan resolves it as written in the ticket (0–1 fraction) — flag to Reviewer only if the ticket's own snippet is suspected to be a typo; otherwise not open. |

## 6. ADR-candidate flag

**Not proposing an ADR now — the ticket is explicit that none is needed** ("No ADR — the decision is already made in PRD §5.6... and §6"). This plan implements exactly what the ticket specifies and makes no new architectural choice of its own.

However, one thing in this ticket carries a **pre-flagged, hard-to-reverse architectural dependency that a future ticket-planning pass must watch for**, and this plan surfaces it explicitly so it is not lost between now and then: `Job.jd`/`ledger`/`fit`'s non-nullability encodes the assumption that READ, and then CROSS+SCORE together, are atomic with respect to `Job` row creation/update (Background, and the ticket's own Feedback obligation #2). This exact assumption is **already on record** as `docs/prd/breakdown-plan.md` §6 open question #8: "READ+CROSS+SCORE（Fit）与 RESEARCH+REHEARSE（Prep）内部是否应视为单一原子操作...架构选择，硬到不可逆...建议固化为未来 ADR-0001." This ticket does not resolve that open question — it simply builds the schema that encodes the "yes, atomic" answer as a type-level constraint. The correction path, if `04-fit`/FIT-01's actual implementation finds this unworkable, is already fully specified by the ticket itself (Feedback obligation #2: escalate to Horace, update this ticket + `04-fit/README.md`'s decisions table first — not a silent FIT-01-local fix) and by the breakdown plan (formalize as ADR-0001 if/when it actually gets overturned). **This plan's only action item here is informational**: whoever next plans a `04-fit` ticket (most directly FIT-01) should re-read this ticket's Background and this plan's §4 risk note before assuming `Job.jd`/`ledger`/`fit` can be relaxed — and if it must be relaxed, that is the trigger for writing ADR-0001, not a routine schema tweak.
