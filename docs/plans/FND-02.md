# Implementation plan — FND-02: Core simple-entity Zod schemas

Ticket: [docs/prd/01-foundation/tickets/FND-02-core-entity-schemas.md](../prd/01-foundation/tickets/FND-02-core-entity-schemas.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §5.6 (data model sketch), §5.5 (server-side trust boundary)
Breakdown plan file-ownership table: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) §3
Depends on (merged): [docs/plans/FND-01.md](FND-01.md) — repo/toolchain scaffold

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-18) by direct inspection, not assumption:

- `git log --oneline`: `fc6d27a` (FND-01 writeback), `5287044` (FND-01), `ecb55a8` (bootstrap). Working tree clean, `main` up to date with `origin/main`. FND-01 is merged; this is the first ticket to build on top of it.
- No `lib/` directory exists yet anywhere in the repo. This ticket creates it.
- `package.json` (root) currently has `dependencies`: `next`, `react`, `react-dom`; `devDependencies`: `@eslint/eslintrc`, `@types/node`, `@types/react`, `eslint`, `eslint-config-next`, `typescript`, `vitest`. **`zod` is not present** — confirmed via `pnpm-lock.yaml` grep and `node_modules` listing (`zod` directory absent). `"test": "vitest run"` script exists (this is the ticket's referenced "project test-suite command").
- `vitest.config.ts` currently reads:
  ```ts
  import { fileURLToPath } from 'node:url';
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
    },
  });
  ```
  **`include` only matches `tests/**/*.test.ts`.** This is load-bearing for §2.2 below: as written, it will *not* pick up `lib/schemas/entities.test.ts`, so `pnpm test` would silently report the existing smoke test green while never running this ticket's new tests — a false-green risk against acceptance item 4. See §2.2.
- `tsconfig.json`'s `include` is `["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "tests/**/*.ts"]` — `**/*.ts` already covers a future `lib/schemas/entities.ts` and `lib/schemas/entities.test.ts` for both `tsc`/`next build` type-checking and the `@/*` → repo-root path alias. **No tsconfig change needed.**
- `eslint.config.mjs` applies `next/core-web-vitals` + `next/typescript` globally except `.next/**`, `node_modules/**`, `out/**`, `build/**`, `next-env.d.ts` — `lib/**` is linted by default already. **No eslint config change needed.**
- Registry check (`npm view zod version`, `registry.npmjs.org/zod` dist-tags): `zod` latest stable is **4.4.3** (dist-tag `latest`), i.e. already on the v4 line the ticket requires — no `zod/v4` subpath import needed (that was only relevant during the v3→v4 transition beta; `zod@4.4.3`'s main `zod` export *is* v4). Builder should re-verify at implementation time (`npm view zod version`) in case a newer 4.x patch has shipped, and record the exact resolved version, mirroring FND-01's practice for `next`/`react`.
- Zod v4 API check (`zod.dev` docs, changelog): `z.string().email()` is **deprecated** in v4 in favor of the top-level `z.email()` ("All 'string formats' ... have been promoted to top-level functions ... method equivalents ... are still available but have been deprecated. They'll be removed in the next major version."). This affects the `Profile.contact.email` field — see §2.3's deviation from the ticket's literal snippet.
- Local toolchain note (carried forward from FND-01 v0.2 writeback, `docs/prd/01-foundation/README.md` changelog): on this reference dev environment (Node 22.11.0 / Corepack 0.29.4), `corepack enable && pnpm install` fails with `Cannot find matching keyid`. Use `npm install -g pnpm@10.34.5` (matching the pinned `packageManager`) or set `COREPACK_INTEGRITY_KEYS=0` for local `pnpm install`/`pnpm add`. CI is unaffected (uses `pnpm/action-setup@v4`, no Corepack). The Builder needs a working local `pnpm` to run `pnpm add zod` and `pnpm test` — don't rediscover this friction from scratch.
- Serial-safety: per `docs/prd/breakdown-plan.md` §4's own note, tickets within one lane (`01-foundation`) execute strictly serially by `blocked_by`/numeric order. FND-01 is merged; no other `01-foundation` ticket (FND-03 onward) is in flight, so this ticket has exclusive access to every file it touches, including the two shared files it appends to (§2.1, §2.2).

## 1. Scope

**In scope:**
- New file `lib/schemas/entities.ts` exporting Zod v4 schemas `Profile`, `Project`, `Library`, `Resume` and their inferred TS types, per PRD §5.6's literal sketch (quoted in the ticket's Background) plus the ticket's own `Profile` design addition.
- New file `lib/schemas/entities.test.ts` — Vitest unit tests for the above.
- A kebab-case constraint on `Project.id` (`PROJECT_ID_PATTERN` regex, applied via `.regex()`).
- Minimal, additive edits to two shared `01-foundation`-owned files, both required for this ticket's own acceptance criteria to be true (not scope creep — justified in §2.1/§2.2):
  - `package.json` — append `zod` to `dependencies` (+ regenerate `pnpm-lock.yaml` via `pnpm install`).
  - `vitest.config.ts` — widen `test.include` so `pnpm test` actually runs `lib/schemas/entities.test.ts`.
- A version bump + changelog line on the ticket file itself and a mirroring line in `01-foundation/README.md`, per the ticket's own Feedback-obligation general rule and the precedent FND-01 already set (v0.2 changelog for its own writeback).

**Explicitly out of scope** (per ticket Non-goals — do not implement):
- `JdExtract`/`Ledger`/`FitReport`/`Alignment`/`Edit`/`Intel`/`Rehearse` schemas (`lib/schemas/pipeline.ts`) — FND-03.
- `Job`/`TailoredResume`/`Brief`/`UsageEvent`/`EvalRun` schemas (`lib/schemas/persisted.ts`) — FND-04.
- Any Drizzle table definitions or `db/**` file — FND-05.
- Any referential-integrity/requirement-coverage/number-integrity/blacklist validation logic — FND-07 (`lib/validation/**`).
- Any UI, including the empty-metrics banner — `03-library`/LIB-03. This ticket only makes `metrics: []` a valid, non-throwing state at the schema level.
- Do not touch `lib/schemas/pipeline.ts` or `lib/schemas/persisted.ts` (they don't exist yet — FND-03/FND-04 create them later; do not pre-create stubs).
- Do not touch any file under `db/`, `auth.ts`, `app/api/**`, `app/(app)/**` — outside this ticket's module entirely.

## 2. Change list

### 2.1 `package.json` (append only — owned by `01-foundation`, created by FND-01)

Add one line to `"dependencies"` (alongside `next`/`react`/`react-dom`, not `devDependencies` — these schemas are imported at runtime by API routes in later tickets):

```json
"zod": "^4.4.3"
```

Resolve the exact version at implementation time (`pnpm add zod`, or `npm view zod version` then hand-edit) rather than trusting this plan's dated number — mirrors FND-01's own §2.1 practice for `next`/`react`. Do not add `zod` to `devDependencies`, do not add any other new dependency, do not touch `scripts`. Regenerate `pnpm-lock.yaml` as a side effect of `pnpm install`/`pnpm add zod` — do not hand-edit the lockfile.

This is an allowed append per `docs/prd/breakdown-plan.md` §3 row 1: "`03`–`07` 的任何票据如需新依赖，只能追加 `dependencies`/`scripts` 字段，不得重写" (any ticket needing a new dependency may only append `dependencies`/`scripts`, never rewrite). FND-02 is even more clearly entitled to this than a cross-module ticket would be, since it's the same owning module (`01-foundation`) continuing to build the file FND-01 started, not a downstream module reaching in.

### 2.2 `vitest.config.ts` (append only — owned by `01-foundation`)

Change:
```ts
include: ['tests/**/*.test.ts'],
```
to:
```ts
include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'],
```
Leave every other line (the `resolve.alias` block, `environment: 'node'`) untouched.

**Why this belongs in FND-02, not a later ticket:** the ticket's own File-scope/Deliverables/Test-plan sections name the test file's path as `lib/schemas/entities.test.ts` three separate times (not `tests/schemas/entities.test.ts`), and acceptance item 4 requires `pnpm test` to be green *and* to actually include this ticket's new tests ("`pnpm test` green (includes this ticket's new tests plus FND-01's smoke test)"). Against the current `include`, `pnpm test` would exit 0 while silently running zero assertions from `entities.test.ts` — a false-green that would pass review by accident, not by proof. Widening the glob is the minimal fix that makes the stated acceptance criterion actually checkable.

**Why `lib/**/*.test.ts` and not something narrower/broader:** checked every other `01-foundation` ticket file (FND-03, FND-04, FND-06, FND-07, FND-10) — all of them colocate their own Vitest test files under `lib/**` the same way (`lib/schemas/pipeline.test.ts`, `lib/config/quota.test.ts`, `lib/validation/*.test.ts`, `lib/usage/record.test.ts`, etc.). `lib/**/*.test.ts` is the smallest glob that covers this ticket's need without inventing unrelated scope (e.g. it does not add `db/**/*.test.ts`, which FND-05 will need later and can append itself when it lands — not this ticket's job to pre-empt). Vitest's default `exclude` already keeps `node_modules/**` out regardless.

**Serial-safety:** confirmed in §0 — no other `01-foundation` ticket is in flight; this is a non-conflicting, purely additive one-line change to an already-merged file.

**Required writeback (do this, don't skip it):** per the ticket's own Feedback-obligation general rule ("if implementation falsifies this spec, update this ticket / sub-PRD first... version +0.1, changelog line"), and mirroring the precedent FND-01's own Builder already set for this exact ticket file convention:
1. Add `version: 0.2` to FND-02's ticket frontmatter (currently has no `version` field, i.e. implicit v0.1).
2. Add a `## Changelog` section to the ticket file with a `v0.2` entry stating: widened `vitest.config.ts`'s `include` to cover `lib/**/*.test.ts` because the ticket's own specified test file location wasn't reachable by the inherited config; note this also unblocks FND-03/04/06/07/10's colocated test files without them each needing to re-touch this shared file.
3. Add a one-line mirroring entry to `docs/prd/01-foundation/README.md`'s `## Changelog` section (it already has a `v0.2` line from FND-01's own writeback — add a `v0.3` line, don't overwrite v0.2).

This is process hygiene, not a behavior change — flagged explicitly so the Reviewer checks it deliberately (see Open Question 3).

### 2.3 `lib/schemas/entities.ts` (new file)

Named exports (not default), in this order (Profile and Project must precede Library, which references both):

```ts
import { z } from 'zod';

// Profile is not defined in PRD §5.6's code sketch (only referenced by Library).
// FND-02 design addition, not literally specified in PRD §5.6 — kept minimal
// because no downstream stage in PRD §5.1–§5.4 reads individual Profile fields
// directly (they consume Library.projects). Extend here, not with a competing
// shape elsewhere, if a later module (e.g. 03-library's confirm UI) needs more —
// see this ticket's Feedback obligation #1.
export const Profile = z.object({
  name: z.string(),
  headline: z.string().optional(),
  targetRole: z.string().optional(),
  contact: z
    .object({
      // Zod v4: z.email() is the non-deprecated top-level form; z.string().email()
      // (the ticket's literal snippet) still works but is deprecated as of v4 and
      // slated for removal in the next major version — same validation behavior,
      // preferring the form that isn't already on a deprecation path. See this
      // plan's Open Question 2 if this reading is contested at review time.
      email: z.email().optional(),
      links: z.array(z.string()).default([]),
    })
    .optional(),
});
export type Profile = z.infer<typeof Profile>;

// PRD §5.6 comment: kebab-case，如 "voice-agent". Reject uppercase, spaces,
// underscores. Exported so callers/tests can reference the exact pattern
// without re-deriving it from the schema.
export const PROJECT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Literal transcription of PRD §5.6's Project sketch — field list, types, and
// order match exactly; do not add constraints beyond what §5.6 states (e.g. no
// `.min(1)` on metrics — see the comment below and the ticket's Background).
export const Project = z.object({
  id: z.string().regex(PROJECT_ID_PATTERN, 'Project.id must be kebab-case, e.g. "voice-agent"'), // kebab-case，如 "voice-agent"
  name: z.string(),
  stage: z.string(),
  role: z.string(),
  stack: z.array(z.string()),
  summary: z.string(), // 2–3 句技术实质：架构决策、tradeoff，不是职责描述
  metrics: z.array(z.string()), // 只允许真实数字；空数组是合法且被显式展示的状态
  tags: z.array(z.string()),
});
export type Project = z.infer<typeof Project>;

export const Library = z.object({
  profile: Profile,
  projects: z.array(Project),
});
export type Library = z.infer<typeof Library>;

// 原件解析后即弃，不落盘 (source discarded after parse; not persisted)
export const Resume = z.object({
  sourceMd: z.string(),
  updatedAt: z.number(),
});
export type Resume = z.infer<typeof Resume>;
```

Notes for the Builder:
- Each `export const X` / `export type X` pair intentionally shares an identifier (value namespace vs. type namespace) — this is the ticket-mandated pattern (`export type X = z.infer<typeof X>`), not a naming collision.
- Do not add `.min(1)`, `.nonempty()`, or any other length constraint to `metrics`, `stack`, or `tags` — the ticket's Background section is explicit that empty `metrics` is a valid, displayed state (PRD §5.6 comment, P2 principle); this is a type-level concern only, the empty-state UI banner is `03-library`/LIB-03's job.
- `PROJECT_ID_PATTERN` as chosen (`/^[a-z0-9]+(-[a-z0-9]+)*$/`) rejects uppercase, whitespace, underscores, leading/trailing hyphens, and doubled hyphens, and accepts single-segment ids (`"a"`) and multi-segment ids (`"voice-agent"`, `"a1-b2"`). This satisfies the ticket's explicit reject list ("uppercase/spaces/underscore") and its one worked example; no PRD text constrains behavior beyond that, so tighter/looser edge-case handling (e.g. whether doubled hyphens should be legal) is this plan's implementation call, not something requiring escalation — see Open Question 3... actually not escalated, this is resolved by the plan (regex above); flag to Reviewer only if a concrete future fixture disagrees.

### 2.4 `lib/schemas/entities.test.ts` (new file)

Vitest unit tests, pattern-matched to `tests/smoke.test.ts`'s `describe`/`it`/`expect` style (per the ticket's own Test plan instruction). Import from `@/lib/schemas/entities` (repo-root alias, confirmed live in `tsconfig.json` and `vitest.config.ts`). No fixtures/mocks — pure inline hand-built objects. Structure:

```ts
import { describe, expect, it } from 'vitest';

import { Library, Profile, Project, PROJECT_ID_PATTERN, Resume } from '@/lib/schemas/entities';
```

Cover, at minimum (mapping 1:1 to the ticket's acceptance checklist):

1. **`describe('Profile')`** — a hand-built valid object with every optional field present (`headline`, `targetRole`, `contact.email`, `contact.links`) parses without throwing; a second case with only `name` (all optionals omitted) also parses without throwing, proving the optionality is real.
2. **`describe('Project')`**:
   - A hand-built valid object matching PRD §5.6's field list (`id: 'voice-agent'`, non-empty `stack`/`tags`, non-empty `metrics`) parses without error.
   - `Project.parse({ ...validProject, metrics: [] })` succeeds and does not throw — explicit assertion this is a valid state (acceptance item 2).
   - `Project.parse({ ...validProject, id: 'Voice_Agent' })` throws / `Project.safeParse(...).success === false` — kebab-case rejection (acceptance item 3, using the ticket's own example string).
   - Additional coverage beyond the single mandated case, exercising each reject category the ticket names ("uppercase/spaces/underscore"): also assert rejection for an id containing a space (e.g. `'voice agent'`) and one containing an underscore-only violation distinct from the uppercase case (e.g. `'voice_agent'`), plus one more acceptance case for a valid multi-segment id.
3. **`describe('Library')`** — `Library.parse({ profile: <valid Profile>, projects: [<valid Project>] })` succeeds; also assert an empty `projects: []` array is valid (no PRD/ticket text requires a non-empty library, and nothing in `Library`'s definition adds a `.min(1)`).
4. **`describe('Resume')`** — `Resume.parse({ sourceMd: '# ...', updatedAt: Date.now() })` succeeds.

No test should reference `fixtures/**` (does not exist yet — `02-evaluation` builds it later; the ticket's Test plan explicitly forbids this).

### 2.5 Ticket + sub-PRD writeback

As specified in §2.2's "Required writeback": bump `docs/prd/01-foundation/tickets/FND-02-core-entity-schemas.md` to `version: 0.2` with a `## Changelog` section, and add a mirroring one-line entry to `docs/prd/01-foundation/README.md`'s `## Changelog`. This is a Builder-stage task (per this repo's established FND-01 precedent), not a re-plan — do it as part of this ticket's implementation, not as a separate ticket.

## 3. Test plan

Maps directly to the ticket's acceptance checklist; each item is what the Builder/Reviewer actually runs.

1. **`pnpm install`** (after adding `zod` to `package.json`) succeeds, `zod` resolves into `node_modules` and `pnpm-lock.yaml` is regenerated with a `zod` entry. If local Corepack friction blocks `pnpm` (see §0's toolchain note), use `npm install -g pnpm@<pinned version>` or `COREPACK_INTEGRITY_KEYS=0` first — don't treat that as a ticket blocker, it's a known, already-documented local-environment issue.
2. **`pnpm test` exits 0** and the output shows tests from *both* `tests/smoke.test.ts` and `lib/schemas/entities.test.ts` running (not just one file) — this proves §2.2's `vitest.config.ts` widening actually took effect; a green run that only shows 1 passed test (the smoke test) is a **false pass**, treat it as a failure and re-check the `include` glob.
3. **Targeted assertions** (all covered by §2.4's test file, re-verify each is actually present and actually exercised, not just planned):
   - `Project`/`Library`/`Resume`/`Profile` all parse a hand-built valid fixture object without throwing.
   - `Project.parse({ ...valid, metrics: [] })` does not throw.
   - `Project.parse({ ...valid, id: 'Voice_Agent' })` throws (or `safeParse(...).success === false`).
4. **Recommended, not ticket-mandated:** run `pnpm build` (or `pnpm exec tsc --noEmit`) once after adding `entities.ts`. Vitest (esbuild-based transpile) does not perform full TypeScript type-checking, so a type error in `entities.ts` (e.g. a malformed generic, a typo'd `z.infer` reference) could pass `pnpm test` while still breaking `next build`'s project-wide `tsc` pass (which walks `tsconfig.json`'s `**/*.ts` include, covering `lib/schemas/entities.ts` even though nothing imports it yet). Not a formal acceptance item per the ticket, but cheap insurance against a type error silently landing — flag any failure here to the Reviewer even though it's outside the ticket's literal checklist.
5. **No file outside the declared scope was touched**: `git diff --stat <FND-01-merge-commit>..HEAD` should list exactly: `lib/schemas/entities.ts`, `lib/schemas/entities.test.ts`, `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `docs/prd/01-foundation/tickets/FND-02-core-entity-schemas.md`, `docs/prd/01-foundation/README.md`. Anything else in the diff is a File-scope violation.
6. All of the above are reproducible fully offline (no DB, no Anthropic API, no network beyond the one-time `pnpm install` to fetch `zod`) — consistent with the ticket's own Test plan framing.

## 4. Risks & edge cases

- **Concurrency: none applies.** `lib/schemas/entities.ts` is a pure, side-effect-free module — schema object literals evaluated once at import time, no I/O, no shared mutable state, no async code. There is no request-handling code in this ticket at all (that's FND-07/API routes in later tickets). Nothing here can race.
- **Security-sensitive path: this file *is* part of PRD §5.5's trust boundary, even though it contains no request-handling code itself.** PRD §5.5 states "所有 stage 输出先过 Zod v4 schema，再执行四层过滤" (all stage output passes through a Zod v4 schema first, then four validation layers) — `Profile`/`Project`/`Library`/`Resume` are the first two of those boundary types other modules will rely on (`Project`/`Library` directly; `Resume` for the parsed-and-discarded source). A schema that's too loose here (e.g. missing the kebab-case constraint, or accepting unbounded string lengths PRD doesn't actually bound) doesn't cause a runtime bug in this ticket, but it *does* weaken every downstream module's input-validation boundary silently. The Reviewer should specifically check: (a) `Project.id`'s regex actually rejects the three categories the ticket names (uppercase/space/underscore), not just the one worked example; (b) no field was made looser than PRD §5.6's literal types (e.g. don't accidentally make `metrics`/`stack`/`tags` accept non-string array members, don't widen `updatedAt` beyond `z.number()`).
- **Shared-file edit risk (`package.json`, `vitest.config.ts`).** Both are owned by `01-foundation`/FND-01 and both get touched here. Confirmed in §0 that no other `01-foundation` ticket is in flight (strict serial execution within a lane per `breakdown-plan.md` §4), so there's no live merge-conflict risk today — but future re-runs of this plan (e.g. a bounce-and-retry) must re-check `git status`/`git log` before assuming the same is still true, since a second ticket could theoretically have landed between planning and execution if the pipeline's serial ordering were ever violated.
- **Deprecated-API judgment call (`z.email()` vs. the ticket's literal `z.string().email()`).** Functionally identical validation, but textually diverges from the ticket's Deliverable-1 code snippet. The ticket explicitly frames `Profile` as latitude for "minimal reasonable extension" with invented fields marked as design choices, but does not explicitly grant latitude to *deviate from a literal API call it wrote out*. This plan reads the two as low-risk to conflate (same runtime behavior, avoids depending on an API already marked for removal) but flags it for the Reviewer rather than asserting it's obviously fine — see Open Question 2. If the Reviewer disagrees, reverting to `z.string().email()` is a one-line change with no cascading impact (nothing else in this ticket depends on which spelling was used).
- **`PROJECT_ID_PATTERN` strictness is an implementation call, not a PRD-derived constraint.** PRD §5.6 gives exactly one example (`"voice-agent"`) and the ticket names three reject categories (uppercase/space/underscore) but no exhaustive spec (e.g. nothing says whether `"123"` or doubled hyphens like `"a--b"` should be legal). The chosen regex (§2.3) is a reasonable, defensible reading, but if a later ticket (e.g. LIB-01, which generates real `Project.id` values from parsed resumes) hits a real id shape this regex rejects unexpectedly, that is exactly the kind of "PRD §5.6 sketch found inconsistent with downstream consumption" scenario the ticket's Feedback obligation #2 already anticipates — escalate to Horace via `01-foundation/README.md`'s open-questions table at that point, don't silently loosen the regex.
- **Type-inference nuance: `contact.links` has `.default([])`.** In Zod v4 (same as v3), `z.infer<typeof Schema>` yields the schema's *output* type. A field with `.default(...)` is optional on the *input* side but always-present (never `undefined`) on the *output* side after `.parse()`/`.safeParse()` succeeds. This is almost certainly the intended behavior (an omitted `links` array should parse to `[]`, not `undefined`), but is worth the Builder/Reviewer double-checking against the inferred `Profile` type once written (e.g. via a quick `expectTypeOf` check or just reading the generated `.d.ts` shape) rather than assuming — a silent mismatch here wouldn't fail `pnpm test`'s runtime assertions but could surprise a later ticket's TypeScript code that destructures `profile.contact?.links`.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Exact `zod` patch/minor version to pin (this plan specifies `^4.4.3`, the latest stable at planning time 2026-07-18) — re-verify at implementation time rather than trusting this plan's dated number. | Builder, at implementation time — record the resolved version in the deviation/changelog note, no re-review needed (normal dependency-pin variance, mirrors FND-01's own precedent for `next`/`react`). |
| 2 | Whether using `z.email()` (non-deprecated Zod v4 top-level form) instead of the ticket's literal `z.string().email()` snippet for `Profile.contact.email` is within the ticket's stated design latitude for `Profile`, or should be reverted to the literal spelling for strict transcription fidelity. | Reviewer, at review time — this plan's position is "in scope, revert is a trivial one-line fallback if disagreed with," not requiring a Horace escalation either way since both spellings validate identically. |
| 3 | Whether widening `vitest.config.ts`'s `include` array (§2.2) is correctly FND-02's job (this plan's position — it's required for this ticket's own acceptance item 4 to be true, and no other `01-foundation` ticket is in flight to conflict with it) versus being treated as an out-of-scope infra fix that should have been anticipated in FND-01 or deferred to whichever ticket first hits it. | Reviewer, at review time — if the Reviewer disagrees, the only alternative that doesn't require a shared-config change is relocating the test file to `tests/schemas/entities.test.ts`, which would contradict the ticket's File-scope/Deliverables/Test-plan text (each names `lib/schemas/entities.test.ts` explicitly); this plan recommends against that alternative. |

## ADR-candidate flag

None of this ticket's choices rise to ADR-worthy (hard-to-reverse architectural decision) status. The core `Project`/`Library`/`Resume` shapes are a direct, literal transcription of an already-PRD-fixed sketch (§5.6) — not a new decision. `Profile`'s shape is explicitly framed by the ticket itself as cheap-to-extend, non-load-bearing latitude, not a contract other modules must match exactly (ticket Feedback obligation #1 already prescribes the correction path if it's wrong: extend the same file, bump the ticket version, no ADR). The `vitest.config.ts`/`package.json` shared-file edits are mechanical, reversible, and already covered by the breakdown plan's existing append-only convention for these exact files. No ADR is proposed by this plan.
