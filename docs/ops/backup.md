# Database backup & restore (ops runbook)

Operator-facing runbook for the weekly Neon → Cloudflare R2 backup pipeline
(PLT-02, PRD §8.2). Audience: Horace / whoever holds the Cloudflare + GitHub
credentials. Everything below is manual ops; nothing here runs from application code.

## Overview

Once a week (`.github/workflows/backup.yml`, Sundays 03:00 UTC) GitHub Actions runs
`pg_dump` against the production Neon database, pipes the output through `gzip`, and
uploads the resulting `backup-YYYYMMDD.sql.gz` to a Cloudflare R2 bucket via the
S3-compatible `aws s3 cp`. It is fully automatic and needs no human action **once the
secrets are provisioned** — until then the workflow no-ops (see Troubleshooting).
Provisioning the real R2 bucket + credentials is a one-time human task (this ticket's
Feedback obligation #1 / module open question #3): agents cannot create Cloudflare
account resources.

## Where backups live

- **Bucket:** the value of the `R2_BUCKET` GitHub Actions secret (ask Horace — the
  real bucket name is not committed anywhere in this repo).
- **Object key format:** `backup-YYYYMMDD.sql.gz` (UTC date of the run), matching
  `fileName` in `.github/scripts/backup.mjs`. The most recent backup is the one with
  the latest date in its key.
- **Browse the bucket** either from the Cloudflare dashboard (R2 → your bucket), or
  from a shell with the same credentials the workflow uses:

  ```sh
  export AWS_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>
  export AWS_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>
  aws s3 ls "s3://<R2_BUCKET>/" --endpoint-url "<R2_ENDPOINT>"
  ```

## Triggering a manual backup

You do not have to wait for the Sunday schedule. The workflow also has a
`workflow_dispatch` trigger: GitHub → **Actions** tab → **Weekly backup** →
**Run workflow**. This is the mechanism for the ticket's `[human]` acceptance item
("confirms one real backup run succeeds end to end") — run it once after provisioning
the secrets and confirm a fresh `backup-YYYYMMDD.sql.gz` appears in the bucket.

> Do **not** try to run `.github/scripts/backup.mjs` on a plain Windows `cmd`/PowerShell
> shell — its real path shells out to `sh -c 'pg_dump ... | gzip > ...'`, which needs a
> POSIX shell. The intended manual path is the Actions **Run workflow** button (which
> runs on `ubuntu-latest`), not local execution.

## Restore procedure

Restore into a **fresh, empty** Neon database, not the live production one (unless you
are deliberately restoring in place — see the warning below).

1. Download the dump you want (pick the desired date):

   ```sh
   export AWS_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>
   export AWS_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>
   aws s3 cp "s3://<R2_BUCKET>/backup-YYYYMMDD.sql.gz" . --endpoint-url "<R2_ENDPOINT>"
   ```

2. Decompress and replay it into the target database with `psql`:

   ```sh
   gunzip -c backup-YYYYMMDD.sql.gz | psql "<TARGET_DATABASE_URL>"
   ```

> **Warning — target must be empty.** The dump is plain-format `pg_dump` output: it
> contains `CREATE TABLE` / `COPY` statements that re-create the schema and data. Replaying
> it against a database that already has the same tables will error or conflict. Point
> `<TARGET_DATABASE_URL>` at a freshly-created, empty Neon database (or branch) unless you
> intend an in-place restore and have accepted the consequences.

## Retention

This pipeline does **not** delete old backups — every weekly run just adds one more
`backup-YYYYMMDD.sql.gz` object. To cap storage/cost, configure an **R2 lifecycle rule**
directly in the Cloudflare dashboard (e.g. expire objects older than N days/weeks). That
is a dashboard task, not application code — per the ticket's own Non-goals ("R2's own
lifecycle rules… are the simplest '无聊技术栈' answer per PRD §8.1's spirit, not
application code").

## Secrets reference

All five values live as **GitHub Actions repository secrets**
(Settings → Secrets and variables → Actions), never in `.env.local` or Vercel:

| Secret | Purpose |
|---|---|
| `DATABASE_URL` | Connection string `pg_dump` dumps from. **Separate** from the app's Vercel `DATABASE_URL` env var — same target database, but each platform's secret store is configured independently. See the Neon endpoint note under Troubleshooting. |
| `R2_ACCESS_KEY_ID` | R2 access key (maps to `AWS_ACCESS_KEY_ID` for `aws s3`). |
| `R2_SECRET_ACCESS_KEY` | R2 secret key (maps to `AWS_SECRET_ACCESS_KEY`). |
| `R2_BUCKET` | Destination bucket name. |
| `R2_ENDPOINT` | R2 account-specific S3 endpoint URL (`https://<accountid>.r2.cloudflarestorage.com`). |

Cross-reference: `.env.example` lists the four `R2_*` names in a commented-out block
labelled as CI-only secrets, so a maintainer skimming `.env.example` sees them but is
told not to put them in `.env.local`.

## Troubleshooting

- **Log line `R2 credentials not configured, skipping backup (missing: …)` and the job
  exits green.** Expected before provisioning — the backup step no-ops (exit 0) whenever
  any of `DATABASE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, or
  `R2_ENDPOINT` is unset, mirroring FND-09's deploy no-op. The bracketed `missing:` list
  names exactly which secret(s) to add. Fix: add the named repository secret(s), then
  re-run.
- **`pg_dump` fails with a connection/protocol error against a `-pooler` host.** Neon
  issues both a **pooled** endpoint (hostname suffixed `-pooler`, PgBouncer in
  transaction-pooling mode) and a **direct/unpooled** endpoint. `pg_dump` should target
  the **direct/unpooled** endpoint — PgBouncer transaction-pooling mode does not support
  all session-level behaviour `pg_dump` relies on. If the `DATABASE_URL` secret you
  configured is the pooled string and `pg_dump` errors, set the GitHub Actions
  `DATABASE_URL` secret for this workflow to the **unpooled** connection string instead
  (it can differ from the app's own pooled runtime `DATABASE_URL` — they are separate
  secret stores). This is unverifiable until a real Neon `DATABASE_URL` exists (ticket
  Feedback obligation #2); record whichever endpoint ended up working in the ticket's
  Changelog when you confirm the first real run.
- **`aws: command not found`.** The `ubuntu-latest` runner ships AWS CLI v2 pre-installed;
  if a future runner image drops it, add an explicit install step before "Run backup".
