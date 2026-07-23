# Implementation plan — ISS-31: Stop `tests/backup.test.ts` from executing an ambient `bash` lookup

Ticket: [docs/prd/99-nightly/tickets/ISS-31-backup-test-ambient-bash-nondeterminism.md](../prd/99-nightly/tickets/ISS-31-backup-test-ambient-bash-nondeterminism.md)
Sub-PRD: none — `99-nightly` is the pipeline's maintenance lane (no product README). `docs/PRD.md` is not implicated: this is test-infrastructure, not product behavior.
ADRs: `docs/adr/` does not exist in this repo. **This change is not an ADR candidate** — reversal cost is ~6 lines (delete the `deps` parameter, un-conditionalize one `describe`). One genuine convention question is raised but deliberately *not* decided here; see §5.1.
Base commit: `c5a2883` on `main` (working tree clean at planning time; that commit is the ISS-31 triage ticket itself). Branch per repo convention: `ticket/ISS-31`.

**This plan is cold-startable**: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone. Standing environment rules for this machine:

- Always invoke pnpm as **`corepack pnpm ...`** — bare `pnpm` is not on `PATH`.
- Run every verification command below **via the Bash tool** (they are POSIX). Every Bash invocation on this machine prints a harmless first line `/c/Users/HoraceHou/.bash_profile: line 1: $'\377\376source': command not found` — that is the user's UTF-16-BOM'd `~/.bash_profile`, **not** a repo file. Ignore it; do not "fix" it.
- Node here is `C:\Program Files\nodejs\node.exe` v22.11.0; vitest is **3.2.7**; the ambient `bash` is Git Bash 5.2.26 (msys) at `C:\Program Files\Git\usr\bin\bash.exe`.

## 0. Repo-state check performed for this plan (verified 2026-07-23 at `c5a2883` by direct execution — Builder: re-verify the cheap ones, do not re-derive the expensive ones)

- **Baseline is green with the machine's normal PATH**: `corepack pnpm test` → **`Test Files 42 passed (42)` / `Tests 399 passed (399)`**, ~18s. Matches the ticket's Background figure exactly.
- **`where bash.exe` still returns three binaries in PATH order** (Git Bash first, then two WSL launcher shims) — the ticket's Background table is current.
- **The bug is now MECHANICALLY REPRODUCED on this host** — the ticket's Background honestly records that the triage session could *not* force a red via WSL. This session forced it deterministically without WSL, and it works. Recipe (proven, §3 step 2 repeats it verbatim): put a **zero-byte file named `bash.exe`** in a directory OUTSIDE the repo and prepend that directory to `PATH`. Windows `CreateProcess` then fails on it deterministically (`spawnSync` → `status=null`, `error.code='UNKNOWN'`), so `execFileSync('bash', …)` inside `backup.mjs` throws before ever reaching a real shell. Observed full-suite result **at `c5a2883`, pre-fix**:
  ```
  Test Files  1 failed | 41 passed (42)
       Tests  1 failed | 398 passed (399)

  FAIL tests/backup.test.ts > … fail-closed dump … > exits non-zero and does NOT upload
       when pg_dump succeeds but produces an empty dump (size guard)
  AssertionError: expected 'spawnSync bash UNKNOWN\n' to contain 'empty backup'
                                                    tests/backup.test.ts:233:33
  ```
  This is byte-for-byte the same *shape* as issue #31's WSL symptom (1 failed / everything else passing, the size-guard test failing because the shell never ran). Only the noise string differs.
