---
id: ISS-29
title: Fix account-delete test timeout under full suite (main is red)
module: 99-nightly
lane: 99-nightly
size: S
agent: builder
status: draft
date: 2026-07-22
blocked_by: []
blocks: []
---

# ISS-29 — Fix account-delete test timeout under full suite (main is red)

Sourced from tracker issue #29 ("account-delete test times out at 5000ms in the full suite (passes in isolation) — main is red"), triaged via the nightly sweep. Not part of any feature PRD module — `99-nightly` is the pipeline's own bucket for maintenance/bug tickets synthesized from tracker issues outside an existing sub-PRD's scope, per `.claude/agents/triage.md` ("write a ticket file at `docs/prd/99-nightly/tickets/ISS-<number>-<slug>.md`"). No parent sub-PRD README exists for this module (it is not a product feature area); the master spec `docs/PRD.md` is not implicated — this is a test-infrastructure fix, not a product-behavior change.
**Why `builder`:** a narrowly-scoped test-infrastructure fix (a timeout/concurrency setting) with no product-logic change and a fully mechanical acceptance check — every fact needed to execute is inlined below, no open design.

## Background + basis

Issue #29 body (verbatim), reproduced and independently sanity-checked by the triage stage before writing this ticket:

> `main` is red. One test fails, reproducibly, on every full-suite run:
> ```
> FAIL app/api/account/delete/route.test.ts > POST /api/account/delete
>      > [machine] deletes EVERY per-user row across all tables (硬删该用户全部数据)
> Error: Test timed out in 5000ms.
>
> Test Files  1 failed | 36 passed (37)
>      Tests  1 failed | 315 passed (316)
> ```
> It is a **timeout**, not an assertion failure.

Reproduction commands and their observed output (verified this session):

- `corepack pnpm test` on `main` (a5668d5 or later) — fails with exactly the one timeout above. Reproduced on 2 consecutive runs (not a one-off). **Note: `pnpm` is not on `PATH` on the machine this pipeline runs on — always invoke it via `corepack pnpm ...`, never bare `pnpm`.**
- `corepack pnpm exec vitest run app/api/account/delete/route.test.ts` — all 8 tests in the file pass; the failing-under-load case takes 1555ms in isolation, the whole file 10858ms.

Diagnosis (confirmed by reading the config, not just the issue text):

