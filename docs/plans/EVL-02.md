# Implementation plan — EVL-02: Q1–Q3 evaluation harness (`pnpm eval`)

Ticket: [docs/prd/02-evaluation/tickets/EVL-02-eval-harness.md](../prd/02-evaluation/tickets/EVL-02-eval-harness.md)
Sub-PRD: [docs/prd/02-evaluation/README.md](../prd/02-evaluation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §6 (quality-gate table — the load-bearing spec, quoted verbatim in the ticket), §8.1 (model-pin policy: "模型 pin 在 config"; explicit exclusion of LangChain/LlamaIndex — "Zod 边界 + 裸 fetch 足够", which is why this plan calls the Anthropic Messages API via raw `fetch`, not an SDK), §8.4 (cost observability: "每次操作落 tokens / searches / cost / duration / dropped / stage 状态"), §9 (Haiku 4.5 = $1 in / $5 out per MTok, vs. Sonnet 5 = $2/$10 — the rate gap behind this plan's Risk #1)
Depends on (merged, confirmed at planning time by direct read — see §0): FND-04 (`lib/schemas/persisted.ts` — `EvalRun`, `EvalSuite`, `UsageOp`), FND-05 (`db/index.ts`, `db/schema.ts` — `evalRuns` table, PGlite test pattern), FND-06 (`lib/config/models.ts` — `JUDGE_MODEL`), FND-07 (`lib/validation/*` — `ensureRequirementCoverage`, `filterNumberIntegrity`), FND-10 (`lib/usage/record.ts` — `recordUsage()`), EVL-01 (`fixtures/manifest.json`, `fixtures/jds/*.md`, `fixtures/resumes/*.md`)
Downstream (read this plan's decisions before starting): FIT-01, FIT-02, TLR-01, PRP-02 (each adds a `[fixture]` acceptance item calling this harness against real stage output — per the ticket's Feedback obligation #1, if `runSuite()`'s shape doesn't fit, they extend `eval/**` directly and record a changelog line in `02-evaluation/README.md`)

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-19) by direct inspection, not assumption:

- `git log -1 --oneline`: HEAD is `f2fd57f` on branch `main`, working tree clean. This is **the base commit** the Builder's diff should be measured against. All of FND-04/05/06/07/10 and EVL-01 (and PLT-01) are already merged into `main` — confirmed by `git log --oneline --all` showing `bf192bb Merge ticket/EVL-01 into main` and `64f8f41 Merge ticket/FND-10 into main` both as ancestors of `f2fd57f`.
- `pnpm test` baseline (run via `node_modules/.bin/vitest run` — `pnpm` itself was not on this shell's `PATH`, the local binary is equivalent): **28 test files, 274 tests, all green**, ~14–20s wall time. Record this number; if it changes unexpectedly during Builder work, something outside this ticket's scope moved.
- `fixtures/manifest.json` (EVL-01) shape, confirmed by direct read: `{ jds: [{ file, category, label }] × 10, resumes: [{ file, seniority }] × 3 }`. No `id`/`text` fields — `eval/fixtures.ts`'s `loadFixtures()` must derive `id` (this plan: `path.basename(file, '.md')`) and `text` (read the file) itself.
- `db/schema.ts`'s `evalRuns` table (confirmed by direct read): `{ id (pk, autogen), suite: evalSuiteEnum, op: usageOpEnum, passRate: numeric('pass_rate', {mode:'number'}), details: jsonb, createdAt: bigint (autogen) }`. **No `userId` column** — `writeEvalRun()` never needs a user context, only `judge.ts`'s `recordUsage()` call does (see Risk #1).
- `lib/usage/record.ts`'s `recordUsage()` (confirmed by direct read) hardcodes `RECORD_USAGE_PRICING_MODEL = 'sonnet5'` (FND-06's `PRICING.sonnet5`, $2 in/$10 out) with **no `model` parameter** — its own file header comment states verbatim: *"if `02-evaluation`/EVL-02 ever routes judge-model (`haiku45`) cost tracking through this same `recordUsage()` … every such call would be mispriced at Sonnet rates — this ticket's Goal section does not list EVL-02 as a caller, so this plan does not accommodate it."* `docs/plans/FND-10.md`'s own Open Question #2 says the same thing and defers it to Horace. **This plan does not fix `lib/usage/record.ts` (out of this ticket's file-scope) — see Risk #1.**
- **No Anthropic SDK dependency exists anywhere in the repo** (`grep -ri anthropic` over `*.ts`/`*.json` outside `node_modules` returns only prose/doc files, zero code). PRD §8.1 explicitly rejects LangChain/LlamaIndex in favor of "Zod 边界 + 裸 fetch" — confirms `judge.ts` must call the Anthropic Messages API via plain `fetch`, and confirms EVL-02 must not add an SDK dependency (also enforced by File-scope: `package.json` may only gain the `"eval"` script line). `ANTHROPIC_API_KEY` already exists in `.env.example` (added by an earlier ticket) — no env-var plumbing needed.
- **`vitest.config.ts`'s `test.include` does not cover `eval/**`** — confirmed by direct read: `['tests/**/*.test.ts', 'lib/**/*.test.ts', 'db/**/*.test.ts', '*.test.ts', 'app/**/*.test.{ts,tsx}', 'fixtures/**/*.test.ts']`. None matches `eval/**/*.test.ts`. **Blocking gap** (same "false-green" failure class FND-02/05/06/08/09 and EVL-01 each fixed for their own new test paths) — §2.9 adds `'eval/**/*.test.ts'`.
- **A newly-discovered, ticket-unstated technical constraint, empirically verified during this planning pass (§1 below has the full rationale): running TypeScript directly under plain Node (`node --experimental-strip-types`, needed because `scripts/eval.mjs`'s literal invocation is `node scripts/eval.mjs` — no bundler, no `tsx`/`ts-node`, which are not installed and out of file-scope to add) requires every relative import in the executed file's transitive graph to carry an explicit `.ts` extension** (Node ESM does no extensionless or directory-index resolution) **and TypeScript's own `tsc`/`next build` type-check rejects a literal `.ts` import extension unless `compilerOptions.allowImportingTsExtensions` is set** (verified: `tsc -p` against a reproduction throws `TS5097` without it, exits clean with it; `noEmit: true`, the only prerequisite, is already set in `tsconfig.json`). §2.1 covers the full design this forces; §2.10 is the one-line `tsconfig.json` fix.
- Installed Node is `v22.11.0` (`--experimental-strip-types` requires ≥22.6; supported and verified working here, including `--disable-warning=ExperimentalWarning` to suppress the experimental-feature stderr banner). `.github/workflows/ci.yml` pins `node-version: '22'` (latest 22.x at run time — safely above 22.6). `package.json`'s `"engines": {"node": ">=20"}` is **below** this ticket's real floor — flagged as Risk #4, not silently fixed (package.json's File-scope line is explicit: *"append `\"eval\": \"node scripts/eval.mjs\"` script only"* — no license here to also bump `engines`).
- `eslint.config.mjs` only extends `next/core-web-vitals`/`next/typescript` with no `import/extensions`-style rule — explicit `.ts` import extensions will not trip lint.
- `tsconfig.json`'s `include` (`"**/*.ts"`) already covers every new `eval/**/*.ts` file with no change needed beyond §2.10's one compiler-option addition; `.mjs` files are outside `**/*.ts`/`**/*.tsx`, so `scripts/eval.mjs` is never type-checked (expected — it is a thin plain-JS launcher, §2.1).
- Serial-safety: per `docs/prd/breakdown-plan.md` line 54, `eval/**` + `scripts/eval.mjs` is EVL-02's exclusive scope; no other ticket has touched it (`eval/` does not exist yet — confirmed by directory listing). `vitest.config.ts` and `tsconfig.json` are shared files outside EVL-02's literal write-owns list but already precedented as Architect-directed touch points (EVL-01 → `vitest.config.ts`; every FND ticket that added a new test surface did the same) — no other in-flight branch touches either file (all prior tickets are merged into `main`).

## 1. Scope

**In scope** (per ticket Deliverables 1–7, Goal, File-scope, Test plan):

- `eval/fixtures.ts` — `loadFixtures()`, reading `fixtures/manifest.json` + referenced files.
- `eval/judge.ts` — `judgeCall()`, calling the real Anthropic Messages API via `fetch` with an injectable client/fetch seam, recording cost via `recordUsage()` when a `userId` is supplied.
- `eval/assertions/q1.ts` — 5 deterministic functions: `assertQ1Schema`, `assertQ1Coverage`, `assertQ1Questions`, `assertQ1NumberIntegrity`, `assertQ1DroppedRate`.
- `eval/assertions/q2.ts` — `assertQ2Grounded` + `assertQ2GroundedBatch`.
- `eval/assertions/q3.ts` — `assertQ3Specific` + `assertQ3SpecificBatch`.
- `eval/report.ts` — `writeEvalRun()`, inserting one `eval_runs` row.
- `eval/index.ts` — barrel re-export of everything above.
- **Two files not literally named by the ticket, added because Deliverable 7 requires them and the Node-execution constraint (§0, §2.1) makes them unavoidable — flagged explicitly, not smuggled in:**
  - `eval/run-suite.ts` — the "documented extension point" Deliverable 7 asks for (`runSuite()`), factored out of `scripts/eval.mjs` so it is a first-class, independently importable, independently testable function per the ticket's own Feedback-obligation framing ("`04-fit`/`05-tailor`/`06-prep`'s own tickets call [it] with REAL stage output").
  - `eval/self-check.ts` — the actual self-check **logic** (constructs mock stage outputs, calls `runSuite()`, prints a report, sets the process exit code). `scripts/eval.mjs` cannot contain this logic directly and still satisfy Deliverable 7 (see §2.1) — it is a plain-JS launcher that spawns this file under `node --experimental-strip-types`.
- `scripts/eval.mjs` — the `pnpm eval` entry point (thin launcher only, per §2.1).
- Test files: `eval/fixtures.test.ts`, `eval/judge.test.ts`, `eval/assertions/q1.test.ts`, `eval/assertions/q2.test.ts`, `eval/assertions/q3.test.ts`, `eval/report.test.ts`, `eval/run-suite.test.ts`, `eval/self-check.test.ts` (subprocess integration test).
- `package.json` — append exactly `"eval": "node scripts/eval.mjs"` to `scripts` (no other line changes).
- `vitest.config.ts` — add `'eval/**/*.test.ts'` to `test.include` (§2.9, precedented necessity).
- `tsconfig.json` — add `"allowImportingTsExtensions": true` to `compilerOptions` (§2.10, precedented necessity — without it `next build`'s type-check phase, which CI's own `.github/workflows/ci.yml` runs after `pnpm test`, fails on every explicit `.ts` import extension this design requires).

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):

- No real stage (`04-fit`/`05-tailor`/`06-prep`) wiring — those tickets don't exist yet in the dependency order; `runSuite()`/`self-check.ts` use only hand-built mock data.
- No Q4 (human real-world hit-rate) — zero code for it.
- No `eval_runs` schema changes — FND-04/FND-05's shape is used as-is; this ticket has no reason to extend it (unlike the Goal's own hedge, "if insufficient, this ticket appends per FND-04's own Feedback obligation" — this plan's design fits the existing shape with no gap).
- No `fixtures/**` edits (EVL-01, read-only import), no `app/api/**` route, no edits inside `lib/validation/**` (read-only import — only `ensureRequirementCoverage`/`filterNumberIntegrity` are imported, never modified) or `lib/usage/record.ts` (read-only import, never modified — see Risk #1).
- No fix to `lib/usage/record.ts`'s Sonnet-only pricing (Risk #1) — out of file-scope, flagged not silently patched.
- No `package.json` change beyond the single `"eval"` script line — `engines.node` stays `">=20"` even though this ticket's own design needs `>=22.6` (Risk #4) — mitigated with a runtime guard inside `scripts/eval.mjs` instead of a config edit.

## 2. Change list

### 2.1 Foundational design decision — how `pnpm eval` can execute TypeScript at all

**The problem** (empirically verified during planning, not theoretical): the ticket's File-scope fixes the npm script text verbatim as `"eval": "node scripts/eval.mjs"` — plain `node`, no bundler, no `tsx`/`ts-node` (neither is an installed dependency, and adding one is not authorized — `package.json`'s File-scope line says "append … script only"). Yet Deliverable 7 requires `scripts/eval.mjs`'s self-check mode to import and call the real `eval/assertions/q1.ts`/`q2.ts`/`q3.ts` functions — genuine `.ts` source, using this repo's Zod/type-heavy style. Plain Node (v22.11, installed here and what CI's `node-version: '22'` resolves to) can execute `.ts` files via the built-in `--experimental-strip-types` flag, but two hard constraints follow, both verified directly against this repo's actual toolchain during planning:

1. **Node's ESM resolver does no extensionless or directory-index resolution — ever, flag or no flag.** A relative import must name its target file exactly, including the `.ts` extension (verified: `import { x } from '../lib/models'` → `ERR_MODULE_NOT_FOUND`; `import { x } from '../lib/models.ts'` → works). The `@/*` path alias (`tsconfig.json`) is a TypeScript/bundler-only feature — Node's resolver has zero knowledge of it and cannot be given any without a custom loader (out of scope; not needed — see below).
2. **`tsc`/`next build`'s type-checker rejects a literal `.ts` import extension by default** (`TS5097`) unless `compilerOptions.allowImportingTsExtensions` is enabled — verified by reproducing the exact error against a throwaway project using this repo's own `tsc` binary and tsconfig shape, then confirming it clears once the option is added. `noEmit: true` (already set) is the only prerequisite. §2.10 makes this one-line addition to `tsconfig.json`.

**The design this forces, mandatory for every non-test file under `eval/**` that is reachable from the plain-Node entry point (`eval/self-check.ts` and everything it transitively imports — i.e. `fixtures.ts`, `judge.ts`, `assertions/q1.ts`, `assertions/q2.ts`, `assertions/q3.ts`, `run-suite.ts`, `report.ts`, `index.ts`):**

- Every **runtime** (non-`import type`) cross-file reference — whether into another `eval/**` file or out to `lib/**`/`db/**` — uses a **relative path with an explicit `.ts` extension** (e.g. `'../lib/validation/requirement-coverage.ts'`, `'./judge.ts'`), never the `@/*` alias. This is a deliberate, explained deviation from the rest of the repo's `@/`-alias convention, scoped to `eval/**` non-test source files only.
- Every **type-only** reference (parameter/return types like `JdExtract`, `Ledger`, `Rehearse`, `RehearseQuestion`, `UsageOp`, `EvalSuite`) uses an explicit `import type { … } from '...'` statement. Node's type-stripping fully erases `import type` statements (zero runtime import emitted), so these are **safe to write with the plain `@/*` alias** if preferred for readability — they never touch Node's module resolver at all. This plan recommends staying consistent and using relative+`.ts` for these too, to avoid the Builder having to reason per-import about which rule applies; either is technically correct, and using the alias here does not break anything — call this out to the Reviewer as a low-stakes style choice, not a defect either way.
- Import from **concrete sibling files directly**, not through a barrel that itself uses extensionless re-exports you do not own. Concretely: `eval/assertions/q1.ts` must import `ensureRequirementCoverage` from `'../../lib/validation/requirement-coverage.ts'` and `filterNumberIntegrity` from `'../../lib/validation/number-integrity.ts'` — **not** from `'../../lib/validation'` / `'../../lib/validation/index.ts'`, because `lib/validation/index.ts` (FND-07-owned, out of file-scope, unmodifiable) itself re-exports via extensionless relative paths (`export { ... } from './requirement-coverage';`), which would break resolution the moment Node tried to follow that barrel's own internal import. Both `requirement-coverage.ts` and `number-integrity.ts` have zero problematic runtime imports of their own (verified by direct read: `requirement-coverage.ts` only has `import type`, fully erased; `number-integrity.ts` has no imports at all) — importing them directly is safe.
- **Two call sites genuinely cannot be made Node-resolvable at all, because they reach into files EVL-02 does not own and cannot edit, whose own internal imports use the `@/*` alias:** `lib/usage/record.ts` (`import { db } from '@/db/index';`) and `db/index.ts` itself (`import * as schema from './schema';` — no extension). The fix is to **never let loading these happen at module-evaluation time** — defer them behind a **lazy `await import(...)` inside the function body that actually needs them**, so merely *loading* `eval/judge.ts` / `eval/report.ts` / `eval/index.ts` never touches `@/db/index`, and the crash point is only reachable if the real (non-mocked) `judgeCall()`/`writeEvalRun()` is genuinely *invoked*:

  ```ts
  // eval/judge.ts — inside judgeCall(), only when opts.userId is supplied:
  if (opts.userId) {
    const { recordUsage } = await import('../lib/usage/record.ts');
    await recordUsage({ userId: opts.userId, op: opts.op ?? 'cross', tokensIn, tokensOut, searches: 0, durationMs });
  }
  ```

  ```ts
  // eval/report.ts — inside writeEvalRun():
  const { db } = await import('../db/index.ts');
  const { evalRuns } = await import('../db/schema.ts');
  await db.insert(evalRuns).values({ suite, op, passRate, details });
  ```

  This is not just a workaround for plain-Node execution — it is the **same shape** this repo's own tests already use for anything that touches `db/index.ts` (`lib/usage/record.test.ts` / `lib/config/quota.test.ts` both `vi.resetModules()` + `vi.doMock('@/db/index', ...)` + a **dynamic** `import()`, specifically because `db/index.ts` throws eagerly at import time without `DATABASE_URL`). This plan is extending an already-established pattern, not inventing a new one. Real (non-mocked) execution of `judgeCall()`/`writeEvalRun()` never happens under plain Node in this system's actual usage — it only ever happens inside Vitest (alias-aware via `vitest.config.ts`'s `resolve.alias`) or, once a future ticket wires it in, inside the Next.js app runtime (alias-aware via its own bundler). Plain-Node execution (`scripts/eval.mjs`'s self-check) **never calls the real `judgeCall()`/`writeEvalRun()`** (§2.7) — so this lazy-import boundary is never actually crossed during self-check, and the alias-touching code inside `record.ts`/`db/index.ts` is never reached from that path.

- `scripts/eval.mjs` itself is **plain JavaScript, no TypeScript syntax** — it does not need the stripping flag for itself, only to spawn a child Node process that has it (see §2.8). Design:

  ```js
  #!/usr/bin/env node
  import { spawnSync } from 'node:child_process';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';

  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const entry = path.join(repoRoot, 'eval', 'self-check.ts');

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 6)) {
    console.error(
      `pnpm eval requires Node >=22.6 (for --experimental-strip-types); ` +
        `you have ${process.version}. package.json's "engines" field currently ` +
        `understates this — see docs/plans/EVL-02.md Risk #4.`,
    );
    process.exit(1);
  }

  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', entry],
    { stdio: 'inherit', cwd: repoRoot },
  );
  process.exit(result.status ?? 1);
  ```

  Verified end-to-end during planning (repo-external reproduction): a thin `.mjs` launcher spawning a `.ts` entry via `--experimental-strip-types`, where the entry imports a sibling `.ts` module (with an explicit extension) that itself does a **lazy** dynamic import gated behind a runtime condition, runs clean and exits 0, with `--disable-warning=ExperimentalWarning` fully suppressing the experimental-feature stderr banner.

### 2.2 `eval/fixtures.ts`

```ts
export type FixtureJd = { id: string; category: string; text: string };
export type FixtureResume = { id: string; seniority: string; text: string };