- **A finding the ticket does not contain, and it is review-critical**: under that same forced-broken PATH the **first** fail-closed test — Guarantee A, "exits non-zero and does NOT upload when pg_dump fails" — **still PASSES, vacuously**. It only asserts `status !== 0` and "stdout lacks `backup uploaded`", and a *spawn failure* satisfies both. So today's Guarantee A test cannot distinguish "`pipefail` correctly propagated a `pg_dump` failure" from "there was no bash at all". Any replacement must positively assert *which* command was executed, not merely that the run failed. §2.3's N1 does exactly that.
- **No other test file in the suite is affected by a broken `bash`** — under the forced PATH, 41 of 42 files still pass. `tests/deploy-vercel.test.ts`'s `execFileSync('npx', …)` path is unreachable under test (its `VERCEL_TOKEN` guard short-circuits first), consistent with the ticket's Non-goals.
- **Running the suite leaves the tree clean** — `git status --porcelain` was empty after every run above. This matters: `backup-*.sql.gz` is **not** in `.gitignore`, so any mechanism that lets a real `backup-YYYYMMDD.sql.gz` materialize in the repo root would dirty the tree and can break `.claude/scripts/deliver-ticket.mjs`'s post-merge checks. §2.2 chooses the seam that makes this impossible.
- **CI runs the full suite on Linux**: `.github/workflows/ci.yml` runs `pnpm test` on `ubuntu-latest` for every push and PR. Consequence for §2.4: a `describe.runIf(<bash works>)` block **always runs on CI**, so the real-bash end-to-end proof is not lost — it becomes CI-guaranteed instead of laptop-dependent.
- **`describe.runIf(condition)` exists in vitest 3.2.7** (`ChainableSuiteAPI.runIf`, verified in `@vitest/runner@3.2.7`'s type declarations). `vi.stubEnv` / `vi.unstubAllEnvs` also exist; `vitest.config.ts` sets neither `unstubEnvs` nor `restoreMocks`, so cleanup must be explicit.
- **`tsc --noEmit` is ALREADY RED at `c5a2883`** — pre-existing errors, none introduced by this ticket: 1 in `app/api/account/delete/route.test.ts` (TS2352) and **7 in `tests/backup.test.ts`** (TS2339 at 97,16 / 98,16 / 99,16 / 100,16 and TS2345 at 145,57 / 150,57 / 163,57 — all `ProcessEnv` typing, all in describe blocks this ticket does not touch). Capture the baseline before editing (§3 step 0) and prove the post-fix output is identical.
- **The signature of the seam is TS-load-bearing — this was measured, do not re-litigate it.** With `allowJs: true` + `strict: true`, writing the seam as a *destructured parameter with real defaults* — `export function runBackup({ exec = execFileSync, stat = statSync } = {})` — makes TS infer the parameter as `{ exec?: typeof execFileSync; stat?: typeof statSync }`, and **every test call site passing a fake produces a new `TS2322`** ("Type '(…args) => Buffer' is not assignable to type '{ (file: string): NonSharedBuffer; … }'"). Writing it as `export function runBackup(deps = {})` + `const exec = deps.exec ?? execFileSync;` infers `{}`, which accepts any object literal, and produces **zero** new errors. Both forms were compiled under a copy of this repo's `tsconfig.json` this session. §2.1 mandates the second form.
- **Serial-safety**: `git branch -a` lists `main`, `origin/main`, and 18 `ticket/*` branches, of which only **`ticket/PLT-03` is unmerged and in flight**. Its file-scope (`app/(admin)/**`, `lib/db/queries/admin.ts` + test, `middleware.ts`, `middleware.test.ts`, `.env.example`, `docs/plans/PLT-03.md`, `docs/prd/07-platform-launch/**`) is disjoint from this ticket's two files. If another branch touching `tests/backup.test.ts` or `.github/scripts/backup.mjs` has appeared by build time, **stop and escalate** — do not merge blind.
- Ticket-changelog convention (PLT-02 / ISS-30 precedent): the Builder **appends** a `## Changelog` section with a dated `v0.1 (…)` entry to the ticket file at writeback. The ISS-31 ticket has no such section yet — create it.

## 1. Scope

**In scope** — two source files plus bookkeeping:

- `.github/scripts/backup.mjs` — **additive-only**: `runBackup()` gains one optional `deps` parameter carrying two injection seams (`exec`, `stat`) that default to the real `execFileSync` / `statSync`. Three call sites inside `runBackup()` are renamed to use the locals. Nothing else changes: `REQUIRED_ENV`, `MIN_BACKUP_BYTES`, `backupFileName()`, `dumpCommand()`, `uploadCommand()`, the CLI wrapper, and every comment stay byte-identical.
- `tests/backup.test.ts` — the two `bash`-executing tests move under a capability-gated `describe.runIf(...)`; five new PATH-independent in-process tests are added; the `MIN_BACKUP_BYTES` bound test is moved OUT of the conditional block so it keeps running unconditionally.
- `docs/prd/99-nightly/tickets/ISS-31-backup-test-ambient-bash-nondeterminism.md` — append a `## Changelog` section (the ticket's own acceptance items 2 and 5 require specific evidence to be recorded there).
- This plan file, `docs/plans/ISS-31.md`.

**Explicitly out of scope** (ticket Non-goals — do not do these even opportunistically):

- **No change to the production dump command.** `dumpCommand()` must keep returning `{ command: 'bash', args: ['-c', 'set -o pipefail; pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"'], env: {…} }`. Do not switch to `sh`, do not drop `pipefail`, do not touch its signature.
- **No new `process.env` read anywhere in `backup.mjs`.** In particular: no `BACKUP_SHELL` env var. See §2.2 — this is a deliberate security decision, not an oversight, even though the ticket's File-scope text floats `BACKUP_SHELL` as an example.
- **No deletion and no bare `.skip`/`.todo`** of either fail-closed test. Conditional execution is paired with always-running replacement coverage (§2.4, §2.5).
- No edit to `.github/workflows/backup.yml`, `.github/workflows/ci.yml`, `vitest.config.ts`, `package.json`, `tsconfig.json`, `.gitignore`, `docs/ops/backup.md`.
- No edit to any file in `ticket/PLT-03`'s scope (§0).
- **No repo-wide sweep** for other ambient-binary tests. If one is found, record it as a candidate follow-up issue in the Changelog; do not fix it here.
- No change to `tests/backup.test.ts`'s workflow-file, no-op-guard, dump-command-wiring, upload-command-wiring, or `backupFileName` describe blocks. The `dump command wiring` block (lines 113–134) in particular must pass **unmodified** — it is the proof that production is untouched.

## 2. Change list

### 2.1 `.github/scripts/backup.mjs` — the seam (the only production edit)

Current `runBackup()` (lines 103–143) hard-wires the module-level imports at three points: `execFileSync(dump.command, …)` (line 119), `statSync(fileName)` (line 127), `execFileSync(upload.command, …)` (line 136). Make those three points injectable. Exact edit:

```js
// ISS-31: `exec` and `stat` are TEST-ONLY injection seams. Both default to the real
// node:child_process / node:fs implementations, so the production call site below
// (`runBackup()`, no argument) runs byte-for-byte the same commands it always has —
// `bash -c 'set -o pipefail; …'` resolved from the GitHub Actions runner's PATH.
// Deliberately a PARAMETER, never an environment variable: this script executes in a
// job that holds DATABASE_URL and the R2 secret key in its environment, and an
// env-driven "which binary do I exec" switch would hand anything that can set env in
// that job a code-execution lever on a credential-bearing process. A parameter cannot
// be influenced by the environment at all. Rationale: docs/plans/ISS-31.md §2.2.
// The seam exists because tests/backup.test.ts previously proved these guarantees by
// executing an AMBIENT `bash` lookup, which made the suite's outcome depend on which
// bash won the local PATH race (issue #31).
export function runBackup(deps = {}) {
  const exec = deps.exec ?? execFileSync;
  const stat = deps.stat ?? statSync;

  // …unchanged missing-credential no-op block…
  // …unchanged `const fileName = backupFileName();` …

  const dump = dumpCommand(fileName);
  exec(dump.command, dump.args, {              // was: execFileSync(...)
    stdio: 'inherit',
    env: { ...process.env, ...dump.env },
  });

  const { size } = stat(fileName);             // was: statSync(fileName)
  // …unchanged size guard / throw…

  const upload = uploadCommand(fileName);
  exec(upload.command, upload.args, {          // was: execFileSync(...)
    stdio: 'inherit',
    env: { ...process.env, ...upload.env },
  });
  // …unchanged console.log + `return 0;`…
}
```

Hard constraints on this edit:

- **Signature form is fixed**: `runBackup(deps = {})` with `deps.exec ?? execFileSync` / `deps.stat ?? statSync` **inside the body**. Do NOT use a destructured parameter with typed defaults — measured in §0, it adds two `TS2322` errors per test call site.
- Keep the `execFileSync` / `statSync` imports (lines 32–33) — they are now the defaults.
- Do not change the CLI wrapper (lines 146–154): `process.exit(runBackup())` still calls it with no argument.
- Nothing else in the file changes. `git diff .github/scripts/backup.mjs` should show one added comment block, one changed function signature, two added `const` lines, and three renamed call expressions — nothing more.

### 2.2 Mechanism choice and justification (ticket Deliverable 1 — this paragraph is the mandatory written justification)

**Chosen: direction (1), an injected fake runner, implemented as parameter-level dependency injection on `runBackup()` — with direction (3) used strictly as a documented supplement (§2.4), and direction (2)'s env-var variant explicitly rejected.** The two failing tests do not actually test `bash`; they test *`runBackup()`'s orchestration* — "does a non-zero dump abort the run before the upload?" and "does a 20-byte archive abort the run before the upload?" — and they were paying for that with a live shell execution whose resolution this repo does not control. Injecting `exec`/`stat` puts the test in full control of exactly the two facts the guarantees turn on (the dump's exit behavior, and the archive's size) with zero child processes, zero PATH lookups, zero filesystem writes, and zero temp directories, which also removes the stray-`backup-*.sql.gz`-in-the-repo-root hazard that an in-process test using the real `statSync` would create (§0 — that file is not gitignored). Direction (2)'s `BACKUP_SHELL` env var was rejected on **security** grounds, not convenience: `backup.mjs` runs in a GitHub Actions job holding `DATABASE_URL` (which may embed a password) and the R2 secret key, and adding an environment-driven switch over *which binary gets executed with those secrets in its environment* introduces a runtime-configurable code-execution lever into a credential-bearing process — a parameter default is inert by construction and cannot be reached from the environment at all. Direction (2) is also strictly weaker on this host: a fake shell must be a real executable to be spawned, and on Windows neither a shebang script nor a `.cmd` shim can be `execFileSync`'d without `shell: true` (Node ≥18.20 refuses `.bat`/`.cmd`), so the "point it at a stub" story does not actually close on the platform this pipeline runs on. What direction (1) alone would leave uncovered — that the literal string `set -o pipefail; pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"` is *valid bash* and that a real bash *honours* `pipefail` — is restored by §2.4's supplement, which keeps the original end-to-end tests running unchanged wherever a working bash exists, including **every CI run** (`ci.yml` runs `pnpm test` on `ubuntu-latest`), and skips deterministically where one does not.

### 2.3 `tests/backup.test.ts` — new always-running coverage (the replacement)

Import changes at the top of the file: add `runBackup` to the existing `backup.mjs` import (lines 16–21); add `beforeEach, afterEach, vi` to the `vitest` import (line 14); add `statSync` to the `node:fs` import (line 1–8, needed by §2.4's probe).

Add one new `describe` block. Place it immediately **before** the existing fail-closed block, so the always-running coverage reads first:

```ts
describe('.github/scripts/backup.mjs — fail-closed dump logic (ISS-31: PATH-independent)', () => {
  // Injected `exec`/`stat` stand in for `execFileSync`/`statSync`. No child process,
  // no PATH lookup, no filesystem: the outcome cannot depend on which `bash` wins a
  // local PATH race (issue #31), and no backup-*.sql.gz can ever land in the repo.
  const DSN = 'postgres://user:pw@example-not-real/db';
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', DSN);
    vi.stubEnv('R2_ACCESS_KEY_ID', 'AKIDEXAMPLE');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'super-secret-value');
    vi.stubEnv('R2_BUCKET', 'my-bucket');
    vi.stubEnv('R2_ENDPOINT', 'https://acct.r2.cloudflarestorage.com');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();   // vitest.config.ts sets neither unstubEnvs nor restoreMocks
    vi.restoreAllMocks(); // → both cleanups MUST be explicit
  });
  // … N1–N5 …
});
```

The five tests, with the assertion each one owes:

| # | Name (suggested) | Must assert |
|---|---|---|
| **N1** | `'aborts the whole run — and never uploads — when the dump exits non-zero (pipefail propagation)'` | `exec` throws `Object.assign(new Error('Command failed: bash -c set -o pipefail; …'), { status: 2 })` on its first call. Then: `expect(() => runBackup({ exec, stat })).toThrow('Command failed')`; **`exec` called exactly once** (the upload was never attempted); **`exec.mock.calls[0][0] === 'bash'`** and **`exec.mock.calls[0][1][1]` contains `'set -o pipefail'`** (the call that failed really was the pipefail'd dump — this is what today's test cannot tell you, §0); `stat` never called; `logSpy` never called with a string containing `backup uploaded`. |
| **N2** | `'aborts with an `empty backup` error — and never uploads — when the dump exits 0 but writes a near-empty archive'` | `exec` resolves normally; `stat` returns `{ size: 20 }` (gzip-of-empty). Then: `expect(() => runBackup({ exec, stat })).toThrow(/empty backup/)`; the message also contains `refusing to upload`; **`exec` called exactly once**; `stat` called with a name matching **`/^backup-\d{8}\.sql\.gz$/`** (a regex, never a value recomputed in the test — §4.7); `logSpy` never called with `backup uploaded`. |
| **N3** | `'the size guard is exclusive at MIN_BACKUP_BYTES'` | `{ size: MIN_BACKUP_BYTES - 1 }` → throws `/empty backup/`; `{ size: MIN_BACKUP_BYTES }` → does **not** throw and `exec` is called twice. Boundary coverage the suite has never had. |
| **N4** | `'uploads and reports success when the dump produces a real archive'` | `stat` returns `{ size: 4096 }`. `runBackup({ exec, stat })` returns `0`; `exec` called **twice**; `exec.mock.calls[1][0] === 'aws'` and `exec.mock.calls[1][1]` starts `['s3','cp', …]`; `logSpy` called with a string containing `backup uploaded`. This is the first test in the repo that ever reaches the upload branch. |
| **N5** | `'passes DATABASE_URL to the dump child through env only, never through argv'` | On the dump call: `exec.mock.calls[0][2].env.DATABASE_URL === DSN`; `exec.mock.calls[0][2].stdio === 'inherit'`; `JSON.stringify(exec.mock.calls[0][1])` does **not** contain `'postgres://'`. Lifts PLT-02's argv-avoidance property from `dumpCommand()`'s return value up to the actual call site. |

Also **move** the existing `'MIN_BACKUP_BYTES is a small positive bound above an empty gzip (20 bytes)'` test (lines 236–241) out of the fail-closed block and into this new block (or its own block). It has nothing to do with `bash`; leaving it inside the block that §2.4 makes conditional would silently turn unconditional coverage into conditional coverage.

### 2.4 `tests/backup.test.ts` — the retained real-bash end-to-end, capability-gated (direction 3, supplement only)

Keep the existing `runWithFakePgDump()` helper (lines 185–211) and both existing tests (lines 213–223, 225–234) **verbatim**, wrapped in a gate. Add above them, at module scope:

```ts
// ISS-31: does the ambient `bash` actually support everything the end-to-end tests
// below need? This rehearses the whole capability set — bash runs at all; `set -o
// pipefail` is supported; a Windows-style PATH entry is honoured; a shebang script
// found on that PATH executes; gzip exists; a cwd-relative redirect inside an
// os.tmpdir() workdir works. Any failure (absent bash, WSL that cannot translate
// C:\Users\…\Temp paths, a non-shell binary that happens to be named bash) => false
// => the block below is SKIPPED, never red. It never throws: spawnSync reports a
// missing/unspawnable binary via r.error, and the whole body is try/catch/finally.
// Measured this session: ~150ms when bash is healthy, ~10ms when it is not.
function bashCanRunTheDumpPipeline(): boolean {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'iss31-bashprobe-'));
    const binDir = path.join(dir, 'bin');
    mkdirSync(binDir);
    const src = path.join(binDir, 'iss31_probe_src');
    writeFileSync(src, '#!/bin/bash\nprintf "iss31 probe payload\\n"\n');
    chmodSync(src, 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, PROBE_OUT: 'probe.gz' };
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = binDir + path.delimiter + (env[pathKey] ?? '');
    const r = spawnSync('bash', ['-c', 'set -o pipefail; iss31_probe_src | gzip > "$PROBE_OUT"'], {
      cwd: dir, env, encoding: 'utf8', timeout: 15_000,
    });
    if (r.status !== 0) return false;
    return statSync(path.join(dir, 'probe.gz')).size > 20;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const BASH_CAN_RUN_THE_DUMP_PIPELINE = bashCanRunTheDumpPipeline();
```

Then change the existing block's header (line 184) to:

```ts
describe.runIf(BASH_CAN_RUN_THE_DUMP_PIPELINE)(
  '.github/scripts/backup.mjs — fail-closed dump, REAL bash end-to-end (ISS-31 supplement; always runs on CI/ubuntu-latest, skipped where no usable bash exists — the same guarantees are asserted unconditionally by the "fail-closed dump logic" block above)',
  () => { /* helper + the two existing tests, unchanged */ },
);
```

Update the block's leading comment (lines 178–183) to say what the gate is and to name the always-running replacement. Do **not** invert the condition into `describe.skipIf(!…)` — `runIf` reads as "extra coverage where available", which is what it is.

This function was executed this session and returns `true` on this host's Git Bash (`size=40`, 149 ms), `false` on an absent binary (`ENOENT`), `false` on a non-shell binary, and `false` under the forced-broken-`bash.exe` PATH (`UNKNOWN`, 9 ms) — in every failing case without throwing.

### 2.5 Guarantee → assertion mapping (ticket Deliverable 2 — copy this table into the Changelog)

| Guarantee | Always-running proof (no bash) | Supplementary proof (real bash / every CI run) |
|---|---|---|
| **A** — a `pg_dump` failure propagates: run exits non-zero, `backup uploaded` never printed | **N1** (`runBackup` rethrows, upload never attempted, and the failing call is positively identified as the `bash … set -o pipefail` dump) + the untouched `'dump command wiring'` test at lines 114–122 (the command really is `bash -c` with `set -o pipefail`, matching `/pg_dump\s+"\$DATABASE_URL"\s*\|\s*gzip\s*>\s*"\$BACKUP_FILE"/`) | the original `'…when pg_dump fails…'` test, unchanged — proves a real bash honours `pipefail`, that the script string is valid bash, and that the CLI wrapper turns the throw into a non-zero **process** exit |
| **B** — an empty dump is rejected: run exits non-zero, `backup uploaded` never printed, message contains `empty backup` | **N2** (throws `/empty backup/`, upload never attempted, guard fed the real `backup-YYYYMMDD.sql.gz` name) + **N3** (boundary) + the `MIN_BACKUP_BYTES` bound test moved per §2.3 | the original `'…empty dump (size guard)…'` test, unchanged — proves the same message reaches **stderr** of a real non-zero process |
| **Production untouched** | the two `'dump command wiring'` tests (lines 114–133) pass **unmodified**; `dumpCommand()` is not edited at all | — |

Note for the Changelog, stated plainly rather than buried: `grep -n "\.skip(\|\.todo(" tests/backup.test.ts` returns **no matches** after this change. The conditional-execution guard is `describe.runIf(BASH_CAN_RUN_THE_DUMP_PIPELINE)`, and per the table above every guarantee it gates is *also* asserted by a test that always runs. That is the substance acceptance item 5 asks for; do not lean on the grep pattern's literal wording.

### 2.6 Commit structure

On branch `ticket/ISS-31`:

- **Commit A** — `.github/scripts/backup.mjs` + `tests/backup.test.ts` together (the seam is meaningless without its consumer; splitting them leaves an intermediate commit whose suite state is arbitrary). Suggested message: `ISS-31: make backup fail-closed tests PATH-independent via injected exec/stat (#31)`.
- **Commit B** — writeback: `docs/prd/99-nightly/tickets/ISS-31-backup-test-ambient-bash-nondeterminism.md` `## Changelog` append only.
- `docs/plans/ISS-31.md` is already committed by the Architect stage.

## 3. Test plan (every item maps to the ticket's acceptance checklist; all commands from the repo root via the Bash tool)

**Step 0 — capture the `tsc` baseline before touching anything** (so §4.8 can be proven, not asserted):
```
cd /c/Users/HoraceHou/project/personal/Groundwork
npx tsc --noEmit 2>&1 | tee /tmp/iss31-tsc-before.txt | wc -l     # expect 8 error lines + continuation lines
```

1. **Re-confirm the green baseline** (acceptance item 1): `corepack pnpm test` with the normal PATH → expect `42 passed (42)` files / `399 passed (399)` tests, exit 0. If counts differ because another ticket landed first, that is fine — **zero failures is the bar**.

2. **Force the red, pre-fix** (ticket Test-plan step 2; this is the regression baseline acceptance item 2 demands). Build the broken-bash PATH **outside the repo** so `git status` cannot be polluted:
   ```
   FAKEBIN=/c/Users/HoraceHou/AppData/Local/Temp/iss31-fakebin
   mkdir -p "$FAKEBIN" && : > "$FAKEBIN/bash.exe"     # zero-byte file named bash.exe

   # PROVE the shim wins the lookup before trusting any result from it:
   PATH="$FAKEBIN:$PATH" node -e "const{spawnSync}=require('node:child_process');const r=spawnSync('bash',['-c','echo hi'],{encoding:'utf8'});console.log('status=',r.status,'err=',r.error&&r.error.code)"
   # MUST print exactly:  status= null err= UNKNOWN
   # (If it prints status= 0, the shim did NOT win — the whole forced-red proof is void. Stop and fix the PATH.)

   PATH="$FAKEBIN:$PATH" corepack pnpm test
   ```
   Expected pre-fix (observed this session at `c5a2883`): `Test Files 1 failed | 41 passed (42)`, `Tests 1 failed | 398 passed (399)`, with `AssertionError: expected 'spawnSync bash UNKNOWN\n' to contain 'empty backup'` at `tests/backup.test.ts:233:33`. Record verbatim in the Changelog. Run once; do not loop.
   *POSIX equivalent, if this is ever executed on Linux/macOS:* a directory containing an executable `bash` whose body is `#!/bin/sh\nexit 127\n`, or simply a `PATH` with no `bash` in it.

3. **Apply §2.1 + §2.3 + §2.4.**

4. **Forced-broken-bash PATH, post-fix** (acceptance item 2): re-run the exact step-2 block (including the `status= null err= UNKNOWN` pre-check) → must be **fully green, zero failures**, with the real-bash block reported as **skipped**. Expect roughly `Tests 402 passed | 2 skipped (404)` — exact numbers depend on how N1–N5 are split; what must hold is *zero failures* and *exactly the two end-to-end tests skipped*.

5. **Normal PATH, post-fix** (acceptance item 1): `corepack pnpm test` → fully green, **nothing skipped** (the probe returns `true` on this host, so the end-to-end block runs). Expect roughly `404 passed (404)`.

6. **Twice in a row** (acceptance item 8): repeat steps 4 and 5 a second consecutive time each; all four runs green.

7. **Guarantee re-read** (acceptance items 3, 4, 5): confirm §2.5's table against the actual diff — for each of A and B, name the always-running test and the supplementary one. Run `grep -n "\.skip(\|\.todo(\|runIf\|skipIf" tests/backup.test.ts` and reconcile every hit line-by-line in the Changelog.

8. **Production untouched** (acceptance item 6): the `'dump command wiring'` tests must pass **unmodified** — verify with `git diff tests/backup.test.ts` showing no hunk inside lines 113–134, plus:
   ```
   node -e "import('./.github/scripts/backup.mjs').then(m=>{const c=m.dumpCommand('backup-20260719.sql.gz');console.log(JSON.stringify({command:c.command,args:c.args}));console.log('pipefail:',c.args[1].includes('set -o pipefail'));console.log('pipeline:',/pg_dump\s+\"\\\$DATABASE_URL\"\s*\|\s*gzip\s*>\s*\"\\\$BACKUP_FILE\"/.test(c.args[1]));})"
   ```
   Must print `command:"bash"`, `args:["-c","set -o pipefail; pg_dump \"$DATABASE_URL\" | gzip > \"$BACKUP_FILE\""]`, `pipefail: true`, `pipeline: true` with **no** env var set. Also `git diff .github/scripts/backup.mjs` must contain zero hunks inside `dumpCommand()` / `uploadCommand()`.

9. **No new type errors** (§4.8): `npx tsc --noEmit > /tmp/iss31-tsc-after.txt 2>&1; diff /tmp/iss31-tsc-before.txt /tmp/iss31-tsc-after.txt` → **empty diff**. A non-empty diff is a stop-and-fix, not a note.

10. **Diff surface** (acceptance item 7): `git diff --stat main...HEAD` must list exactly `.github/scripts/backup.mjs`, `tests/backup.test.ts`, `docs/plans/ISS-31.md`, and the ticket file. Any fifth path is a scope breach.

11. **Clean tree** (§4.6): `git status --porcelain` empty after every full-suite run — in particular, no `backup-*.sql.gz` anywhere (`git status --porcelain --ignored | grep -i 'sql.gz'` → no output). Also `ls backup-*.sql.gz` → no such file.

12. **Lint**: `corepack pnpm lint` (cheap; the test file gains `vi`/hook imports that must actually be used). No build run is required — this ticket touches no application code and CI runs `pnpm build` on push anyway.

## 4. Risks & edge cases (Reviewer: these are the checks that matter)

1. **[Review-critical] The vacuous-pass trap.** Measured at `c5a2883` (§0): under a broken `bash`, today's Guarantee A test **passes for the wrong reason** — `status !== 0` is satisfied by a spawn failure just as well as by `pipefail`. A replacement that only asserts "it threw" repeats the defect in a new costume. N1 must positively assert that the call that failed was `exec('bash', ['-c', <string containing "set -o pipefail">], …)` and that `exec` was called exactly once. Reviewer: if N1 lacks the `calls[0][0] === 'bash'` / `set -o pipefail` / call-count assertions, bounce it.
2. **[Review-critical] Coverage-boundary honesty.** Injecting `exec` means three facts are no longer proven by an always-running local test: that a real bash honours `pipefail`; that the literal script string is syntactically valid bash; that the CLI wrapper (`backup.mjs` lines 146–154) turns a thrown error into `process.exit(1)` with the message on **stderr**. All three stay covered by §2.4's block, which runs on **every CI run** (`ci.yml` → `pnpm test` on `ubuntu-latest`, where bash is guaranteed). Reviewer: confirm the block is genuinely reachable — invert the probe locally (or run with a healthy bash) and check the two tests actually execute; a permanently-skipped block would be a silent coverage deletion and is a bounce.
3. **Probe false-positive** — a bash that passes `bashCanRunTheDumpPipeline()` but still fails the end-to-end test would reintroduce flakiness. Mitigation: the probe rehearses the *exact* capability set the real test needs (pipefail, a Windows-path PATH entry, a shebang script on that PATH, `gzip`, a cwd-relative redirect inside an `os.tmpdir()` workdir) rather than a token `bash -c 'echo ok'`. Residual risk accepted; if it ever fires the correct fix is to widen the probe, never to re-add an unguarded ambient dependence.
4. **Probe hang / probe throw** — a wedged WSL bash could block forever, and a probe that throws at module scope would fail collection for the whole file. Mitigation: `timeout: 15_000` on `spawnSync` (a timeout yields `status === null` → `false`), and the entire body is `try/catch/finally` with `finally` removing the temp dir. Validated this session against absent, non-shell, and unspawnable binaries: `false` every time, no throw.
5. **[Security-sensitive — the Reviewer's mandate]** `backup.mjs` runs in a job holding `DATABASE_URL` (may embed a password) and the R2 secret key. Four properties to verify on the diff: (a) **no new `process.env` read** was added to `backup.mjs` — the seam is a parameter precisely so the environment cannot select which binary gets executed with those secrets (§2.2); (b) `dumpCommand()` / `uploadCommand()` are untouched, so credentials still travel by env and never by argv — N5 now asserts that at the call site too; (c) no test prints `process.env` wholesale, and the only DSN anywhere is the literal fake `postgres://user:pw@example-not-real/db`; (d) `vi.stubEnv` values are fakes and are removed by `vi.unstubAllEnvs()` in `afterEach` — with no `.env` file in the repo (verified) no real credential can enter the test process.
6. **Filesystem pollution / clean-tree invariant.** `backup-*.sql.gz` is **not** in `.gitignore`. Any in-process design that let the real `statSync` run would need a real file at `process.cwd()` — the repo root — and a crash mid-test would strand it, dirtying `git status` and potentially breaking `.claude/scripts/deliver-ticket.mjs`. Injecting `stat` removes the possibility entirely. Reviewer: `git status --porcelain` must be empty after a full run, and no test in the new block may call `mkdtempSync`, `writeFileSync`, or `process.chdir`.
7. **Date boundary.** `backupFileName()` reads `new Date()` inside `runBackup()`. A test that recomputes the expected name is a midnight-UTC flake. N2 must match `/^backup-\d{8}\.sql\.gz$/`, never an equality against a locally computed string.
8. **`tsc` regression.** The repo's `tsc --noEmit` is already red (8 pre-existing errors, 7 of them in this very file). Measured: the destructured-parameter seam form adds two `TS2322` per call site; the `deps = {}` form adds none (§0). Step 9's `diff` of before/after output is the gate. Reviewer: re-run it independently.
9. **Test-state bleed inside the file.** `vi.stubEnv` mutates the worker process's `process.env`. The sibling no-op-guard tests (lines 69–111) build their child env from `{ ...process.env }` and would see stubbed R2 vars if the stubs leaked. Mitigation: stubs are set in the **new block's** `beforeEach` and removed in its `afterEach`; vitest runs suites within a file sequentially by default. Reviewer: confirm `vi.unstubAllEnvs()` and `vi.restoreAllMocks()` are both present (`vitest.config.ts` sets neither `unstubEnvs` nor `restoreMocks`, so neither happens automatically), and that the no-op tests still pass.
10. **Concurrency** — no product concurrency is touched. The only concurrency surface is vitest's own file-level parallelism, and the new tests own no shared mutable resource (no temp dirs, no files, no ports); `process.env` is per-worker and restored per test.
11. **Forced-red proof can silently self-void.** If the zero-byte `bash.exe` does not actually win the PATH lookup, step 4's "green" proves nothing. Hence the mandatory `status= null err= UNKNOWN` pre-check in step 2. Reviewer: the Changelog must contain that pre-check's output, not just the suite result. Also keep `$FAKEBIN` **outside** the repo.
12. **Count drift** — other tickets may land before this one; the stated 42/399 → ~404 figures are expectations, not assertions. **Zero failures** and **exactly two skipped under the broken PATH** are the assertions.
13. **CI (Linux) impact** — none beyond one extra ~150 ms bash spawn per run of this file; the end-to-end block always runs there, so CI coverage strictly increases relative to today (N1–N5 are new).
14. **Downstream dependency (record, do not act):** `ticket/PLT-03` (issue #27) carries complete, green, unreviewed work that was blocked at the Builder gate by exactly this bug. Once this ticket merges and the suite is confirmed green under both PATHs, `ticket/PLT-03` must be re-run through `run-milestone` so it can finally reach the Reviewer. That re-run belongs to the milestone runner / `/verify-delivery`, not to this ticket — but it must appear in the Changelog so it is not lost.

## 5. Open questions

1. **Should "no test may depend on an ambient PATH binary" become a written repo convention (and eventually a mechanical check)?** This ticket fixes the one live instance; the ticket's Non-goals explicitly forbid a repo-wide sweep, and `tests/deploy-vercel.test.ts` was already checked and found not to have a live equivalent. It is a small, cheap-to-reverse policy, so it is **not** an ADR candidate today — but it is the kind of thing that reappears. **Decider: Horace** (or the next pattern-level review of the testing conventions). Builder's only obligation: if a second instance turns up during the build, record it as a candidate follow-up issue in the Changelog, do not fix it here.
2. **Long-term: keep the real-bash end-to-end at all, or let the static command-shape assertions carry it?** This plan pins **keep** (§2.2, §2.4) because nothing else proves the script string is valid bash. If the Reviewer judges the conditional block to be more maintenance than it is worth, deleting it is a one-line change that costs no acceptance item — but that call belongs to the Reviewer/Horace, not to the Builder mid-build.
3. **None blocking.** The mechanism is pinned in §2.2, the exact signature in §2.1 (measured, not guessed), the test roster in §2.3/§2.4, the commit shape in §2.6, and every acceptance item has a mechanical check in §3.

**Feedback obligations carried from the ticket** — trigger these instead of improvising: if it turns out that neither guarantee can be preserved without executing a real local shell, **stop and escalate** (do not land a skip-only fix). If the seam cannot be made strict-additive — i.e. the real CI command would change even slightly — **stop before committing** and escalate; §3 step 8 is the detector.
