# Implementation plan — PLT-02: Weekly backup pipeline

Ticket: [docs/prd/07-platform-launch/tickets/PLT-02-backup-pipeline.md](../prd/07-platform-launch/tickets/PLT-02-backup-pipeline.md)
Sub-PRD: [docs/prd/07-platform-launch/README.md](../prd/07-platform-launch/README.md) (v0.2 as of this plan — PLT-01 already merged)
Master spec: [docs/PRD.md](../PRD.md) §8.2 (architecture diagram: "每周 `pg_dump`（GitHub Actions cron）→ Cloudflare R2"), §5.6 ("库为资产"), §8.1 ("固定成本… R2 免费额度内 = $0")
Breakdown plan file-ownership: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) line 59 — `.github/workflows/backup.yml`, `docs/ops/backup.md` are exclusively `07-platform-launch`'s; no other module claims them.
Depends on (merged into `main` as of this plan): FND-05 (`db/schema.ts`, `db/index.ts`, `DATABASE_URL` contract), FND-01 (`.env.example` created with the seven P0 keys, `.github/workflows/ci.yml`), FND-09 (`.github/scripts/deploy-vercel.mjs` — the no-op-script pattern this ticket explicitly mirrors), PLT-01 (most recent `07-platform-launch` merge; establishes this module's Changelog-writeback convention).
Downstream: none (`blocks: []`). This ticket's only consumer is Horace's own manual ops workflow (`docs/ops/backup.md`) and the module-level P5 sign-off gate.

ADR status: none required. The ticket's own header is explicit — "No ADR — the decision is already made in PRD §8.2." This plan makes one non-trivial technical judgment call (which Postgres connection endpoint `pg_dump` should target against Neon — §0.4/§4/§5 Q1) that is flagged for the Builder to verify empirically, not silently assumed; it does not rise to ADR weight because PRD/the ticket's own Feedback obligation #2 already anticipated exactly this class of uncertainty and delegated it to build time.

## 0. Repo-state check performed for this plan (verified by direct inspection 2026-07-19, do not re-derive)

1. **`.github/workflows/ci.yml` (FND-01/FND-09, merged) is a single `build` job**: checkout → `pnpm/action-setup@v4` → `actions/setup-node@v4` (`node-version: '22'`) → `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm build` → a `Deploy to Vercel` step gated `if: github.ref == 'refs/heads/main' && github.event_name == 'push'`, delegating its no-op logic to `.github/scripts/deploy-vercel.mjs`. This ticket creates an **independent** workflow file (`backup.yml`) and does not edit `ci.yml` — confirmed no overlap, matching the ticket's own "Does not touch" note.
2. **`.github/scripts/deploy-vercel.mjs` (FND-09) is the exact no-op pattern this ticket must mirror**, read directly: reads a required secret from `process.env`, if absent logs a fixed human-readable string and `process.exit(0)`, otherwise `execFileSync`s the real external command with `stdio: 'inherit'`, secret passed only via argument/env — never `console.log`'d. `tests/deploy-vercel.test.ts` proves the no-op path by `spawnSync('node', [scriptPath], { env })` with the secret var deleted from a copy of `process.env`, asserting `status === 0` and a `stdout` substring match. This plan's `.github/scripts/backup.mjs` (§2.2) and `tests/backup.test.ts` (§2.3) follow this exact shape.
3. **`tests/toolchain.test.ts` (FND-01) is the actual precedent for "CI workflow validity was checked" the ticket's acceptance item 51 references** — and it does **not** parse YAML with a real parser. It reads `ci.yml` as a raw string and asserts regex/substring matches (e.g. `expect(ci).toMatch(/pnpm\/action-setup@v\d+/)`, `expect(ci).not.toMatch(/corepack\s+enable/)`). No `yaml`/`js-yaml` package is installed anywhere in this repo (`package.json` checked directly — confirmed absent). This is a real gap between the acceptance item's literal wording ("valid YAML") and what the only existing precedent actually verifies (well-formed-enough substrings, not genuine YAML syntax validity) — flagged as an explicit, non-blocking choice point in §2.3/§5 Q2 rather than silently resolved either way.
4. **`db/index.ts` (FND-05, merged) constructs its Drizzle client from a single `DATABASE_URL` env var**, using `@neondatabase/serverless`'s `neon-http` driver (HTTP/fetch-based, not a raw TCP libpq connection) for the app's own queries, plus a second `neon-serverless` (`Pool`-based, WebSocket) client for PLT-01's transactional delete. Neither of these is what `pg_dump` uses: `pg_dump` is a real libpq/TCP client and does not go through either Drizzle driver — it connects directly to Neon's standard Postgres wire-protocol endpoint using the same connection-string *value* (a plain `postgres://user:pass@host/db?sslmode=require`-shaped string), which Neon issues regardless of which app-side driver later reads it. **The one real open question is *which* Neon endpoint that string points at**: Neon issues both a pooled endpoint (hostname suffixed `-pooler`, PgBouncer in transaction-pooling mode) and a direct/unpooled endpoint, and Neon's own documentation (as of general knowledge, not independently re-verified in this offline environment — ticket Feedback obligation #2 explicitly delegates this exact check to the Builder) recommends `pg_dump`/`pg_restore` run against the **direct/unpooled** endpoint, since PgBouncer transaction-pooling mode does not support all session-level behavior `pg_dump` can rely on. No real `DATABASE_URL` exists yet in this repo (Neon provisioning is still a `[human]` item per FND-05's own acceptance checklist) — this cannot be resolved by inspection today. §4/§5 Q1 carry this forward as a named, concrete risk for the Builder to verify once Horace provisions a real `DATABASE_URL`, rather than a vague "check the docs" pointer.
5. **`.env.example` currently has exactly 8 lines**, no comments, no R2 keys: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `GLOBAL_DAILY_SPEND_LIMIT_USD` (the last added by FND-06). `docs/plans/FND-01.md` §2.6 explicitly pre-authorizes this ticket's append: *"This file is append-only for later tickets (FND-06's daily spend threshold, PLT-02's R2 credentials per the ticket's own Deliverable-7 note)."* No collision risk — this is the first ticket to touch the file since FND-06.
6. **FND-09's own equivalent decision went the other way**: FND-09's Changelog explicitly records *not* adding `VERCEL_TOKEN`/`VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` to `.env.example` at all, reasoning that GitHub Actions repo secrets are "a different mechanism from the application runtime env vars this file lists." **PLT-02's own ticket text explicitly overrides that default** — Deliverable 1 literally says "append these placeholder names to `.env.example`," while *also* saying to document them as CI-only, not runtime, values. This plan resolves the apparent tension in §2.4 (append them, but as a clearly-labeled comment block distinct from the runtime-var lines above it) rather than following FND-09's silent-omission precedent — flagged for the Reviewer in §5 Q3 since it is a ticket-specific instruction, not a repo-wide rule, and a future ticket should not assume PLT-02's choice generalizes.
7. **No `docs/ops/` directory exists yet** (confirmed — only `docs/adr/.gitkeep` and `docs/plans/*.md` exist under `docs/`). This ticket creates the directory implicitly by adding `docs/ops/backup.md`.
8. **`vitest.config.ts`'s `test.include` already contains `'tests/**/*.test.ts'`** — a new `tests/backup.test.ts` file is discovered with **no config change needed**, exactly like FND-09's `tests/deploy-vercel.test.ts`.
9. **No `aws`/`rclone` CLI, no AWS/Cloudflare GitHub Action, and no `postgresql-client` (`pg_dump`) install step exists anywhere in this repo today.** GitHub-hosted `ubuntu-latest` runner images are widely documented (`actions/runner-images`) to ship the AWS CLI v2 pre-installed, but **not** `pg_dump`/`postgresql-client` by default — the ticket's own Deliverable 1 literally lists "install `pg_dump`-compatible Postgres client tooling" as its own step for exactly this reason; this plan does not skip it (§2.1).
10. **`docs/prd/07-platform-launch/README.md` is currently v0.2** (PLT-01's writeback is the latest entry) — this ticket's writeback is v0.3 (§2.5).
11. **PLT tickets in this module do not carry a frontmatter `version:` field** (checked `PLT-01-privacy-tos-account-delete.md` directly — no `version:` line even after its own Builder writeback, unlike `FND-*` tickets which do). This plan does not require the Builder to invent one; a `## Changelog` section addition (module convention, confirmed) is sufficient.

## 1. Scope

**In scope** (ticket Deliverables 1–2, reconciled against §0's findings):

- `.github/workflows/backup.yml` (new) — scheduled weekly + manually dispatchable GitHub Actions workflow: checkout, install `postgresql-client`, run `.github/scripts/backup.mjs` with `DATABASE_URL` + four `R2_*` secrets injected via `env:` (§2.1).
- `.github/scripts/backup.mjs` (new) — the actual backup logic (`pg_dump | gzip` → `aws s3 cp` to R2), extracted from the workflow so its no-op path is unit-testable outside a GitHub Actions runner, exactly mirroring `.github/scripts/deploy-vercel.mjs`'s shape (§2.2). Not literally named in the ticket's File-scope list, but required by the ticket's own Test-plan sentence ("extracted into a script the workflow calls, so it's testable outside the GitHub Actions runner") — the same interpretive extension `docs/plans/FND-09.md` made for `deploy-vercel.mjs`, which was not literally listed in FND-09's File-scope either.
- `tests/backup.test.ts` (new) — two groups of assertions: (a) workflow-file structural checks (weekly `schedule`/cron presence — acceptance item 51), (b) the no-op/skip behavior of `backup.mjs` with required env vars unset (acceptance item 52) (§2.3).
- `.env.example` (append) — a clearly-labeled comment block naming `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET`/`R2_ENDPOINT` as GitHub Actions repository secrets, not application runtime vars (§2.4). Also documents that this workflow needs its own `DATABASE_URL` **GitHub Actions repo secret** (separate configuration surface from the app's Vercel env var of the same name) — a necessary consequence of `pg_dump` needing it, not literally named as a ticket deliverable but unavoidable to make the workflow function at all (§4).
- `docs/ops/backup.md` (new) — human-readable restore procedure: where dumps live in R2, how to fetch the latest one, the exact `psql` restore command, and a retention note pointing at R2's own lifecycle rules (Horace's Cloudflare-dashboard task, not app code) (§2.5).
- `docs/prd/07-platform-launch/tickets/PLT-02-backup-pipeline.md` + `docs/prd/07-platform-launch/README.md` — Changelog writebacks recording build-time decisions/deviations (§2.6), following the PLT-01/FND-09 precedent.

**Explicitly NOT in scope** (ticket Non-goals, confirmed against §0):

- No automated restore-drill / restore-verification job.
- No point-in-time recovery / more-than-weekly backup cadence.
- No real Cloudflare R2 bucket creation or GitHub Actions secret configuration — Horace's task (`[human]` acceptance item, Feedback obligation #1).
- No edits to `.github/workflows/ci.yml`, `db/schema.ts`, `db/index.ts`, or any `03`–`06` module file.
- No automatic old-backup deletion/lifecycle policy in application code — R2's own dashboard-configured lifecycle rules are the answer per the ticket's own text.
- No new production **runtime** dependency (no `aws-sdk`, no `pg` npm package) — `backup.mjs` shells out to the `aws` CLI and `pg_dump` binary already available (or installed by the workflow) on the runner, keeping `package.json`'s dependency list untouched, matching the ticket's implicit "no application-code tests are strictly needed" framing (acceptance item 54).

## 2. Change list

### 2.1 `.github/workflows/backup.yml` (new)

```yaml
name: Weekly backup

# PLT-02. Weekly pg_dump of the production Neon database, uploaded to Cloudflare R2
# (PRD §8.2). `workflow_dispatch` is added so Horace can trigger one real run on
# demand to satisfy this ticket's [human] acceptance item ("confirms one real backup
# run succeeds end to end") without waiting for the next scheduled window — it does
# not change the no-op contract below.
on:
  schedule:
    # Sundays 03:00 UTC — low-traffic default; PRD only specifies "每周" (weekly), not
    # a specific day/time. Adjust freely; not load-bearing for any acceptance item.
    - cron: '0 3 * * 0'
  workflow_dispatch: {}

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      # ubuntu-latest does not ship pg_dump by default (unlike the AWS CLI, which
      # is pre-installed) — install explicitly rather than assume. Idempotent/cheap;
      # runs unconditionally (before the secret check below) so it never masks a
      # "tooling missing" failure behind the no-op path.
      - name: Install PostgreSQL client tools (pg_dump)
        run: sudo apt-get update && sudo apt-get install --yes postgresql-client

      # R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_ENDPOINT are GitHub
      # Actions REPOSITORY SECRETS (Settings > Secrets and variables > Actions),
      # configured directly in GitHub — NOT read from .env.example or any app runtime
      # config. See .env.example's own comment block and backup.mjs's header comment
      # for the same note. DATABASE_URL here is a SEPARATE GitHub Actions secret from
      # the app's Vercel env var of the same name — both must point at the same
      # production Neon database, but each platform's secret store is configured
      # independently; setting one does not set the other.
      - name: Run backup
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
          R2_ENDPOINT: ${{ secrets.R2_ENDPOINT }}
        run: node .github/scripts/backup.mjs
```

Single job, no matrix, no dependency on `ci.yml` — fully independent workflow file per the ticket's File-scope "Does not touch" note (§0.1).

### 2.2 `.github/scripts/backup.mjs` (new)

```js
#!/usr/bin/env node
// Invoked by .github/workflows/backup.yml's "Run backup" step (PLT-02 Deliverable 1).
// No-ops gracefully (exit 0, no error) when any required credential is unset — real
// Cloudflare R2 bucket/secret provisioning is Horace's manual task (ticket Feedback
// obligation #1), so this step must never hard-fail CI before that happens. Extracted
// to a standalone script (not inline YAML) specifically so the no-op path is
// directly, deterministically unit-testable — see tests/backup.test.ts. Mirrors
// .github/scripts/deploy-vercel.mjs's no-op pattern (FND-09) intentionally.
//
// R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_ENDPOINT are GitHub
// Actions REPOSITORY SECRETS, consumed only here — NOT application runtime env vars
// read by the Next.js app. DATABASE_URL here is likewise a GitHub Actions repo
// secret, configured independently from the app's own Vercel env var of the same
// name. See .env.example's comment block for the same distinction.
//
// Security: DATABASE_URL and the R2 credentials are passed to child processes only
// via environment variables (never as literal CLI arguments), so neither appears in
// `ps`/process-listing output on the runner. Never add logging that echoes
// process.env wholesale here or in the test.
import { execFileSync } from 'node:child_process';

const required = [
  'DATABASE_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENDPOINT',
];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  // Exact phrase from the ticket's Deliverable 1 ("R2 credentials not configured,
  // skipping backup") is preserved verbatim so any consumer asserting on that
  // literal substring matches regardless of which specific var(s) are missing;
  // the bracketed list is an additive debugging aid, not a replacement.
  console.log(
    `R2 credentials not configured, skipping backup (missing: ${missing.join(', ')})`,
  );
  process.exit(0);
}

const { DATABASE_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT } =
  process.env;

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
const fileName = `backup-${stamp}.sql.gz`;

// Plain-format pg_dump piped through gzip — matches the ticket's own literal example
// command exactly (no -Fc custom format), so restore is a single `gunzip | psql`
// (docs/ops/backup.md), no pg_restore step to document. DATABASE_URL is referenced
// via shell variable expansion ($DATABASE_URL), NOT interpolated into the command
// string or passed as an execFileSync argument — keeps the connection string (which
// may embed a password) out of argv/process-listing visibility.
execFileSync('sh', ['-c', `pg_dump "$DATABASE_URL" | gzip > ${fileName}`], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL },
});

// R2 is S3-API-compatible (ticket Deliverable 1) — `aws s3 cp` against R2's
// account-specific endpoint, credentials via env (same argv-avoidance rationale).
execFileSync(
  'aws',
  ['s3', 'cp', fileName, `s3://${R2_BUCKET}/${fileName}`, '--endpoint-url', R2_ENDPOINT],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: R2_SECRET_ACCESS_KEY,
    },
  },
);