export function loadFixtures(): { jds: FixtureJd[]; resumes: FixtureResume[] }
```

- Resolves repo root the same way `fixtures/manifest.test.ts` (EVL-01) already does: `fileURLToPath(new URL('..', import.meta.url))` — `eval/` is one level below repo root, same depth as `fixtures/`.
- Reads `fixtures/manifest.json` via `node:fs`/`JSON.parse` (not a static `import ... from '...json'` — avoids any `resolveJsonModule`/Node-JSON-import-assertion question entirely; matches EVL-01's own test file's approach).
- For each `jds[]`/`resumes[]` manifest entry: `id = path.basename(entry.file, '.md')` (e.g. `"ai-ml-engineer-01"`), `text = fs.readFileSync(path.join(repoRoot, entry.file), 'utf8')`, plus the manifest's own `category`/`seniority`.
- Only `node:fs`, `node:path`, `node:url` imports — zero `lib/**`/`db/**`/alias touch, trivially safe under plain Node.

### 2.3 `eval/assertions/q1.ts` — 5 pure, synchronous functions

All five operate on already-produced values (no I/O, no async) — matches the ticket's own framing ("pure function over already-produced stage output").

1. `assertQ1Schema(rawOutput: unknown, schema: ZodType, repairAttempted: boolean): { pass: boolean; detail: string }` — `const result = schema.safeParse(rawOutput);` — `pass = result.success`. `repairAttempted` does **not** branch pass/fail (per ticket: "this function only checks the FINAL parse result") — it only changes the wording of `detail` on failure (e.g. `"schema invalid even after 1 repair attempt: <zod error summary>"` vs `"schema invalid, no repair attempted: <...>"`), so a caller/report reader can distinguish the two failure modes without this function itself performing any retry.
2. `assertQ1Coverage(jd: JdExtract, ledger: Ledger): { pass: boolean; uncoveredCount: number }` — import `ensureRequirementCoverage` directly (§2.1). Compute `uncoveredCount = injectedGaps.length` (requirements in neither `bindings` nor `gaps`). **Additionally** (the ticket's own "恰好一次" double-check, not covered by `ensureRequirementCoverage` alone): compute the set of requirement IDs appearing in `ledger.bindings` and the set appearing in `ledger.gaps`, and count any ID present in **both** as a second violation category folded into the same `pass` boolean (`pass = uncoveredCount === 0 && duplicateCount === 0`). Return `uncoveredCount` as the ticket's literal field name; the duplicate check contributes to `pass` but does not need its own named field unless the Builder wants extra `detail` — not required by the acceptance checklist, which only asks for two separate unit tests (one per failure mode), not two separate return fields.
3. `assertQ1Questions(rehearse: Rehearse): { pass: boolean; detail: string }` — `pass = rehearse.questions.length === 5 && rehearse.questions.every(q => q.trap.length > 0)`. Note `RehearseQuestion.trap` is already Zod-`.min(1)`-enforced (`lib/schemas/pipeline.ts`) — this assertion is a **second, independent, explicitly-named check** per the ticket's own instruction ("re-asserted here as an explicit named Q1 check"), not a redundant no-op: a caller may pass a `rawOutput`-adjacent object that never went through the Zod schema at all (e.g. hand-built test/mock data), so this function must not assume Zod already validated it.
4. `assertQ1NumberIntegrity(tailorOutput: { fullDraftMd: string }, sourcePool: { resumeMd: string; libraryMetrics: string[] }): { pass: boolean; violationCount: number }` — import `filterNumberIntegrity` directly (§2.1). `violationCount = dropped.length`; `pass = violationCount === 0`.
5. `assertQ1DroppedRate(droppedCount: number, totalCount: number): { pass: boolean; rate: number }` — `rate = totalCount === 0 ? 0 : droppedCount / totalCount`; `pass = rate < 0.15` (**strict `<`**, not `<=` — the acceptance checklist's own boundary test pins `rate = 0.15` as failing and `rate = 0.1499...` as passing). Guard `totalCount === 0` explicitly (avoid `NaN`) — division by zero is a real edge case a caller could hit if a stage produced zero items total; `rate: 0` with `pass: true` is the reasonable degenerate case (no items, nothing dropped).

### 2.4 `eval/judge.ts`

```ts
export type JudgeCallOptions = {
  op?: UsageOp;        // UsageOp being evaluated, e.g. 'cross' — forwarded to recordUsage()
  userId?: string;      // omit to skip recordUsage() entirely (no natural per-request user
                         // for a CI-triggered `pnpm eval` run against fixture data — see Risk #1)
  fetchImpl?: typeof fetch; // injection seam; defaults to the global fetch
};

export async function judgeCall(
  prompt: string,
  opts: JudgeCallOptions = {},
): Promise<{ verdict: 'pass' | 'fail'; reasoning: string }>
```

- Request: `POST https://api.anthropic.com/v1/messages`, headers `{'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'}`, body `{ model: JUDGE_MODEL, max_tokens: 512, messages: [{ role: 'user', content: prompt }] }` (`JUDGE_MODEL` imported directly from `'../lib/config/models.ts'`, §2.1). `max_tokens: 512` is this plan's own reasonable cap for a pass/fail-plus-short-reasoning judge response — not PRD-specified; flagged as a Builder-adjustable constant, not load-bearing.
- **Fail loud on transport/API errors** — if `res.ok` is false, or the fetch itself rejects, `judgeCall` **throws** (does not silently return a fake `'fail'` verdict). Converting an API outage into "the evidence isn't grounded" would inject a false, misleading quality signal into a system whose whole point is catching real hallucination — the opposite of PRD §7's "证据 / 改写幻觉 P0 = 0" posture. The caller (`runSuite`/a future stage-owning ticket) decides how to surface the throw; this function's job is only to never lie about *why* it failed.
- **Verdict parsing**: the prompt (built by `assertQ2Grounded`/`assertQ3Specific`, §2.5/§2.6 — not this file) must instruct the judge model to begin its reply with the literal token `PASS` or `FAIL`. Parse via `/^\s*(pass|fail)/i` against `data.content[0].text`; `reasoning` is the full response text. **If the response matches neither** (an unparseable judge reply), treat it as `verdict: 'fail'` with `reasoning` prefixed `"unparseable judge response: "` — fail-closed, matching the same "don't silently invent a pass" posture as the transport-error case above (this one degrades to a value rather than throwing, since a genuinely malformed-but-successful API response is a lower-severity, more expected occasional occurrence than a transport failure, and a Q2/Q3 batch run should not abort entirely over one malformed reply — it should count it as a failure and let the batch's own pass-rate and the caller's own review process surface it).
- **`recordUsage()` call — lazy, conditional on `opts.userId`** (§2.1 has the exact code and full rationale). When invoked, forwards `tokensIn`/`tokensOut` from the response's `usage.input_tokens`/`usage.output_tokens` (defaulting to `0` if the field is absent — do not let a missing `usage` block throw), `searches: 0` (judge calls never use `web_search`), `durationMs` measured via `Date.now()` bracketing the fetch call, `op: opts.op ?? 'cross'`.

### 2.5 `eval/assertions/q2.ts`

```ts
export async function assertQ2Grounded(
  claim: string,
  sourceContext: string,
  opts: { op?: UsageOp; userId?: string; judgeCallImpl?: typeof judgeCall } = {},
): Promise<{ pass: boolean; reasoning: string }>

export async function assertQ2GroundedBatch(
  claims: Array<{ claim: string; sourceContext: string }>,
  opts: { op?: UsageOp; userId?: string; judgeCallImpl?: typeof judgeCall } = {},
): Promise<{ passRate: number; results: Array<{ claim: string; pass: boolean; reasoning: string }> }>
```

- The ticket's literal two-positional-argument signature (`claim`, `sourceContext`) is preserved exactly; the trailing `opts` object is this plan's addition, needed to thread `judgeCall`'s injection seam and cost-recording context through without changing the first two arguments (so both the ticket's own illustrative signature and this plan's testability/cost-recording needs are satisfied simultaneously — flagged explicitly as a plan-level extension, not silently invented).
- Prompt content (built here, not in `judge.ts`): asks whether `claim` (an evidence string / resume rewrite / gap `play`) can be derived from `sourceContext` (the cited library project's `summary`/`metrics`/`stack`, or the source resume text) — per the ticket's own Deliverable 4 framing. Exact wording is this ticket's own responsibility to iterate on (per the ticket's Feedback obligation #2 — prompt quality is an ongoing, evaluation-owned concern once real judge runs happen); this plan only fixes the **contract** (`PASS`/`FAIL`-prefixed response, per §2.4).
- `assertQ2GroundedBatch` calls `assertQ2Grounded` once per item (sequentially — no `Promise.all` fan-out; see Risk #3 on why), computes `passRate = results.filter(r => r.pass).length / results.length` (guard `results.length === 0` → `passRate: 0`, not `NaN`).

### 2.6 `eval/assertions/q3.ts`

```ts
export async function assertQ3Specific(
  question: RehearseQuestion,
  candidateContext: string,
  opts: { op?: UsageOp; userId?: string; judgeCallImpl?: typeof judgeCall } = {},
): Promise<{ pass: boolean; reasoning: string }>

export async function assertQ3SpecificBatch(
  items: Array<{ question: RehearseQuestion; candidateContext: string }>,
  opts: { op?: UsageOp; userId?: string; judgeCallImpl?: typeof judgeCall } = {},
): Promise<{ passRate: number; results: Array<{ pass: boolean; reasoning: string }> }>
```

- Prompt asks, per the ticket's exact framing: "could this question be asked of any random candidate, or does it require this specific project's details?" — model answers `PASS` (specific — good) or `FAIL` (generic — bad; "能问任何候选人 → fail"). Same contract/wording ownership split as §2.5.
- Same batch/pass-rate/guard shape as §2.5.

### 2.7 `eval/report.ts`

```ts
export async function writeEvalRun(
  suite: EvalSuite,
  op: UsageOp,
  passRate: number,
  details: Record<string, unknown>,
): Promise<void>
```

- Lazy dynamic import of `db`/`evalRuns` (§2.1's exact code). `id`/`createdAt` are left to Drizzle's own `$defaultFn` (confirmed by direct read of `db/schema.ts` — both auto-generate); only `suite`, `op`, `passRate`, `details` are passed to `.values({...})`.
- **Does not catch/swallow its own insert error** — deliberately the opposite of `recordUsage()`'s contract. `recordUsage()`'s "never throw" rule exists so a cost-logging outage never blocks a *user-facing* request (FND-10's own Deliverable 3, an explicit application of P3's "degrade, don't block" spirit). `writeEvalRun()` is called from a CI/quality-gate context (`pnpm eval`, or a future stage-owning ticket's own controlled invocation) where a report failing to persist is itself a signal worth surfacing loudly, not swallowing. Flagged explicitly here so the Reviewer does not mistake the asymmetry with `recordUsage()` for an oversight.

### 2.8 `eval/run-suite.ts` — the Deliverable 7 extension point

```ts
export type RunSuiteInput = {
  op: UsageOp;
  q1?: Array<
    | { kind: 'schema'; rawOutput: unknown; schema: ZodType; repairAttempted: boolean }
    | { kind: 'coverage'; jd: JdExtract; ledger: Ledger }
    | { kind: 'questions'; rehearse: Rehearse }
    | { kind: 'numberIntegrity'; tailorOutput: { fullDraftMd: string }; sourcePool: { resumeMd: string; libraryMetrics: string[] } }
    | { kind: 'droppedRate'; droppedCount: number; totalCount: number }
  >;
  q2?: Array<{ claim: string; sourceContext: string }>;
  q3?: Array<{ question: RehearseQuestion; candidateContext: string }>;
  judgeCallImpl?: typeof judgeCall;
  userId?: string;   // forwarded into every judge call's recordUsage() context
  persist?: boolean; // default false — when true, calls writeEvalRun() once per suite (q1/q2/q3) that ran
};

export type RunSuiteResult = {
  q1: Array<{ kind: string; pass: boolean; detail: unknown }>;
  q2?: { passRate: number; results: Array<{ claim: string; pass: boolean; reasoning: string }> };
  q3?: { passRate: number; results: Array<{ pass: boolean; reasoning: string }> };
};

export async function runSuite(input: RunSuiteInput): Promise<RunSuiteResult>
```

- Runs whichever of `q1`/`q2`/`q3` are present in `input`; each `q1[]` entry is dispatched to the matching `assertQ1*` function by its `kind` tag.
- `persist: false` by default — **`eval/self-check.ts` always calls `runSuite()` with `persist: false`** (no DB touch at all in the self-check path, keeping it plain-Node-safe per §2.1 and independent of `DATABASE_URL`). A future stage-owning ticket that wires real output can opt into `persist: true` once it runs inside a context where `writeEvalRun()`'s lazy `@/db/index` import is actually reachable (Vitest or the Next.js app runtime — never plain Node, per §2.1).
- **Explicitly flagged as provisional**, per the ticket's own Feedback-obligation #1 ("if `runSuite()`'s signature doesn't fit … they extend this ticket's `eval/` files directly … and must update this ticket's Deliverables"). This plan does not attempt to predict `04-fit`/`05-tailor`/`06-prep`'s exact real-output shapes (those tickets don't exist yet) — the tagged-union `q1[]` shape above is this plan's best guess at a reasonably extensible design, not a guarantee.

### 2.9 `eval/index.ts` — barrel

Re-exports everything from §2.2–2.8 using relative+`.ts`-extension exports (consistent with §2.1's rule, so the barrel itself stays plain-Node-loadable if a future file ever imports through it rather than the concrete files directly):

```ts
export { loadFixtures } from './fixtures.ts';
export { judgeCall } from './judge.ts';
export {
  assertQ1Schema, assertQ1Coverage, assertQ1Questions, assertQ1NumberIntegrity, assertQ1DroppedRate,
} from './assertions/q1.ts';
export { assertQ2Grounded, assertQ2GroundedBatch } from './assertions/q2.ts';
export { assertQ3Specific, assertQ3SpecificBatch } from './assertions/q3.ts';
export { writeEvalRun } from './report.ts';
export { runSuite } from './run-suite.ts';
```

Plus the corresponding `export type { ... }` lines for every type named in §2.2–2.8. This satisfies the Goal's literal example (`import { assertQ1Schema, ..., assertQ2Grounded, assertQ3Specific } from '@/eval'`) — consumed via the normal `@/*` alias from within the Next.js app/Vitest, where alias resolution is not a concern (§2.1's constraint only applies to the plain-Node self-check path).

### 2.10 `eval/self-check.ts` — the actual self-check logic (Deliverable 7)

Constructs, **per Q1/Q2/Q3 assertion**, one hand-built *passing* mock and one hand-built *deliberately-violating* mock (per the ticket's literal wording), calls the corresponding assertion (Q1 directly; Q2/Q3 via `runSuite()` with an injected mock `judgeCallImpl` that never makes a real network call), asserts each result matches its expected pass/fail outcome, prints a summary report to stdout, and sets `process.exitCode` to `1` if any expectation was violated (a genuine harness-logic bug), else `0`. Illustrative skeleton for one check (the Builder fills in the remaining four Q1 checks + Q2/Q3 the same way):

```ts
import { assertQ1DroppedRate } from './assertions/q1.ts';
import { runSuite } from './run-suite.ts';
import type { judgeCall } from './judge.ts';

type Case = { label: string; expectPass: boolean; run: () => boolean | Promise<boolean> };

const cases: Case[] = [
  { label: 'Q1 droppedRate — passing (14.99%)', expectPass: true,
    run: () => assertQ1DroppedRate(14.99, 100).pass },
  { label: 'Q1 droppedRate — violating (15% exactly, strict <)', expectPass: false,
    run: () => assertQ1DroppedRate(15, 100).pass },
  // ... assertQ1Schema / assertQ1Coverage / assertQ1Questions / assertQ1NumberIntegrity, same shape ...
];

const mockJudgeCall: typeof judgeCall = async (prompt) =>
  /grounded fully/i.test(prompt)
    ? { verdict: 'pass', reasoning: 'mock: grounded' }
    : { verdict: 'fail', reasoning: 'mock: not grounded' };

async function main(): Promise<void> {
  let failures = 0;
  for (const c of cases) {
    const pass = await c.run();
    const ok = pass === c.expectPass;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.label} (got pass=${pass}, expected pass=${c.expectPass})`);
    if (!ok) failures += 1;
  }

  const q2q3 = await runSuite({
    op: 'cross',
    q2: [{ claim: 'grounded fully in project X', sourceContext: 'project X does exactly this' }],
    q3: [{ question: { projectId: 'p', question: 'why?', trap: 't' }, candidateContext: 'ctx' }],
    judgeCallImpl: mockJudgeCall,
    persist: false, // never touches the DB in self-check mode — see §2.8
  });
  console.log(JSON.stringify({ q2q3 }, null, 2));

  process.exitCode = failures > 0 ? 1 : 0;
}

main();
```

Note `runSuite`'s import above is a **type-only** re-reference pattern (`import type { judgeCall }` for the mock's type annotation) mixed with a real runtime import of `runSuite` — both fine under the rules in §2.1.

### 2.11 `scripts/eval.mjs`

Exact content given in §2.1 — no additional logic beyond the Node-version guard and the subprocess spawn.

### 2.12 `package.json` (1-line append)

Add `"eval": "node scripts/eval.mjs"` to the `scripts` object (any position — e.g. immediately after `"test"`). No other line changes; `engines.node` stays untouched (Risk #4).

### 2.13 `vitest.config.ts` (1-line addition to `test.include`)

```ts
    include: [
      'tests/**/*.test.ts',
      'lib/**/*.test.ts',
      'db/**/*.test.ts',
      '*.test.ts',
      'app/**/*.test.{ts,tsx}',
      'fixtures/**/*.test.ts',
      // `eval/**/*.test.ts` added by EVL-02 so eval/**'s new test files are
      // discovered — none of the prior globs reach eval/**. Same false-green
      // failure mode FND-02/05/06/08/09/EVL-01 each fixed for their own new
      // test locations.
      'eval/**/*.test.ts',
    ],