- `vitest.config.ts` sets no `test.testTimeout` override at all, so every test — including PGlite-backed ones — runs under Vitest's built-in **default of 5000ms**. Confirmed by reading the file directly: it only sets `environment`, `include` globs, `plugins`, and `resolve.alias`; no `testTimeout`, no `pool`/`poolOptions`, no `maxConcurrency`/`sequence.concurrent` keys exist anywhere in the file or repo (`grep -rn "testTimeout|poolOptions|maxWorkers|fileParallelism"` across the repo returns nothing).
- `app/api/account/delete/route.test.ts` (382 lines) is PGlite-backed: every test calls `createTestDb()` (line 28), which does `new PGlite()` + `drizzle(...)` + a real `migrate(db, { migrationsFolder: './db/migrations' })` — i.e. it boots an in-memory Postgres-compiled-to-WASM instance and runs the full migration chain, per test, inside `it()`. This is genuinely CPU-heavier than a typical unit test and has near-zero headroom against a 5s ceiling once it must share the machine with dozens of other files running in parallel Vitest workers.
- The trigger was EVL-02 (#12, merged as `a5668d5`/`6196437`/`a456bb0`): confirmed by `git show --stat 6196437` and `a456bb0` — EVL-02 added 9 new `eval/**/*.test.ts` files (`q1.test.ts`, `q2.test.ts`, `q3.test.ts`, `fixtures.test.ts`, `judge.test.ts`, `report.test.ts`, `run-suite.test.ts`, `self-check.test.ts`, `index.test.ts`) plus the `eval/**/*.test.ts` glob to `vitest.config.ts`'s `include` array. Issue #29 reports this took the suite from 28 files/274 tests to 37 files/316 tests, and total wall time from ~18s typical to 76s in the failing runs. Nothing in EVL-02 touches `app/api/account/delete/**` — it only raised concurrent load across the whole run.
- The account-delete file itself passed at PLT-01 delivery time (see `docs/prd/07-platform-launch/tickets/PLT-01-privacy-tos-account-delete.md`'s Changelog: "Full suite green (269 tests, 27 files)"), i.e. before EVL-02 grew the suite. This is consistent with a load/concurrency regression, not a regression in the account-delete code itself.
- Conclusion: **test-infrastructure problem (timeout budget vs. concurrent load), not a product-logic bug.** The account-delete behavior itself is verified green in isolation (8/8, 10858ms total).

Standing constraint this ticket must respect: PLT-02 (#26, tracker-CLEAR, waiting on branch `ticket/PLT-02`) must not merge onto a red `main`, and this ticket must not create any file-scope conflict with it. Verified: on `main` today, `.github/scripts/backup.mjs`, `.github/workflows/backup.yml`, and `tests/backup.test.ts` do not exist yet (they live only on the unmerged `ticket/PLT-02` branch) — this ticket's file-scope below does not go near any of those paths or names.

## Goal

`corepack pnpm test` is green on `main`, twice in a row, by giving the PGlite-backed `app/api/account/delete/route.test.ts` tests enough time/CPU headroom to pass reliably under full-suite concurrency — via a **scoped** mechanism (per-test or per-file timeout override, and/or a concurrency constraint), not a blanket increase to the global default `testTimeout` that would silently raise the ceiling for every other test file (including ones where a real hang should still fail fast).

## Non-goals

- No change to `app/api/account/delete/route.ts` (the actual deletion handler) — the reported symptom is a timeout, not an assertion failure; the route's behavior is already verified correct in isolation (8/8 pass). If investigation reveals the route itself needs a code change, stop and escalate (see Feedback obligation) rather than silently expanding this ticket's scope.
- No edits to `db/schema-auth.test.ts`, `db/migrate.test.ts`, `lib/config/quota.test.ts` — other PGlite-heavy files confirmed at the same latent risk (each does `new PGlite()` + a real `migrate(...)` call: `db/migrate.test.ts` lines 121/278, `db/schema-auth.test.ts` lines 173/221, `lib/config/quota.test.ts` line 28). Also PGlite-backed, same latent risk, also out of scope for this ticket: `eval/report.test.ts` (line 19) and `lib/usage/record.test.ts` (line 20). None of these are reported as currently failing — do not touch them. If the chosen fix is a global `vitest.config.ts` setting that happens to also give these files more headroom, that is an acceptable side effect, not a required deliverable; if the fix instead requires editing these files individually, that is out of this ticket's scope — flag it as a candidate follow-up issue instead of expanding this ticket.
- No blanket global `testTimeout` bump (e.g. raising a single repo-wide value from 5000ms to some larger number with no other change) — issue #29's acceptance explicitly calls this out as the wrong shape of fix: it would mask a future genuine hang in an unrelated fast test instead of giving headroom specifically to the PGlite-backed, migration-running tests that need it.
- No touch to any file under `.github/scripts/backup.mjs`, `.github/workflows/backup.yml`, `tests/backup.test.ts` — these are PLT-02's (#26) in-flight file-scope on branch `ticket/PLT-02`; this ticket must not overlap them (Background).

## File-scope (write-owns)

- `vitest.config.ts` — may add a scoped timeout/concurrency setting (e.g. a per-project/per-glob `testTimeout` override, or a `poolOptions`/`sequence`/`maxConcurrency` constraint) targeted at the PGlite-backed test files, without changing the effective timeout for the rest of the suite.
- `app/api/account/delete/route.test.ts` — may add a per-test timeout (Vitest's `it(name, fn, timeout)` third-argument form, or an equivalent file-scoped override such as `vi.setConfig({ testTimeout })` in a `beforeAll` paired with `vi.resetConfig()` in an `afterAll` so the change does not leak to other test files) to the specific slow case(s) — this is the file where the reported failing test lives, and is the most surgical place to fix it if a global config change is not needed.
- Does not touch: `app/api/account/delete/route.ts` (Non-goals), `db/schema-auth.test.ts`, `db/migrate.test.ts`, `lib/config/quota.test.ts`, `eval/**`, `lib/usage/record.test.ts` (Non-goals — other modules' owned test files, not currently failing), `.github/scripts/backup.mjs`, `.github/workflows/backup.yml`, `tests/backup.test.ts` (owned by in-flight PLT-02 on branch `ticket/PLT-02` — confirmed absent from `main` today, so there is nothing to serially conflict with, but do not create them here either).
- Serial-safety: `vitest.config.ts` was last touched by EVL-02 (merged, `a5668d5`) purely to append the `eval/**/*.test.ts` include glob (see Background) — no other ticket is currently in flight against it. `app/api/account/delete/route.test.ts` was created by PLT-01 (merged) and has had no further in-flight changes. No other tracked ticket currently claims either file.

## Deliverables

1. A scoped fix — implemented in `vitest.config.ts` and/or `app/api/account/delete/route.test.ts` (Builder's choice of exact mechanism, per File-scope) — that gives the PGlite-backed test(s) in `app/api/account/delete/route.test.ts` enough wall-clock headroom to pass reliably when the full 37-file/316-test suite runs concurrently, without raising the default 5000ms ceiling for the rest of the suite. Include a one-line code comment at the fix site explaining why this file/test needs it (PGlite boot + real migration run, cite this ticket id `ISS-29`) so a future maintainer does not mistake it for an arbitrary magic number.
2. No change to the assertion contents of any test in `app/api/account/delete/route.test.ts` — specifically the `'[machine] deletes EVERY per-user row across all tables (硬删该用户全部数据)'` test (current file lines 224-248) must keep asserting `res.status` is 200, the JSON body is `{ deleted: true }`, and every one of the nine `userRowCounts(...)` fields (`users`, `libraries`, `resumes`, `jobs`, `tailoredResumes`, `briefs`, `usageEvents`, `accounts`, `sessions`) is `0` — unchanged in substance from what exists today.

## Acceptance checklist (classified)

- [ ] `[machine]` `corepack pnpm test` exits 0 on two consecutive runs (run it twice back-to-back after the fix; both runs must report `37 passed (37)` files / no failures — record both runs' pass counts).
- [ ] `[machine]` The `'[machine] deletes EVERY per-user row across all tables (硬删该用户全部数据)'` test still contains its full assertion body — `expect(res.status).toBe(200)`, the `{ deleted: true }` JSON check, and the nine-key all-zero `userRowCounts` equality check are all still present and un-skipped (grep the file for `.skip(`, `.todo(`, or `.only(` on this `it(` block — none must be present; this directly turns issue #29's "the fix does not simply delete or skip the assertion" constraint into a mechanical check).
- [ ] `[machine]` The fix is scoped, not a blanket global bump: after the fix, either (a) `vitest.config.ts`'s effective default `testTimeout` for files OTHER than the PGlite-backed ones is unchanged from Vitest's built-in 5000ms default (i.e., no top-level `test.testTimeout` key was simply raised repo-wide), or (b) the timeout increase is expressed as a per-test/per-file override (third-argument `it(..., fn, timeout)`, or a `vi.setConfig`/`vi.resetConfig` pair scoped to `app/api/account/delete/route.test.ts`) that does not touch any other test file's effective timeout.
- [ ] `[machine]` Isolation run `corepack pnpm exec vitest run app/api/account/delete/route.test.ts` still passes 8/8 after the fix.
- [ ] `[machine]` No other test file's pass/fail status changes: the full-suite run still reports 37 files / 316 tests, all passing, with no new `.skip`/`.todo` introduced anywhere in the diff.

No `[human]` criteria — this is a self-contained test-infrastructure fix with a fully mechanical acceptance check.

## Test plan

1. Run `corepack pnpm test` on the pre-fix tree once to reconfirm the exact reported failure (`app/api/account/delete/route.test.ts > POST /api/account/delete > [machine] deletes EVERY per-user row across all tables` timing out at 5000ms) before changing anything — this is the regression baseline.
2. Apply the scoped fix (Deliverable 1).
3. Run `corepack pnpm test` twice consecutively; both runs must be green (Acceptance item 1).
4. Run `corepack pnpm exec vitest run app/api/account/delete/route.test.ts` in isolation; must still be 8/8 green (Acceptance item 4) — this is the existing regression pattern used throughout this repo's other tickets (e.g. PLT-01's own test file), reused here rather than invented fresh.
5. `git diff` the touched test file and confirm no `.skip(`/`.todo(`/`.only(` was added anywhere, and specifically that the `'[machine] deletes EVERY per-user row...'` test's body still contains all nine `userRowCounts` field assertions (Acceptance item 2).
6. Inspect the final `vitest.config.ts` / test-file diff to confirm the mechanism used is scoped (per Acceptance item 3), not a bare top-level `testTimeout` increase.

## Feedback obligation

1. General rule: if investigation during `/plan-ticket` or `/build-ticket` reveals the timeout is not actually a load/concurrency artifact but a real bug in the account-delete route or its test setup (e.g. an actual hang, an unresolved promise, a leaked PGlite handle), that falsifies this ticket's Background diagnosis — stop, do not silently reach into `app/api/account/delete/route.ts` (which this ticket's Non-goals explicitly excludes), and escalate for a human/Architect decision instead of expanding scope inside this ticket.
2. If a scoped fix targeting only `app/api/account/delete/route.test.ts`/`vitest.config.ts` is insufficient to reliably pass twice in a row (e.g. the underlying machine is simply too CPU-constrained for PGlite-heavy tests at the current suite size regardless of timeout), do not reach for a broader concurrency change touching `db/schema-auth.test.ts`, `db/migrate.test.ts`, `lib/config/quota.test.ts`, `eval/**`, or `lib/usage/record.test.ts` (Non-goals) to compensate — record the finding here (version +0.1, changelog line) and open a follow-up issue proposing a repo-wide PGlite-test concurrency policy, rather than quietly widening this ticket's file-scope.
3. This ticket is what currently blocks PLT-02 (#26)'s merge (a red `main`) and leaves EVL-02 (#12)'s Definition-of-Done incomplete (`dodPassed=false`) per issue #29's Context section — once this ticket lands and `corepack pnpm test` is confirmed green twice, that unblocks both, but re-verifying and closing those items is the delivery/`/verify-delivery` step's job, not this ticket's.