console.log(`backup uploaded: ${fileName}`);
```

Notes for the Builder:

- The real-upload path (both `execFileSync` calls) is **not exercised by any automated test** in this ticket — it needs a live `DATABASE_URL` and real R2 credentials, neither available in this environment (same untested-real-path pattern as `deploy-vercel.mjs`'s real deploy call, per FND-09 precedent). Only the no-op branch is machine-tested (§2.3).
- If Neon's pooling mode (§0.4) turns out to require a different connection string than the app's own `DATABASE_URL` (e.g. an unpooled variant), that changes what value Horace puts in the **GitHub Actions** `DATABASE_URL` secret, not this script's code — but the divergence must still be recorded per the ticket's Feedback obligation #2, in this ticket's own Changelog (§2.6), not silently.

### 2.3 `tests/backup.test.ts` (new)

```ts
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'backup.yml');
const scriptPath = path.join(repoRoot, '.github', 'scripts', 'backup.mjs');

describe('.github/workflows/backup.yml — weekly schedule trigger (acceptance item 51)', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  it('declares a `schedule:` trigger with a cron expression', () => {
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron:\s*'[^']+'/);
  });

  it('does not touch the existing CI workflow (independent file, per ticket File-scope)', () => {
    // Regression guard, not a workflow-content assertion: this file's own existence
    // must not have required editing ci.yml. Cheap sanity check colocated here
    // rather than a separate file.
    const ci = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).not.toMatch(/backup/i);
  });
});