```

### 2.14 `tsconfig.json` (1-line addition to `compilerOptions`)

```json
    "allowImportingTsExtensions": true,
```

Placed alongside `"noEmit": true` (its required prerequisite, already present). Purely additive/permissive — allows but does not require `.ts`/`.tsx` extensions in import specifiers anywhere in the project; every existing extensionless import in the rest of the codebase remains valid. Verified via direct reproduction against this repo's real `tsc` binary (§0) that this exact addition is both necessary (without it, `TS5097` on every `eval/**` file using an explicit `.ts` extension) and sufficient (with it, the identical file type-checks clean).

## 3. Test plan

Maps to the ticket's acceptance checklist, in order:

1. **`assertQ1Schema` pass/fail** (`eval/assertions/q1.test.ts`): a Zod-valid mock `JdExtract` (or any convenient schema) parses → `pass: true`; a shape-violating mock (e.g. `requirements` as a string) → `pass: false`. Cover both `repairAttempted: true` and `false` on the failing case to confirm `detail` differs in wording (not required by acceptance, but cheap and directly exercises the ticket's "含 1 次 repair" framing).
2. **`assertQ1Coverage` — two unit tests** (`eval/assertions/q1.test.ts`): (a) a requirement ID present in neither `bindings` nor `gaps` → `pass: false`; (b) a requirement ID present in **both** `bindings` and `gaps` → `pass: false` (the ticket's own explicitly-named "恰好一次" double-check `ensureRequirementCoverage` alone does not perform). Plus one clean-passing case (every requirement covered exactly once) for contrast.
3. **`assertQ1Questions`**: `trap` empty string on any of the 5 → `pass: false`; all 5 non-empty → `pass: true`; (supplementary) `questions.length !== 5` → `pass: false`, even though Zod's `.length(5)` would normally prevent this — this function must not assume its input already passed Zod, per §2.3.
4. **`assertQ1NumberIntegrity`**: `violationCount > 0` (a numeric claim absent from both `resumeMd` and `libraryMetrics`) → `pass: false`; `violationCount === 0` → `pass: true`. Reuses `filterNumberIntegrity`'s own well-tested regex (no new number-matching logic invented here) — construct inputs the same way `lib/validation/number-integrity.test.ts` already does.
5. **`assertQ1DroppedRate` — boundary test**: `rate = 0.15` (`droppedCount: 15, totalCount: 100`, or any equivalent) → `pass: false`; `rate = 0.1499...` (`droppedCount: 14.99, totalCount: 100` or `droppedCount: 1499, totalCount: 10000`) → `pass: true`. Strict `<`, asserted at the exact boundary per the acceptance checklist's own wording. Also cover `totalCount: 0` → `rate: 0`, not `NaN`.
6. **`assertQ2Grounded`/`assertQ3Specific` + batch propagation** (`eval/assertions/q2.test.ts`, `eval/assertions/q3.test.ts`): inject a mock `judgeCallImpl` (a plain async function, no network) returning deterministic `pass`/`fail` per input; assert the single-item function forwards the mock's verdict directly (`pass` boolean matches `verdict === 'pass'`); assert the batch variant against a **4-item hand-built batch with 3 passing / 1 failing → `passRate: 0.75`** (the ticket's own literal example). No real API call anywhere in these test files — `judgeCall` itself is never invoked, only the injected mock.
7. **`writeEvalRun` inserts a row matching `EvalRun`** (`eval/report.test.ts`): PGlite-backed, following `lib/usage/record.test.ts`'s exact established pattern — `vi.resetModules()` + `vi.doMock('../db/index.ts', () => ({ db }))` (the **relative, extension-matching specifier**, so it resolves to the same absolute module `report.ts`'s own lazy `await import('../db/index.ts')` reaches — both are written at the same `eval/` directory depth, so the specifier strings are identical; verify this resolves correctly as an early, cheap check before writing the rest of this file's tests, per Risk #2) + dynamic `import('./report.ts')` (called only after the mock is registered) + apply the real committed migration via `drizzle-orm/pglite/migrator` (matching `db/migrate.test.ts` Tier 3 / `lib/usage/record.test.ts`). Assert the inserted row's `suite`/`op`/`passRate`/`details` round-trip and that `id`/`createdAt` are auto-populated.
8. **`judge.ts`'s own unit tests** (`eval/judge.test.ts`): inject a `fetchImpl` stub returning a canned Anthropic-shaped JSON response; assert `PASS`/`FAIL`-prefix parsing (including the unparseable-response fail-closed case, §2.4), assert a non-`ok` response **throws**, assert `recordUsage()` is only reached when `opts.userId` is supplied (mock `'../lib/usage/record.ts'` the same relative-specifier way as item 7, or simply omit `userId` in most cases and add one dedicated test that supplies it + mocks `recordUsage` to confirm the call happens with the right `op`/`tokensIn`/`tokensOut`). No real Anthropic call anywhere in this file.
9. **`eval/run-suite.test.ts`**: dispatches each `q1[]` `kind` to the right assertion (unit-level, mocking nothing — pure), and confirms `persist: false` (the default) never imports `'../db/index.ts'` at all (a spy/mock on `db.insert` that must never be called when `persist` is omitted or `false`).
10. **`pnpm eval` self-check exits 0** (`eval/self-check.test.ts`, subprocess integration test): `spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'eval.mjs')], { env: <process.env with ANTHROPIC_API_KEY and DATABASE_URL explicitly stripped>, cwd: repoRoot })`; assert `result.status === 0`, and assert stdout contains recognizable report content (e.g. matches `/OK\s+Q1/`). Explicitly stripping both env vars is what actually *proves* Deliverable 7's "no real API calls … no real stage output wired in" claim, rather than merely happening to pass because the sandbox's own env lacks them.
11. **`pnpm test` green**, including every new file above discovered via §2.13's glob addition — verify by checking the vitest output file list, not just the exit code (this repo's own established "don't let a glob miss create a false green" discipline, per every prior FND/EVL plan).
12. **`pnpm build` still succeeds** (not literally named in the ticket's acceptance checklist, but CI's own `.github/workflows/ci.yml` runs it immediately after `pnpm test` on every push/PR, so it is a de facto mergeability gate) — this is what actually exercises §2.14's `tsconfig.json` fix; run it once locally before considering the ticket done.
13. **File-scope conformance**: `git diff --stat f2fd57f..HEAD` (base commit per §0) should list exactly the files enumerated in §1's "In scope" bullets — 8 new `eval/**` source files + `eval/self-check.ts` + `scripts/eval.mjs` (9 new source files), 8 new `eval/**/*.test.ts` files, plus 1-line diffs to `package.json`, `vitest.config.ts`, `tsconfig.json`. Anything else (in particular any edit inside `fixtures/**`, `lib/validation/**`, `lib/usage/record.ts`, `db/**`, or any `app/api/**` route) is a File-scope violation.

All of the above are reproducible fully offline — no live Neon, no real Anthropic spend, matching the ticket's own Test-plan framing exactly.

## 4. Risks & edge cases

- **Risk #1 — judge-call cost is mispriced when `recordUsage()` is actually exercised (Sonnet rate, not Haiku rate).** `lib/usage/record.ts`'s `RECORD_USAGE_PRICING_MODEL` is hardcoded to `'sonnet5'` ($2 in/$10 out per MTok) with no `model` parameter; `JUDGE_MODEL` is `claude-haiku-4-5` ($1/$5 per MTok, per PRD §9) — roughly **2× cost overstatement** for every judge call that reaches `recordUsage()`. This is not introduced by this ticket — it is a pre-existing, explicitly-documented gap from `docs/plans/FND-10.md`'s own Open Question #2, and `lib/usage/record.ts` is out of EVL-02's file-scope (cannot be edited here). This plan's mitigation: (a) neither the self-check path nor any of this ticket's own unit tests ever reach the real `recordUsage()` call (§2.1, §2.4 — `userId` is always omitted in those paths), so **this ticket's own acceptance is unaffected**; (b) the mispricing only becomes real once a future ticket (FIT-02/TLR-01, wiring real judge calls with a real `userId`) exercises it — flagged as Open Question #1 for that ticket's own Architect pass to resolve or escalate, not silently inherited without comment.
- **Risk #2 — `vi.doMock` specifier-matching for a lazily/dynamically-imported module, using a relative (not aliased) specifier, is a pattern with no exact precedent in this repo yet** (`record.test.ts`/`quota.test.ts` mock a *statically*-imported `@/db/index`; this ticket's `report.ts`/`judge.ts` dynamically import `'../db/index.ts'`/`'../lib/usage/record.ts'`). This plan's expectation (§0, §3 item 7) is that Vitest/Vite's mock resolution operates on the resolved absolute module identity, so a mock registered with the identical relative specifier string, from a file at the identical directory depth, will match correctly regardless of the alias-vs-relative distinction. **Verify this early** (first thing written in `eval/report.test.ts`, before investing in the rest of that file) — if it does not match as expected, the fallback is to mock using whatever specifier form Vitest actually keys on (try `'@/db/index'` as a second candidate; both should resolve to the same file per `vitest.config.ts`'s own `resolve.alias`), and note the finding as a Deviation.
- **Risk #3 — `assertQ2GroundedBatch`/`assertQ3SpecificBatch` run sequentially, not in parallel (`Promise.all`).** Deliberate: (a) real (non-mocked) usage would otherwise fan out N concurrent Anthropic API calls per batch with no rate-limit/concurrency control, and this ticket has no budget-management story beyond `checkGlobalBreaker()` (FND-06, not wired here — Q1–Q3 harness runs are outside the per-user quota system entirely); (b) sequential execution keeps failure attribution unambiguous (`judgeCall`'s "throw loud" contract, §2.4, is easier to reason about one-at-a-time). This trades latency for safety/simplicity — a real future batch of 10+ JDs × judge calls could be slow; flagged as an accepted, deliberate v1 choice, not an oversight, and cheap to revisit (swap the `for` loop for a bounded-concurrency helper) once real latency data exists.
- **Risk #4 — `package.json`'s `"engines": {"node": ">=20"}` understates this ticket's real floor (`>=22.6`, for `--experimental-strip-types`).** Not fixed here (File-scope's literal "append `\"eval\"` script only" restriction). Mitigated defensively inside `scripts/eval.mjs` itself (§2.1's version guard, printing a clear error rather than a cryptic Node CLI failure). CI (`node-version: '22'`, resolving to latest 22.x) and this repo's actual dev environment (Node 22.11) are both unaffected in practice — the only realistic exposure is a contributor on Node 20/21 running `pnpm eval` locally, who now gets an actionable error message instead of a stack trace. Flagged as Open Question #2 for Horace/Reviewer: worth a dedicated follow-up ticket bumping `engines.node`, or accept the gap.
- **Concurrency**: no shared mutable state across this ticket's own functions — every assertion is pure or operates on caller-supplied data with no module-level mutable state. The one genuine concurrency-adjacent concern is Risk #3 (batch fan-out), addressed above. `writeEvalRun()`'s DB insert has no read-then-write race (it is a pure append, matching `usage_events`'s own append-only design) — concurrent `pnpm eval` runs (e.g. two CI jobs) would simply produce two independent `eval_runs` rows, which is the correct behavior for an append-only report log.
- **Security-sensitive path — `ANTHROPIC_API_KEY` handling**: `judge.ts` reads `process.env.ANTHROPIC_API_KEY` directly (server-only context — this file is never imported by any client-bundled code, since nothing in `app/**` imports from `eval/**` yet, and even once a future ticket does, that import would be from a Next.js API route, which is server-only by construction). No key material is ever logged — `judgeCall`'s error paths (§2.4) surface HTTP status/response text, never the request headers. The self-check path (§2.10) never sends a real request at all, so it is safe to run in any environment, including one with no `ANTHROPIC_API_KEY` configured at all (verified explicitly by test item 10's env-stripping).
- **`eval/self-check.ts`'s own pass/fail cases risk being "tuned" to whatever the Builder happens to write**, since the same person authors both the mock data and the expectations (same fragility class the EVL-01 plan flagged for its own fixture-authoring). Mitigated by the ticket's own hard-pinned numeric boundaries (e.g. the `0.15`/`0.1499` dropped-rate boundary, the `3/4 → 0.75` batch example) being used verbatim as the mock inputs in both `eval/assertions/q1.test.ts` (§3 item 5) and `eval/self-check.ts` (§2.10) — these are the ticket's own literal numbers, not Builder-invented ones.
- **Windows/cross-platform**: `scripts/eval.mjs`'s `spawnSync(process.execPath, [...])` (§2.1) uses `process.execPath` (the actual running Node binary's absolute path), not a bare `'node'` string relying on `PATH` lookup with shell-specific quoting — this is the standard cross-platform-safe pattern and was exercised directly on this Windows dev environment during planning (§0's empirical verification). `path.join(repoRoot, 'eval', 'self-check.ts')` normalizes correctly on `win32` the same way EVL-01's `fixtures/manifest.json` path-joining does.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Risk #1's judge-call mispricing (Sonnet rate applied to Haiku-priced calls) becomes real the moment a future ticket (FIT-02/TLR-01) wires a real `userId` into `judgeCall()`'s `recordUsage()` path. This plan does not fix it (out of file-scope) and confirms it is inert for EVL-02's own acceptance. | Whichever of FIT-02/TLR-01 first wires real judge calls, at that ticket's own Architect pass — escalate to Horace if `lib/usage/record.ts` needs a `model` parameter added (a signature change, per `docs/plans/FND-10.md`'s own Open Question #2, which already parked this exact decision). |
| 2 | Whether `package.json`'s `engines.node` should be bumped from `>=20` to `>=22.6` (Risk #4) — this ticket does not do it (file-scope restriction), and mitigates with a runtime guard instead. | Horace / Reviewer — low urgency (CI and the actual dev environment are both already ≥22.11), but worth an explicit yes/no rather than leaving the gap unacknowledged. |
| 3 | This plan's `runSuite()` shape (§2.8) is a genuine guess at what `04-fit`/`05-tailor`/`06-prep` will need — none of those tickets exist yet. The ticket's own Feedback obligation #1 already anticipates this may need extending. | FIT-01/FIT-02/TLR-01/PRP-02's own Builders, at build time — extend `eval/run-suite.ts` directly per that obligation's own procedure (version +0.1, changelog line in `02-evaluation/README.md`) rather than working around a bad fit elsewhere. |
| 4 | Risk #2's `vi.doMock` specifier-matching assumption for a dynamically-imported, relatively-specified module is unverified against this repo's actual Vitest/Vite version behavior (no prior ticket exercised this exact combination). | Builder — verify empirically as the very first thing written in `eval/report.test.ts` (§3 item 7, §4 Risk #2); if it doesn't hold, note the actual working form as a Deviation, it does not change this plan's overall design. |

## 6. ADR-candidate flag

**Not proposing a new ADR.** The ticket states up front: "No ADR — the decision is already made in PRD §6 … this is build ticket 2 of 2 against the `02-evaluation` module." This plan's own genuinely load-bearing addition — the plain-Node TypeScript execution design (§2.1: relative+`.ts`-extension imports, lazy dynamic imports around every `@/db/index`-touching call, `allowImportingTsExtensions`, the launcher/entry split) — is architecturally real but entirely **local and reversible**: it affects only `eval/**`'s own internal import style and one additive `tsconfig.json` flag, has exactly one consumer (`scripts/eval.mjs`'s self-check path), and does not constrain any other module's design (FIT-01/TLR-01/etc. will consume `eval/**`'s exported functions through the normal `@/*`-alias/Vitest/Next.js path, never through plain-Node execution). It is closer to an implementation-detail engineering constraint (like FND-05's neon-http-vs-neon-serverless driver choice) than a cross-cutting architectural lock-in (like FND-03's `Ledger.bindings`/`gaps` disjoint-union shape). No ADR is proposed by this plan — flagged in §2.1 and Risk-adjacent open questions instead, per the instruction to surface hard-to-reverse choices without burying them, not to over-formalize a reversible one.
