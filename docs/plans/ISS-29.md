# Implementation plan — ISS-29: Fix account-delete test timeout under full suite (main is red)

Ticket: [docs/prd/99-nightly/tickets/ISS-29-account-delete-test-timeout-under-full-suite.md](../prd/99-nightly/tickets/ISS-29-account-delete-test-timeout-under-full-suite.md)
Sub-PRD: none — `99-nightly` is the pipeline's maintenance lane for tickets synthesized from tracker issues; it has no product README, and `docs/PRD.md` is not implicated (test-infrastructure fix, no product-behavior change).
ADRs: none exist (`docs/adr/` contains only `.gitkeep`), and **this change is not an ADR candidate** — a file-scoped test-timeout override is trivially reversible and carries no architectural weight.
Base commit: `1b520a7` on `main` (working tree clean at planning time). Branch per repo convention: `ticket/ISS-29`.

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone. **Always invoke pnpm as `corepack pnpm ...`** — bare `pnpm` is not on `PATH` on this machine.

## 0. Repo-state check performed for this plan (verified 2026-07-22 by direct inspection — confirm unchanged, do not re-derive)

- `vitest.config.ts` (45 lines, last touched by EVL-02 commit `6196437`): sets only `plugins`, `test.environment`, `test.include` (7 globs), and `resolve.alias`. **No `testTimeout`, `pool`, `poolOptions`, `maxConcurrency`, `sequence`, or `fileParallelism` key exists there or anywhere else in repo source** (grep for `testTimeout|poolOptions|maxConcurrency|fileParallelism|setConfig` matches only the ISS-29 ticket's own prose). Every test therefore runs under Vitest's built-in **5000ms default** today.
- Installed Vitest is **3.2.7** (`node -e "console.log(require('vitest/package.json').version)"`). All three candidate mechanisms exist in this version: `it(name, fn, timeout)`, `it(name, { timeout }, fn)`, and `vi.setConfig({ testTimeout })` / `vi.resetConfig()`. Vitest 3 defaults: pool `'forks'`, `isolate: true`, max workers = `os.availableParallelism()` = **20 on this machine** — so up to 20 test files boot concurrently, each in its own forked process.
- `app/api/account/delete/route.test.ts` (382 lines, sole author PLT-01 commit `e89c48b`, untouched since): all 8 tests call `createTestDb()` (line 28) inside their `it()` bodies — `new PGlite()` (Postgres compiled to WASM) + `drizzle(...)` + a real `migrate(db, { migrationsFolder: './db/migrations' })` over the full 3-file migration chain (`ls db/migrations/*.sql | wc -l` → 3), per test. The only hooks in the file are the mock-resetting `afterEach` (lines 218–221) — **no hook does DB work, so `hookTimeout` is irrelevant; only `testTimeout` matters.** Vitest imports on line 5: `import { afterEach, describe, expect, it, vi } from 'vitest';`. The single `describe` spans lines 223–382; the reported failing test is lines 224–248 with the nine-key `userRowCounts` equality block at lines 237–247.
- **Planning-time baseline (`corepack pnpm test` at `1b520a7`): the suite is currently GREEN on this machine** — `37 passed (37)` files / `316 passed (316)` tests, 18.25s wall. Per-test timings for the account-delete file under that full-suite load: file total **16325ms**; first test (the one issue #29 reports timing out) **4558ms — a 442ms margin against the 5000ms ceiling**; remaining seven tests 1292–2457ms. Isolated (per ticket, verified at triage): first test 1555ms, file 10858ms. Issue #29's two red runs had total wall ~76s (≈4.2× today's 18s), i.e. contention heavy enough to push 4558ms past 5000ms. **Consequence for the Builder: this is a ceiling-riding flake, red or green depending on ambient machine load. A green pre-fix baseline does NOT falsify the diagnosis — the sub-500ms margin is itself the evidence. Do not loop trying to force a red run.**
- Why specifically the *first* test in the file fails: under pool `'forks'` + `isolate: true`, each file's worker process pays the PGlite WASM compile once, on its first `new PGlite()`; subsequent tests in the file reuse the compiled module (module-level cache). That matches the measured 4558ms (first) vs ≤2457ms (siblings) and corroborates load-artifact-not-hang — the file passes 8/8 in isolation.
- Latent same-class risk in other PGlite files, measured this session under full-suite load: `lib/config/quota.test.ts`'s `checkGlobalBreaker` tests ran 1266–2414ms each. At issue-time (~4×) contention the 2414ms case projects to ~10s — same flake class, **not currently failing, out of scope per ticket Non-goals** (see §5 Open question 1).
- Serial-safety, re-verified at `1b520a7`: `ticket/PLT-02` exists unmerged; `.github/scripts/backup.mjs`, `.github/workflows/backup.yml`, `tests/backup.test.ts` are absent from `main`. This plan's design touches **only** `app/api/account/delete/route.test.ts` — zero overlap with PLT-02 or any other in-flight scope, and it leaves `vitest.config.ts` entirely untouched (removing even the shared-file surface the ticket had provisionally allowed).
- CI (`.github/workflows/ci.yml`) runs `pnpm test` then `pnpm build` on `ubuntu-latest` (2–4 cores → fewer parallel workers, but each slower). The fix below applies identically there; CI has no separate timeout configuration.

## 1. Scope

**In scope** — one file, one mechanism:

- `app/api/account/delete/route.test.ts`: add a file-scoped `testTimeout` raise via a `beforeAll`/`afterAll` + `vi.setConfig`/`vi.resetConfig` pair (exactly the shape acceptance item 3(b) blesses), covering all 8 PGlite-backed tests in this file. Plus the two hook names added to the existing vitest import. Nothing else in the file changes — **zero edits inside any `it()` body**.

**Explicitly out of scope** (per ticket Non-goals — do not do these even opportunistically):

- No change to `vitest.config.ts`. The ticket allows touching it; this plan deliberately does not (§2.2 has the reasoning). If the Builder finds themselves editing it, they have left this plan — stop and record why.
- No change to `app/api/account/delete/route.ts` (the handler). If investigation reveals the route itself hangs, that falsifies the ticket's diagnosis → stop and escalate per Feedback obligation 1.
- No edits to the other PGlite-heavy files (`db/schema-auth.test.ts`, `db/migrate.test.ts`, `lib/config/quota.test.ts`, `eval/report.test.ts`, `lib/usage/record.test.ts`) — latent risk noted in §0 and §5, not this ticket's deliverable.
- No blanket global `testTimeout`, no `.skip`/`.todo`/`.only` anywhere, no assertion changes, no touch to PLT-02's file scope (`.github/scripts/backup.mjs`, `.github/workflows/backup.yml`, `tests/backup.test.ts`).

## 2. Change list

### 2.1 The edit — `app/api/account/delete/route.test.ts` (the only file in the diff)

Two hunks, line numbers as of base commit `1b520a7`:

**Hunk 1 — line 5**, extend the vitest import (member order stays alphabetical, matching the existing line's style):

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
```

**Hunk 2 — insert between line 221 (`});` closing the existing `afterEach`) and line 223 (`describe(`)**, separated by blank lines, at file top level so it covers every test in the file:

```ts
// ISS-29: every test in this file boots a fresh PGlite (Postgres-in-WASM) and runs
// the real db/migrations chain inside it(); under full-suite load (37 files fanned
// across one forked worker per core) the file's first test also pays the worker's
// one-time WASM compile and has been measured at 4558ms against Vitest's 5000ms
// default — and timed out outright in issue #29's runs. File-scoped raise only:
// vi.resetConfig() below restores the default, so no other file's 5000ms ceiling moves.
beforeAll(() => {
  vi.setConfig({ testTimeout: 30_000 });
});

afterAll(() => {
  vi.resetConfig();
});
```

Notes for the Builder:

- The comment above **is Deliverable 1's required code comment** (cites ISS-29, explains why this file needs it). Keep its substance; wording may be tightened but the ticket id and the PGlite-boot-plus-migration rationale must survive.
- `30_000` uses the numeric-separator style already present in this file (`const T = 1_700_000_000_000`, line 92).
- Timeout resolution order in Vitest: a per-test explicit timeout > runtime config (`vi.setConfig`) > file/global config > 5000ms default. No test in this file passes an explicit timeout, so the `beforeAll` (which runs before any test starts) governs all 8.
- `vi.resetConfig()` restores every value changed via `vi.setConfig` — safe here because this pair only sets `testTimeout`, and no other file in the repo calls `vi.setConfig` at all (§0 grep). Under the default `isolate: true` the runtime config is per-file state anyway; the reset pair is belt-and-braces against a future `isolate: false` and is the exact shape acceptance 3(b) names.

### 2.2 Mechanism decision — alternatives considered and rejected (Builder: do not switch without recording a deviation)

1. **Third-argument per-test timeout on only the failing test** (`it('[machine] deletes EVERY...', fn, 30_000)`) — allowed by the ticket but rejected: §0's measurements show the *second* test at 2457ms under today's mild load, projecting past 5000ms at issue-time (~4×) contention. Patching one test schedules the next flake; patching all 8 individually is 8 magic numbers doing the job of 1. The file-scoped pair has the identical blast radius (this one file) and covers the real risk class — every test here boots PGlite + migrates.
2. **Global `test.testTimeout` in `vitest.config.ts`** — explicitly banned (ticket Non-goal 3, acceptance item 3): it would mask genuine hangs in the other 36 files.
3. **Per-glob timeout via `projects` in `vitest.config.ts`** — mechanically possible in Vitest 3, but it forces restructuring the whole flat config (the `include` globs would have to be split across project entries) and changes the reporter's output grouping that acceptance items lean on (`37 passed (37)`). Disproportionate for a size-S ticket.
4. **Concurrency constraints (`maxWorkers`, `fileParallelism`, `poolOptions.forks.maxForks`)** — global blast radius (slows every suite run for everyone, alters CI behavior on 2–4-core runners) and is precisely the shape of the *deferred* repo-wide PGlite concurrency policy that Feedback obligation 2 routes to a follow-up issue, not this ticket.

### 2.3 Timeout value: `30_000`, with a mechanical escalation rule

Derivation from measured data: worst observed contention inflated wall time ~4.2× (18.25s → 76s). First test at 4558ms today → projects to ~19s at that contention; 30s covers it with ~1.6× margin while still bounding a genuine future hang in this file to 30s instead of 5s (all other files keep 5000ms — that bound is the entire point of the scoped design).

**Decision rule (no re-planning needed):** after the two consecutive acceptance runs (§3 step 3), read the reporter's per-test durations for this file. If the slowest test in **either** run exceeded **15_000ms** (i.e., margin under 2×), change the value to `60_000` in the same hunk and redo both runs. If it flakes even at `60_000`, stop — that is Feedback obligation 2 territory (record the finding on the ticket, version +0.1 + changelog line, propose the repo-wide PGlite concurrency-policy follow-up issue; do **not** start editing other files or `vitest.config.ts`).

## 3. Test plan (each step mapped to the ticket's acceptance checklist)

All commands from the repo root; `corepack pnpm ...` always.

1. **Baseline** (ticket Test-plan 1, amended by §0's finding): run `corepack pnpm test` once at the base commit. Record the outcome **and** the per-test durations printed for `app/api/account/delete/route.test.ts`. Either result is a valid baseline: a timeout on the first test reproduces issue #29 exactly; a pass with the first test near the 5000ms ceiling (planning-time measurement: 4558ms) corroborates the same diagnosis. Run once — do not loop hunting for a red.
2. Apply §2.1's edit. Nothing else.
3. **Acceptance 1**: `corepack pnpm test` twice back-to-back. Both runs must exit 0 with `37 passed (37)` files / `316 passed (316)` tests. Record both runs' counts and, for the escalation rule in §2.3, the slowest account-delete test duration in each run.
4. **Acceptance 4**: `corepack pnpm exec vitest run app/api/account/delete/route.test.ts` — still 8/8 green in isolation.
5. **Acceptance 2 + 5** (diff hygiene): `git diff` must show exactly the two hunks of §2.1 in exactly one file. Mechanical checks: no `.skip(`, `.todo(`, or `.only(` anywhere in the diff; the `'[machine] deletes EVERY per-user row across all tables (硬删该用户全部数据)'` test body is byte-identical — `expect(res.status).toBe(200)`, the `{ deleted: true }` check, and the nine-key all-zero `toEqual` block (pre-edit lines 237–247: `users`, `libraries`, `resumes`, `jobs`, `tailoredResumes`, `briefs`, `usageEvents`, `accounts`, `sessions`) all untouched and un-skipped.
6. **Acceptance 3**: `git diff --name-only` must NOT list `vitest.config.ts` (this plan's design never touches it — the effective default `testTimeout` for every other file remains Vitest's built-in 5000ms), and the raise present is the acceptance-3(b)-blessed `vi.setConfig`/`vi.resetConfig` pair scoped to this one file.
7. Lint: `corepack pnpm lint` clean (the file is edited, so run it). `corepack pnpm build` is not required for a test-only edit — CI runs it post-push regardless; no type risk is expected (`vi.setConfig`/`vi.resetConfig` are typed vitest APIs).

## 4. Risks & edge cases (Reviewer: these are the checks that matter)

- **Security-sensitive file, zero-assertion-drift requirement.** This test file *is* the verification of the account-deletion trust boundary (cross-user isolation, session-only victim selection, transactional rollback, 401 short-circuit). The fix must be provably assertion-neutral: a raised timeout ceiling cannot convert a failing assertion into a passing one — only assertion edits could, and the diff must contain none (§3 step 5 is the mechanical gate). Reviewer: verify the diff is exactly two hunks, both outside every `it()` body.
- **Masking a genuine hang** — bounded by design: a real hang in this file now surfaces at 30s (or 60s post-escalation) instead of 5s, in this file only; all 36 other files keep the 5000ms fail-fast ceiling. The trade is explicit and the comment at the fix site documents it.
- **`vi.resetConfig()` is a full reset** of everything set via `vi.setConfig`, not a keyed revert. Safe today (this pair is the repo's only `setConfig` caller, and runtime config is per-file under the default `isolate: true`). If a future ticket adds another `vi.setConfig` call *in this same file*, the `afterAll` will reset that too — acceptable, and out of this ticket's horizon.
- **Residual flake above the new ceiling** — the machine can always be busier (the nightly sweep itself runs `claude -p` workloads concurrently with tests). §2.3's escalation rule (30s → 60s → stop and file the follow-up per Feedback obligation 2) is the containment; widening file scope is not.
- **Concurrency** — no product concurrency path is touched; the only concurrency in play is Vitest's worker scheduling (pool `'forks'`, ~20 workers here, 2–4 in CI). Each test creates its own private PGlite instance, so there is no cross-test DB contention — only CPU contention, which is exactly what the timeout headroom absorbs.
- **Diagnosis falsification trigger** (Feedback obligation 1): if during any §3 run the account-delete tests fail on an *assertion* (not a timeout), or the isolation run (§3 step 4) fails, the load-artifact diagnosis is wrong — stop, do not touch `app/api/account/delete/route.ts`, escalate.

## 5. Open questions

1. **Should the latent-risk follow-up issue be filed now or left to the nightly sweep?** §0 measured `lib/config/quota.test.ts` at up to 2414ms/test under mild load — the same flake class this ticket fixes for one file, projecting past 5000ms under issue-time contention; `db/migrate.test.ts`, `db/schema-auth.test.ts`, `eval/report.test.ts`, `lib/usage/record.test.ts` share the pattern. The ticket says "flag as a candidate follow-up issue," not "file it." **Decider: Horace** (supervised mode — issue creation outside a signed-off milestone is a human call; alternatively the nightly sweep will surface it if/when one of those files actually flakes). The Builder's only obligation is to repeat this flag in the build report.
2. None other. The timeout value and its escalation rule (§2.3) are decided in this plan; the Builder executes the rule mechanically and records which value landed.