describe('.github/scripts/backup.mjs — no-op guard (acceptance item 52)', () => {
  it('exits 0 and logs a clear skip message when R2/DB credentials are unset', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.R2_ACCESS_KEY_ID;
    delete env.R2_SECRET_ACCESS_KEY;
    delete env.R2_BUCKET;
    delete env.R2_ENDPOINT;

    // Runs the exact script the CI workflow invokes, not a re-implementation —
    // satisfies the acceptance item's "verified by running the step's logic locally
    // with the env vars unset" wording, same pattern as tests/deploy-vercel.test.ts.
    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('R2 credentials not configured, skipping backup');
  });

  it('no-ops the same way when only the R2 secrets are unset but DATABASE_URL happens to be set', () => {
    // DATABASE_URL alone is not sufficient to attempt a real backup — this locks in
    // that the R2 credential check is not bypassable by a partially-configured env,
    // without needing a real Postgres connection (the sh/pg_dump branch is never
    // reached because the missing-var check runs first).
    const env = { ...process.env, DATABASE_URL: 'postgres://example-not-real/db' };
    delete env.R2_ACCESS_KEY_ID;
    delete env.R2_SECRET_ACCESS_KEY;
    delete env.R2_BUCKET;
    delete env.R2_ENDPOINT;

    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('R2 credentials not configured, skipping backup');
  });
});
```

Covered by the existing `tests/**/*.test.ts` glob — no `vitest.config.ts` change needed (§0.8).

**Known, explicitly-accepted gap** (per §0.3): the first `describe` block checks structural substrings, not genuine YAML well-formedness — a file with a stray unbalanced quote elsewhere in it could still pass these regexes while being invalid YAML. This is the same class of gap `tests/toolchain.test.ts` already accepts for `ci.yml`; §5 Q2 offers the Builder an optional, not-mandatory upgrade path (add the `yaml` npm package and genuinely `parse()` the file) rather than this plan mandating a new dependency by fiat.

### 2.4 `.env.example` (append)

```diff
 ANTHROPIC_API_KEY=
 DATABASE_URL=
 AUTH_SECRET=
 AUTH_GOOGLE_ID=
 AUTH_GOOGLE_SECRET=
 RESEND_API_KEY=
 RESEND_FROM_EMAIL=
 GLOBAL_DAILY_SPEND_LIMIT_USD=
