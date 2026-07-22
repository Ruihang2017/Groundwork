---
id: ISS-31
title: Stop tests/backup.test.ts from executing an ambient `bash` lookup (PATH-dependent, breaks on WSL-first hosts)
module: 99-nightly
lane: 99-nightly
size: S
agent: builder
status: draft
date: 2026-07-23
blocked_by: []
blocks: []
---

# ISS-31 — Stop tests/backup.test.ts from executing an ambient `bash` lookup (PATH-dependent, breaks on WSL-first hosts)

Sourced from tracker issue #31 ("tests/backup.test.ts executes ambient `bash -c` — fails on Windows when bash resolves to WSL, blocking unrelated tickets' Builder stage"), triaged via the nightly sweep. Not part of any feature PRD module — `99-nightly` is the pipeline's own bucket for maintenance/bug tickets synthesized from tracker issues outside an existing sub-PRD's scope, per `.claude/agents/triage.md` ("write a ticket file at `docs/prd/99-nightly/tickets/ISS-<number>-<slug>.md`"). No parent sub-PRD README exists for this module (it is not a product feature area); the master spec `docs/PRD.md` is not implicated — this is a test-infrastructure fix, not a product-behavior change.
**Why `builder`:** a narrowly-scoped test-infrastructure fix (make one test's mechanism PATH-independent) with three named candidate mechanisms and a fully mechanical acceptance check — no open product-design question.

## Background + basis

Issue #31 body (verbatim), reproduced and independently sanity-checked by the triage stage before writing this ticket:

> ## Symptom
>
> `tests/backup.test.ts` fails when the ambient `bash` on PATH is WSL's (broken on this host):
>
> ```
> FAIL tests/backup.test.ts > .github/scripts/backup.mjs — fail-closed dump
>      > exits non-zero and does NOT upload when pg_dump succeeds but produces an empty dump (size guard)
> AssertionError: expected '<3>WSL (12) ERROR: CreateProcessParse…' to contain 'empty backup'
>
>   <3>WSL (12) ERROR: CreateProcessParseCommon:711: Failed to translate C:\Users\HORACE~1\AppData\Local\Temp\plt02-backup-4aXauZ
>   <3>WSL (12) ERROR: CreateProcessParseCommon:757: getpwuid(0) failed 2
>   <3>WSL (12) ERROR: CreateProcessEntryCommon:505: execvpe /bin/bash failed 2
>   Command failed: bash -c set -o pipefail; pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"
> ```
>
> It is **environment-dependent, not deterministic**:
>
> | Context | `bash` resolves to | Result |
> | --- | --- | --- |
> | Git Bash (`which bash` → `/usr/bin/bash`) | Git Bash | **green** — 40 files / 366 tests |
> | A context where WSL wins the PATH lookup | WSL `/bin/bash` (broken here) | **red** — 1 failed / 365 passed |
>
> Both were observed on the **same clean `main`** during the same session.
>
> ## Impact — this is what makes it urgent
>
> It blocked an unrelated ticket. **PLT-03** (`/admin` observability, #27) was failed at the **Builder** stage with `testsPassed=false`, even though PLT-03's own work was complete and green:
>
> - 43 new tests passing across 3 new files (365 → 408)
> - `next build` with `DATABASE_URL=""` / `AUTH_SECRET=""` → **EXIT 0**, `/admin` correctly `ƒ (Dynamic)`, no DB import leak
> - `npx tsc --noEmit` errors **byte-identical** to the clean-`main` baseline — zero new type errors
>
> The single failing test was `tests/backup.test.ts` (PLT-02's), outside PLT-03's file-scope. The Builder correctly refused to expand scope and reported it. But `run-milestone` gates on full-suite green, so **PLT-03 never reached the Reviewer** and its module was marked `failed`, which then cascaded.
>
> Any future ticket built in a context where WSL's bash wins will hit the same wall, regardless of that ticket's own quality.
>
> ## Root cause
>
> `.github/scripts/backup.mjs` builds a dump command that genuinely requires bash (`set -o pipefail` is the fail-closed guarantee PLT-02's Reviewer specifically validated — that part is correct for GitHub Actions/Linux). The problem is that the **test executes that command locally** via an ambient `bash` lookup, making a Linux-CI-targeted production detail a hard dependency of the local unit-test run.
>
> ## Acceptance
>
> - [ ] `[machine]` `corepack pnpm test` is green regardless of which `bash` (or none) is first on PATH — verify by forcing the failing resolution, not only the working one.
> - [ ] `[machine]` The fail-closed guarantees PLT-02's Reviewer validated remain genuinely asserted — the empty-dump size guard and the `pipefail` behaviour must still be tested, not deleted or blanket-`skip`ped. If the shell-executing test is replaced, state precisely what now covers that guarantee.
> - [ ] `[machine]` `.github/scripts/backup.mjs` still emits a bash `set -o pipefail` command for the real CI path (do not "fix" this by weakening production to `sh`).
> - [ ] `[machine]` Full suite green twice in a row after a fresh re-checkout.
>
> ## Suggested directions (Builder's choice, justify in the plan)
>
> 1. Assert on the **generated command string** rather than executing it, and cover the size-guard/exit-code logic with an injected fake shell runner.
> 2. Inject the shell binary (e.g. an env var or a parameter defaulting to `bash`) so the test can point at a known-good shell or a stub.
> 3. Skip the shell-executing test when no usable bash is present — acceptable **only** if the guarantee is still covered by (1) or (2), never as the sole fix.

Triage-stage sanity checks performed on this session's working tree (facts this ticket relies on beyond the issue text — do not re-derive, but do re-verify the same commands still hold before building):

- `pnpm` is **not** on `PATH` on the machine this pipeline runs on — always invoke it via `corepack pnpm ...`, never bare `pnpm`. `package.json`'s `"test"` script is `vitest run` (confirmed by reading `package.json` line 14).
- Repo is on `main` @ `c182f1f` (LIB-01 + LIB-02 merged, clean tree). Current full-suite baseline observed this session via Git Bash (`which bash` → `/usr/bin/bash`, GNU bash 5.2.26 msys): `corepack pnpm test` → **42 files / 399 tests, exit 0** (grown from issue #31's own 40/366 by LIB-01/LIB-02 landing since — that growth is unrelated to this ticket and expected).
- **The ambient-bash non-determinism is real and mechanically confirmed on this exact host.** `where bash.exe` on this machine returns three distinct binaries in PATH-lookup order:
  ```
  C:\Program Files\Git\usr\bin\bash.exe          (Git Bash — real bash 5.2)
  C:\Windows\System32\bash.exe                    (WSL launcher shim)
  C:\Users\HoraceHou\AppData\Local\Microsoft\WindowsApps\bash.exe   (WSL launcher shim)
  ```
  Which one a bare `spawnSync('bash', ...)` / `execFileSync('bash', ...)` call resolves to is **entirely a function of PATH ordering at invocation time** — a detail of the calling shell/session, not of this repository. Confirmed directly: `tests/backup.test.ts`'s `runWithFakePgDump()` helper (lines 185-211) calls `spawnSync('node', [scriptPath], { cwd: workdir, env, encoding: 'utf8' })`, where `scriptPath`'s `runBackup()` (`.github/scripts/backup.mjs` line 119) does `execFileSync(dump.command, dump.args, ...)` with `dump.command === 'bash'` (from `dumpCommand()`, `backup.mjs` line 71) — i.e. `bash` is resolved by ambient PATH lookup inside the test run, never pinned to a specific binary.
- **Attempted-force result this session (record honestly, do not overclaim):** re-running the exact empty-dump fail-closed scenario with `C:\Windows\System32` prepended ahead of Git Bash on PATH did **not** reproduce the WSL `execvpe`/`CreateProcessParseCommon` crash from issue #31 — it passed (`backup aborted: ... 20 bytes (< 64) ... refusing to upload an empty backup`, exit 1, as intended) — because the WSL distro registered on this particular session currently resolves and translates paths correctly. This is **consistent with, not contradictory to**, issue #31's own framing: the table explicitly says the failure occurs "in a context where WSL wins the PATH lookup" or where WSL's `/bin/bash` is broken/unregistered on that specific host/session — a property of the machine's WSL install state at a point in time, not a fixed, always-reproducible-here condition. The architectural defect issue #31 reports is real regardless: **the test's pass/fail outcome depends on an ambient, uncontrolled external resolution (which `bash.exe` PATH picks, and whether that WSL distro happens to be healthy right now)** — that is precisely the non-determinism this ticket must eliminate, independent of whether this exact session can currently reproduce the red. The Builder must not treat "I couldn't force a red today" as evidence there's nothing to fix — force a **guaranteed**-broken resolution (e.g. an empty/non-bash-containing PATH, or a stub `bash` shim that fails deterministically) rather than relying on this host's live WSL install.
- **Nothing is in flight that overlaps this ticket's files.** `git branch -a` lists `ticket/PLT-03` as an existing branch (in addition to already-merged branches). Per the orchestrating agent's brief, `ticket/PLT-03`'s file-scope is `app/(admin)/**`, `lib/db/queries/admin.ts` (+test), `middleware.ts`, `middleware.test.ts`, `.env.example`, `docs/plans/PLT-03.md`, `docs/prd/07-platform-launch/**` — none of which is `tests/backup.test.ts` or `.github/scripts/backup.mjs`. **`ticket/PLT-03` carries complete, green, unreviewed work** (per issue #31's own Impact section: 43 new tests, `next build` exit 0, `tsc` byte-identical to baseline) that was blocked from reaching the Reviewer only by this exact bug. It will need to be **re-run through `run-milestone` after this ticket lands** so it can reach the Reviewer stage on a suite that is green independent of ambient `bash` resolution — that re-run is not this ticket's job, only a fact to record.
- `tests/backup.test.ts` (242 lines) and `.github/scripts/backup.mjs` (155 lines) are the only two candidate files. Both were read in full this session (quoted/cited throughout this ticket) — no other file references `bash` or `dumpCommand`/`uploadCommand` (`grep -rn "dumpCommand\|uploadCommand" --include=*.ts --include=*.mjs` outside these two files returns nothing beyond the exports/consumers already named here).

## Goal

`corepack pnpm test` passes **deterministically**, regardless of which `bash` binary (if any) is first on PATH at invocation time, or whether one is present at all — while the fail-closed guarantees PLT-02's Reviewer validated (pipefail-driven propagation of a `pg_dump` failure; the empty-dump size guard) remain genuinely, mechanically asserted by the test suite, and `.github/scripts/backup.mjs` continues to emit a real `bash -c 'set -o pipefail; ...'` command for the actual GitHub Actions/Linux execution path.

## Non-goals

- No change to `.github/scripts/backup.mjs`'s **production behavior** for the real CI path: `dumpCommand()` must keep returning `{ command: 'bash', args: ['-c', 'set -o pipefail; pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"'], ... }` (or behaviorally identical) — do not "fix" this by switching production to `sh` (dash lacks `set -o pipefail` on ubuntu-latest, per the script's own comment at `backup.mjs` lines 27-29) or by removing `pipefail` to sidestep the test problem.
- No deletion or blanket `.skip`/`.todo` of the two `describe('.github/scripts/backup.mjs — fail-closed dump ...')` tests (lines 213-223 and 225-234) as the *sole* fix — issue #31's acceptance and the orchestrating brief both explicitly forbid this. A `.skip` may appear only as a documented supplementary fallback (direction 3) alongside a mechanism from direction 1 and/or 2 that keeps the guarantee genuinely covered — never alone.
- No change to `app/(admin)/**`, `lib/db/queries/admin.ts`/its test, `middleware.ts`/`middleware.test.ts`, `.env.example`, `docs/plans/PLT-03.md`, or `docs/prd/07-platform-launch/**` — that is `ticket/PLT-03`'s in-flight file-scope (Background); this ticket must not touch or collide with it.
- No repo-wide sweep for other tests that might also invoke ambient binaries (e.g. `tests/deploy-vercel.test.ts`, checked this session — its `execFileSync('npx', ...)` real-deploy path is never reached under test because `VERCEL_TOKEN` is unset in the test env, so it has no equivalent live bug). If the Builder discovers another test with the same ambient-PATH pattern, record it as a candidate follow-up issue — do not fix it inside this ticket.
- No change to `tests/backup.test.ts`'s other `describe` blocks (workflow-file assertions, no-op-guard tests, `backupFileName`, `uploadCommand` wiring) — they do not invoke `bash` and are not implicated.

## File-scope (write-owns)

- `tests/backup.test.ts` — the primary file this ticket edits. Specifically the `describe('.github/scripts/backup.mjs — fail-closed dump (Reviewer bounce: silent corruption)', ...)` block (lines 184-242) and, only if the chosen mechanism needs it, the `describe('.github/scripts/backup.mjs — dump command wiring (Reviewer bounce: pipefail)', ...)` block (lines 113-134).
- `.github/scripts/backup.mjs` — may be touched **only** if the chosen mechanism (most likely direction 2, shell-binary injection) needs a seam added to `dumpCommand()`/`runBackup()` — e.g. an optional parameter or an env var (such as `BACKUP_SHELL`) that defaults to `'bash'` when unset, so production behavior for real CI (no such var set) is unchanged. Any such change must preserve the exact default command Non-goals requires.
- Does not touch: `.github/workflows/backup.yml` (no CI-config change needed — the real runner's bash resolution is not in question, only the local test's), any file under `ticket/PLT-03`'s scope listed above, `tests/deploy-vercel.test.ts`, `vitest.config.ts` (no global config change is needed for a single test file's mechanism).
- Serial-safety: `tests/backup.test.ts` and `.github/scripts/backup.mjs` were both authored by PLT-02 (merged, `ticket/PLT-02` — confirmed via `git branch -a`/`git branch --merged main`) and have had no further in-flight edits since (no other open branch touches either path). `ticket/PLT-03` is the only other branch currently in flight and its file-scope is disjoint from both (Background) — no collision.

## Deliverables

1. Replace the two `bash`-executing tests in the `'fail-closed dump'` `describe` block (`tests/backup.test.ts` lines 213-234) with a PATH-independent mechanism. Choose **exactly one** of the three suggested directions below, and write a one-paragraph justification for the choice directly into the plan (`docs/plans/ISS-31.md`) before implementing:
   - **(1) Assert on the generated command string, cover exit/size-guard logic via an injected fake runner.** `dumpCommand()` already returns a plain `{ command, args, env }` object without executing anything (`backup.mjs` lines 69-75) — the `'dump command wiring'` describe block (lines 113-134) already asserts on this object directly and does **not** execute it, so it is unaffected by this bug already. The gap is only in the two `'fail-closed dump'` tests, which need the exit-code/stdout/stderr *behavior* of `runBackup()` under a controllable stand-in for what `execFileSync('bash', ...)` would do — achieved by making the executor itself injectable (this collapses toward direction 2 for the size-guard/pipefail-propagation half; direction 1 alone only covers the command-shape half, which is already covered).
   - **(2) Inject the shell binary.** Add a seam to `.github/scripts/backup.mjs` — e.g. `dumpCommand(fileName, shell = process.env.BACKUP_SHELL || 'bash')` — so the test can point the executed command at a binary it fully controls: a repo-local fixture bash script under a fixed, known-good path, or (if a real usable bash cannot be assumed even in CI-adjacent local dev) a minimal POSIX-shell-free stand-in that still exercises the exit-code/stdout/size-guard logic `runBackup()` implements around the dump. Production default (`BACKUP_SHELL` unset) must still resolve to the literal string `'bash'`, preserving the exact command Non-goals requires for the real CI path.
   - **(3) Conditional skip, supplement only.** If (1)/(2) alone cannot fully cover both guarantees (pipefail-driven failure propagation AND the empty-dump size guard) in a way that is itself deterministic, a `describe.skipIf(<no usable bash detected>)` may wrap the remaining execution-dependent assertion — but only paired with a mechanism from (1)/(2) that keeps the *logic* (not just the command shape) genuinely tested some other way. A bare skip with no replacement coverage is rejected per Non-goals.
2. Whichever mechanism is chosen, both currently-existing assertions must remain true and be asserted by *something* in the new test(s), with the mapping stated explicitly in the plan and in this ticket's eventual Changelog:
   - Guarantee A (pipefail propagation): when the "pg_dump" step fails (non-zero exit / stderr), the overall run must exit non-zero and must NOT print `backup uploaded`.
   - Guarantee B (empty-dump size guard): when "pg_dump" exits 0 but produces no usable output, the overall run must exit non-zero, must NOT print `backup uploaded`, and must report a message containing `empty backup` (matching `runBackup()`'s literal error text at `backup.mjs` lines 129-132, `MIN_BACKUP_BYTES` at line 49).
3. If Deliverable 1 requires touching `.github/scripts/backup.mjs`, the change must be additive-only (a new optional parameter/env var with a default that reproduces today's exact behavior) — confirm this by keeping the `'dump command wiring (Reviewer bounce: pipefail)'` describe block's existing assertions (lines 114-133) passing unmodified, or updating them only to reflect the new optional parameter's default value (still resolving to `'bash'`/the unchanged command string).

## Acceptance checklist (classified)

- [ ] `[machine]` `corepack pnpm test` is green with the machine's normal/current PATH (baseline re-confirmation; expect ≥ 42 files / ≥ 399 tests, no regressions — exact count may differ if other tickets landed first, but zero failures is the bar).
- [ ] `[machine]` `corepack pnpm test` is **also** green when re-run with a PATH from which every `bash`-named binary has been removed or replaced by a deliberately-broken stub (e.g. a shim script that always exits 127 or prints a fabricated WSL-style error) placed first on PATH — this is the FORCED failing-resolution proof issue #31's acceptance explicitly requires ("verify by forcing the failing resolution, not only the working one"); a green run only under the currently-working ambient bash does NOT satisfy this item. Record the exact command used to construct the broken/absent-bash PATH and its result in the Changelog.
- [ ] `[machine]` Guarantee A is still asserted: some test (updated or new) exercises the "pg_dump fails" scenario and asserts non-zero exit + stdout does not contain `backup uploaded`, using the chosen mechanism from Deliverable 1 (not a live bash resolution).
- [ ] `[machine]` Guarantee B is still asserted: some test (updated or new) exercises the "pg_dump succeeds but produces empty output" scenario and asserts non-zero exit + stdout does not contain `backup uploaded` + the failure message contains `empty backup`.
- [ ] `[machine]` If any `describe.skip`/`it.skip`/`.todo` is introduced anywhere in `tests/backup.test.ts` as part of this ticket, it is paired with a replacement assertion of the same guarantee elsewhere (per Deliverable 1, direction 3) — a skip with no paired replacement fails this item. `grep -n "\.skip(\|\.todo(" tests/backup.test.ts` output must be reconciled line-by-line against Guarantees A and B in the Changelog.
- [ ] `[machine]` `.github/scripts/backup.mjs`'s `dumpCommand()` still returns `command: 'bash'` and an `args[1]` containing `set -o pipefail` and matching `/pg_dump\s+"\$DATABASE_URL"\s*\|\s*gzip\s*>\s*"\$BACKUP_FILE"/` when invoked with no special env/parameter override (i.e. the real-CI default path is byte-for-byte unchanged) — the existing `'dump command wiring'` assertions (lines 114-133) still pass, proving production for the actual GitHub Actions/Linux path is untouched.
- [ ] `[machine]` No file outside this ticket's File-scope is modified — `git diff --stat` against the merge-base shows only `tests/backup.test.ts` and, if used, `.github/scripts/backup.mjs`, plus `docs/plans/ISS-31.md` and this ticket file's own Changelog append.
- [ ] `[machine]` `corepack pnpm test` is green twice in a row on a fresh re-run (mirrors ISS-29/ISS-30's standing "twice" bar) — both with the normal PATH and with the forced-broken-bash PATH from item 2.

No `[human]` criteria — this is a self-contained test-infrastructure fix; the mechanism choice (Deliverable 1) is delegated to the Builder with a mandatory written justification, not a judgment call needing escalation.

## Test plan

1. Reconfirm the current green baseline before changing anything: `corepack pnpm test` with the normal ambient PATH — record the exact file/test counts (Background's 42/399 or whatever is current at build time).
2. Force the failing resolution deterministically (do NOT rely on this host's live WSL install, which this session found to currently work — Background's "Attempted-force result"): construct a PATH with a stub `bash` (a tiny script/executable that always fails, e.g. `exit 127` or that echoes a fabricated `WSL (12) ERROR: ...` string then exits non-zero) placed ahead of any real bash, or a PATH with no `bash`-named entry at all. Run `corepack pnpm test` against the **pre-fix** tree with this PATH and confirm the reported failure reproduces the shape of issue #31's symptom (the two `'fail-closed dump'` tests fail, everything else passes) — this is the regression baseline that proves the bug is real and that the fix changes something.
3. Apply Deliverable 1's chosen mechanism.
4. Re-run step 2's forced-broken-bash PATH against the **post-fix** tree — must now be fully green (Acceptance item 2).
5. Re-run with the normal ambient PATH — must also be green (Acceptance item 1), confirming the fix does not depend on some new PATH assumption of its own.
6. Repeat steps 4 and 5 a second consecutive time each (Acceptance item 8).
7. Inspect the diff: confirm Guarantee A and Guarantee B (Deliverables 2 + Acceptance items 3-4) are each still asserted by name, and that `.github/scripts/backup.mjs`'s `dumpCommand()` default output is unchanged (Acceptance item 6) — reuse the existing `'dump command wiring'` describe block's assertions (`tests/backup.test.ts` lines 114-133) as the check, updating only if a new optional parameter was added with a documented default.
8. `git diff --stat` against the merge-base to confirm no file outside File-scope changed (Acceptance item 7).

## Feedback obligation

1. General rule: if implementation reveals that no PATH-independent mechanism can preserve both Guarantee A and Guarantee B without also executing a real POSIX shell locally (e.g. the size-guard logic turns out to be inseparable from `execFileSync`'s actual child-process behavior in a way direction 1/2 cannot fake), that falsifies this ticket's Goal — stop, update this ticket (version +0.1, changelog line) with the actual finding, and escalate rather than silently landing a `.skip`-only fix (Non-goals explicitly forbids this as the sole outcome).
2. If the chosen mechanism requires modifying `.github/scripts/backup.mjs` in a way that is not a strict additive default-preserving change (i.e. the real CI command would change even slightly), stop before committing — that would touch production backup behavior PLT-02's Reviewer already validated, which is out of this ticket's authority to alter silently. Escalate for a human/Architect decision.
3. `ticket/PLT-03` (issue #27) has complete, green, unreviewed work blocked only by this exact bug (Background). Once this ticket lands with `corepack pnpm test` confirmed green under both a normal and a forced-broken-bash PATH, `ticket/PLT-03` needs to be re-run through `run-milestone` so it can reach the Reviewer — that re-run and re-verification is the milestone runner's/`/verify-delivery`'s job, not this ticket's, but record the dependency here so it is not lost.
4. If a repo-wide pattern of other tests invoking ambient external binaries turns up during investigation (Non-goals notes `tests/deploy-vercel.test.ts` was checked and found not to have a live equivalent bug), record it as a candidate follow-up issue rather than silently widening this ticket's scope.