+
+# --- GitHub Actions repository secrets (PLT-02 weekly backup workflow) ---
+# The four keys below are NOT read by the Next.js app at runtime and do NOT belong
+# in .env.local — they are consumed only by .github/workflows/backup.yml via
+# .github/scripts/backup.mjs, and must be configured as GitHub Actions repository
+# secrets (Settings > Secrets and variables > Actions), never as values in this file
+# or in Vercel's project env vars. DATABASE_URL above (the app's own runtime var) is
+# a separate configuration surface from the DATABASE_URL GitHub Actions secret the
+# same workflow also needs — see docs/ops/backup.md.
+# R2_ACCESS_KEY_ID=
+# R2_SECRET_ACCESS_KEY=
+# R2_BUCKET=
+# R2_ENDPOINT=
```

The four new lines are commented out (`#`-prefixed), unlike the file's existing eight bare `KEY=` lines — a deliberate typographic distinction reinforcing the comment's own text (these are not `.env.local` values to fill in) while still satisfying the ticket's literal "append these placeholder names to `.env.example`" instruction (§0.6). Flagged for the Reviewer in §5 Q3 as this plan's specific resolution of that instruction's internal tension.

### 2.5 `docs/ops/backup.md` (new)

Structure (content is the Builder's to word; this plan fixes the required sections and their factual content, not exact prose):

1. **Overview** — one paragraph: weekly `pg_dump` of the production Neon database, gzip-compressed, uploaded to Cloudflare R2 by `.github/workflows/backup.yml`; automatic, no human action needed once provisioned (link to Feedback obligation #1's provisioning requirement).
2. **Where backups live** — bucket = the `R2_BUCKET` secret's value (documented as "ask Horace" since agents cannot see the real value); object key format `backup-YYYYMMDD.sql.gz` (matches `backup.mjs`'s `fileName`, §2.2); how to browse via the Cloudflare dashboard or `aws s3 ls --endpoint-url <R2_ENDPOINT> s3://<bucket>/`.
3. **Triggering a manual backup** — via the Actions tab's "Run workflow" button (the `workflow_dispatch` trigger added in §2.1) — this is the mechanism for the ticket's `[human]` acceptance item's "confirms one real backup run succeeds end to end."
4. **Restore procedure** — the literal commands:
   ```
   aws s3 cp s3://<bucket>/backup-YYYYMMDD.sql.gz . --endpoint-url <R2_ENDPOINT>
   gunzip -c backup-YYYYMMDD.sql.gz | psql "<TARGET_DATABASE_URL>"
   ```
   Explicit note: `<TARGET_DATABASE_URL>` should point at a **fresh, empty** Neon database (not the live production one) unless deliberately restoring in place — plain-format `pg_dump` output re-creates tables and will error/conflict against a non-empty target with the same table names.
5. **Retention** — this pipeline does not delete old backups; configure an R2 lifecycle rule (Cloudflare dashboard, e.g. expire objects after N days/weeks) directly — explicitly citing the ticket's own Non-goals reasoning (dashboard config over app code, "无聊技术栈" spirit).
6. **Secrets reference** — the five names (`DATABASE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`) and that they live in GitHub repo secrets, cross-referenced to `.env.example`'s comment block (§2.4).
7. **Troubleshooting** — what the no-op skip log line (`R2 credentials not configured, skipping backup`) means and how to fix it (provision the missing secret(s)); a one-line pointer to §0.4's pooled-vs-direct-connection nuance in case `pg_dump` fails against a pooled `DATABASE_URL` with a connection/protocol error.

### 2.6 Ticket + sub-PRD writebacks

`docs/prd/07-platform-launch/tickets/PLT-02-backup-pipeline.md` — `## Changelog` entry recording: the `.env.example` comment-block resolution (§2.4/§0.6), the exact Neon endpoint (pooled vs. direct) that ended up working for `pg_dump` once verified (§0.4/§4, per Feedback obligation #2's explicit instruction to record any divergence), and the real `pg_dump`/`aws` CLI versions encountered on the runner if notable. `docs/prd/07-platform-launch/README.md` — mirrored one-paragraph summary, v0.2 → v0.3, following PLT-01's own v0.1 → v0.2 writeback as the direct template.

## 3. Test plan

Maps to the ticket's acceptance checklist; nothing here needs live Neon/R2 credentials (matches every prior ticket's offline-test convention).

1. **`.github/workflows/backup.yml` is valid YAML with a weekly `schedule` trigger — acceptance item 51.** `tests/backup.test.ts`'s first `describe` block (§2.3), following the `tests/toolchain.test.ts` regex-based precedent (§0.3). If the Builder instead adds a real YAML parser (§5 Q2), replace the regex assertion with an actual `parse()` call + structural check on the returned object — either satisfies this acceptance item; record which one was chosen in §2.6's writeback.
2. **No-op behavior when R2 secrets are absent — acceptance item 52.** `tests/backup.test.ts`'s second `describe` block (§2.3), directly spawning `backup.mjs`, matching the exact literal ticket wording ("verified by running the step's logic locally with the env vars unset") and the `deploy-vercel.mjs`/`tests/deploy-vercel.test.ts` precedent (§0.2).
3. **`docs/ops/backup.md` exists and documents both the backup location and a restore command — acceptance item 53.** No automated test is named by the ticket for this item and none is strictly needed (it's a prose/documentation deliverable) — the Builder should nonetheless do a final manual read-through confirming §2.5's two required facts (R2 location, `psql` restore command) are literally present, and may optionally add a trivial existence + substring-grep test (e.g. asserting the file contains `psql` and `R2`) if it wants machine coverage — not mandated.
4. **`pnpm test` green — acceptance item 54.** Full existing suite (all `01-foundation`/`03`.../`07-platform-launch`/PLT-01 tests already merged) must stay green; this ticket adds one new test file and touches no shared config (`vitest.config.ts` unchanged, §0.8), so no regression surface beyond "did the new file parse/run correctly."
5. **`git diff --stat main..HEAD` matches exactly this plan's file list (§1)** — `.github/workflows/backup.yml`, `.github/scripts/backup.mjs`, `tests/backup.test.ts`, `.env.example`, `docs/ops/backup.md`, plus the two ticket/README Changelog writebacks. Nothing under `app/**`, `db/**`, `.github/workflows/ci.yml`, or any `03`–`06` module path.
6. **Real end-to-end backup run — `[human]` acceptance item.** Explicitly out of this ticket's automated test plan; Horace confirms after provisioning real secrets (Feedback obligation #1). Not something the Builder or Reviewer can satisfy.

## 4. Risks & edge cases

- **[Highest priority, correctness] Neon connection-endpoint mismatch (§0.4).** If the real `DATABASE_URL` GitHub Actions secret Horace eventually configures points at Neon's **pooled** (`-pooler`) endpoint, `pg_dump` may fail outright or behave unreliably against PgBouncer's transaction-pooling mode — this is a real, named Neon platform constraint, not speculative. Because this environment has no live `DATABASE_URL` to test against (§0.4), this cannot be resolved by this plan or verified by the Builder's automated tests; it can only surface once Horace runs a real backup (the `[human]` acceptance item) or the Builder is given temporary access to a real connection string to smoke-test manually. **Action for the Builder:** state this explicitly in `docs/ops/backup.md`'s Troubleshooting section (§2.5 item 7) and in the ticket's Feedback obligation #2 writeback (§2.6), so the failure mode is documented *before* it's hit, not discovered cold by Horace during the `[human]` sign-off.
- **[Security-sensitive] Credential handling in `backup.mjs` (§2.2).** `DATABASE_URL` (which may embed a password) and the R2 secret key are passed to child processes exclusively via environment variables, never as literal `execFileSync` arguments and never `console.log`'d — verified in the code sketch (§2.2). GitHub Actions itself additionally masks any string matching a registered `secrets.*` value in step logs, a second independent layer. The Reviewer should confirm the actual implementation preserves both properties (no argv leakage, no accidental echo) — this is exactly the kind of security-sensitive path this repo's pipeline rules call out for explicit Reviewer attention.
- **Concurrency: effectively none.** This is a single scheduled/dispatched job with no shared mutable application state, no new DB writes, no new API routes — lower risk than any ticket touching request-serving code. The one soft concern: if `workflow_dispatch` (manual trigger) is invoked on the same UTC calendar day as the scheduled run, both write to the same `backup-YYYYMMDD.sql.gz` object key in R2, and the second run silently overwrites the first (S3/R2 `cp` has no built-in optimistic-lock/if-not-exists guard). This is **intended, accepted behavior** (idempotent overwrite of "today's backup"), not a bug — noting it here only so it isn't mistaken for a race condition needing a fix.
- **New infra hand-off item not literally named by the ticket's own Feedback obligation list (§0.6/§1):** the workflow needs `DATABASE_URL` configured as a **GitHub Actions repository secret**, in addition to the four `R2_*` ones the ticket explicitly names. The ticket's Feedback obligation #1 only names "Cloudflare R2 bucket creation and GitHub Actions repository secret configuration" in general terms, and #2 is about the connection-string *value*, not the fact that a GH-Actions-specific copy must exist at all — this plan surfaces the DATABASE_URL-as-GH-secret requirement explicitly (§2.1 comment, §2.5 item 6) so it doesn't get silently missed during Horace's provisioning pass.
- **`sh -c` pipeline portability.** `backup.mjs`'s real (non-no-op) branch shells out via `sh -c 'pg_dump ... | gzip > file'`, which requires a POSIX shell — fine on the `ubuntu-latest` GitHub Actions runner (has `/bin/sh`), but this script is not intended to be run locally by Horace on a non-POSIX shell (e.g. plain Windows `cmd`/PowerShell without Git Bash/WSL). `docs/ops/backup.md` should make clear the intended manual-trigger path is the Actions tab's `workflow_dispatch` button (§2.5 item 3), not local execution of `backup.mjs`.
- **`aws` CLI absence is not defensively pre-checked (§0.9's deliberate choice).** If `aws` is genuinely missing from a future runner image, `execFileSync('aws', …)` throws `ENOENT` and the job fails loudly — this is correct fail-closed behavior (a real problem worth Horace/Builder's attention), only reachable once R2 secrets are actually configured (the no-op branch returns before this line otherwise), so it cannot cause a false failure on every ordinary `ci.yml`-triggered push (this workflow never runs on `push`/`pull_request` at all — only `schedule`/`workflow_dispatch`).

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Whether the production `DATABASE_URL` (once Horace provisions it) points at Neon's pooled or direct/unpooled endpoint, and whether `pg_dump` needs a distinct connection string from the app's own `DATABASE_URL` for this reason (§0.4/§4). This plan's position: use `DATABASE_URL` as-is per the ticket's literal instruction; if it turns out to be the pooled endpoint and `pg_dump` fails, provision a second endpoint-specific secret (e.g. `DATABASE_URL_UNPOOLED`) for this workflow only, and record the divergence per Feedback obligation #2. | Builder, once a real `DATABASE_URL` exists to test against — cannot be resolved by static inspection in this offline environment (§0.4). |
| 2 | Whether `tests/backup.test.ts`'s workflow-YAML check should stay regex-based (matching the `tests/toolchain.test.ts` precedent, zero new dependencies) or add the `yaml` npm package for a genuine parse-and-validate check, which more literally satisfies acceptance item 51's "valid YAML" wording (§0.3/§2.3). This plan defaults to regex-based for consistency and minimal footprint but does not forbid the upgrade. | Builder's discretion — low-stakes either way; record whichever was chosen in §2.6's writeback so it's not silently ambiguous later. |
| 3 | Whether appending the four `R2_*` names to `.env.example` as commented-out lines (§2.4) is the right reading of the ticket's Deliverable 1 text, versus FND-09's precedent of not touching `.env.example` at all for CI-only secrets (§0.6). This plan follows the ticket's explicit instruction (append them) over the FND-09 precedent (which the ticket text itself seems to deliberately diverge from), using comment-formatting to preserve the "not a runtime var" distinction the ticket also asks for. | Reviewer, at review time — cheap to confirm or request a format change; not worth blocking the Builder on. |
| 4 | The ticket's own File-scope section (§0's line-by-line reading) does not literally list `.env.example`, `.github/scripts/backup.mjs`, or `tests/backup.test.ts`, even though Deliverable 1/the Test-plan section require them. This is a small ticket-drafting gap (File-scope narrower than Deliverables), not a blocking ambiguity — same class of gap FND-09's plan navigated for `deploy-vercel.mjs`/`tests/deploy-vercel.test.ts`. Flagged here for completeness, not because it changes what the Builder should do. | No action needed; informational only, carried forward in case a future ticket-template pass wants to tighten File-scope/Deliverables consistency checking. |

## 6. ADR-candidate flag

Not proposing a new ADR — PRD §8.2 already names the exact mechanism (GitHub Actions cron + `pg_dump` + Cloudflare R2), and this ticket's job is to wire it, not decide it (matches the ticket header's own "No ADR" statement).

One implementation detail is worth a future ADR pass's awareness without rising to "needs its own ADR file today": **if §5 Q1 resolves in the "pooled endpoint doesn't work, need a second connection-string secret" direction**, that introduces a second, backup-specific `DATABASE_URL`-shaped secret living only in GitHub Actions, never in `.env.example`/Vercel — a small but real bifurcation of "the database connection string" into two independently-configured values for two different consumers (the app vs. this backup job). If a *third* consumer ever needs its own connection-string variant for a different reason, that pattern would be worth writing up properly rather than growing ad hoc — not needed yet, since this ticket, if it hits that branch at all, only introduces the second one.
