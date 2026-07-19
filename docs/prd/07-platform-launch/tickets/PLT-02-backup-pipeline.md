---
id: PLT-02
title: Weekly backup pipeline
module: 07-platform-launch
lane: 07-platform-launch
size: S
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-05]
blocks: []
---

# PLT-02 — Weekly backup pipeline

No ADR — the decision is already made in PRD §8.2 (architecture diagram: "每周 `pg_dump`（GitHub Actions cron）→ Cloudflare R2"); this is build ticket 2 of 4 against the `07-platform-launch` module.
Parent sub-PRD: [07-platform-launch README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-05 — Drizzle schema, Neon Postgres client, and migrations](../../01-foundation/tickets/FND-05-drizzle-schema-neon.md)
**Why `builder`:** wiring a documented cron/backup mechanism (GitHub Actions + `pg_dump` + R2) against an already-provisioned database — no open design.

## Background + basis

PRD §8.2 architecture diagram, quoted verbatim (the relevant fragment): "Drizzle ORM ──► Neon Postgres └─ 每周 `pg_dump`（GitHub Actions cron）→ Cloudflare R2". PRD §5.6: "库为资产" (the library is an asset) — backups exist specifically to protect this asset (and all other user data) against accidental loss, consistent with PRD §12's risk table implicitly (backup isn't listed as a named risk mitigation row itself, but is the standing infrastructure practice named in §8.2 for "无聊技术栈" durability).

PRD §8.1: "固定成本：Vercel Hobby / Neon / Resend / R2 免费额度内 = $0" — R2's free tier is assumed sufficient for weekly backups of a v1-scale database; this ticket does not need to provision paid R2 storage.

## Goal

`.github/workflows/backup.yml` — a scheduled (weekly) GitHub Actions workflow that runs `pg_dump` against the production `DATABASE_URL` and uploads the resulting dump to a Cloudflare R2 bucket, plus `docs/ops/backup.md` documenting the restore procedure for a human operator.

## Non-goals

- No automated restore testing/drill — PRD names the backup mechanism, not a restore-verification requirement; a documented manual restore procedure (Deliverable 2) is this ticket's full scope. Automating restore drills is a reasonable future hardening step but not named in PRD, not added here.
- No point-in-time recovery / continuous backup — PRD specifically says "每周" (weekly); this ticket does not build anything more frequent or granular.
- No R2 bucket provisioning — creating the actual Cloudflare R2 bucket and its access credentials requires Horace's Cloudflare account (see Feedback obligation), same pattern as other infra hand-offs across this plan.

## File-scope (write-owns)

- `.github/workflows/backup.yml`
- `docs/ops/backup.md`
- Does not touch: `.github/workflows/ci.yml` (FND-01/FND-09, a separate workflow file — this ticket creates a new, independent workflow file, not an edit to the existing CI/deploy one).
- Serial-safety: `01-foundation` fully merged before this ticket starts. No dependency on/from `03`–`06`; may run in parallel with them (per `07-platform-launch/README.md`).

## Deliverables

1. `.github/workflows/backup.yml` — triggered on a weekly `schedule` cron expression, steps: checkout, install `pg_dump`-compatible Postgres client tooling, run `pg_dump "$DATABASE_URL" | gzip > backup-$(date +%Y%m%d).sql.gz` (or the Neon-recommended equivalent connection-string-based dump command), upload the resulting file to a Cloudflare R2 bucket via `aws s3 cp` (R2 is S3-API-compatible) or the `rclone`/Cloudflare-native action, using `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET`/`R2_ENDPOINT` secrets (append these placeholder names to `.env.example` and document them as GitHub Actions repository secrets, NOT as `.env.example` runtime values, since they're CI-only — note this distinction explicitly in the workflow file's comments so a future maintainer doesn't confuse repository secrets with the app's own runtime env vars). The workflow no-ops gracefully (logs "R2 credentials not configured, skipping backup" and exits 0) when the secrets are absent, mirroring `01-foundation`/FND-09's deploy-step no-op pattern, so this workflow doesn't hard-fail in CI before Horace provisions R2.
2. `docs/ops/backup.md` — human-readable restore procedure: how to locate the latest dump in R2, how to restore it into a fresh Neon database (`psql` restore command), and a note on retention (this ticket does not implement automatic old-backup deletion/lifecycle policy — R2's own lifecycle rules, configured by Horace directly in the Cloudflare dashboard, are the simplest "无聊技术栈" answer per PRD §8.1's spirit, not application code).

## Acceptance checklist (classified)

- [ ] `[machine]` `.github/workflows/backup.yml` is valid YAML with a weekly `schedule` trigger (parsed/asserted the same way FND-01's CI workflow validity was checked).
- [ ] `[machine]` The workflow's backup step no-ops (exits 0, logs a clear skip message) when R2 secrets are absent — verified by running the step's logic locally with the env vars unset, same pattern as FND-09's deploy no-op test.
- [ ] `[machine]` `docs/ops/backup.md` exists and documents both the backup location and a restore command.
- [ ] `[machine]` `pnpm test` green (no new application-code tests are strictly needed for this ticket since it's pure CI/ops config — this item confirms the ticket didn't accidentally break anything else).
- [ ] `[human]` Horace provisions the real Cloudflare R2 bucket and GitHub Actions repository secrets, then confirms one real backup run succeeds end to end before P5 sign-off — agents cannot self-provision Cloudflare account resources (see Feedback obligation).

## Test plan

Local execution of the backup step's shell logic (extracted into a script the workflow calls, so it's testable outside the GitHub Actions runner) with R2 env vars unset, asserting the no-op/skip behavior and exit code 0. YAML validity check on the workflow file itself. No real `pg_dump`/R2 upload is exercised in automated tests (would require live infra); the `[human]` item covers the real end-to-end run.

## Feedback obligation

1. General rule: real Cloudflare R2 bucket creation and GitHub Actions repository secret configuration require Horace's Cloudflare account access — carried forward as this module's open question #3 (`07-platform-launch/README.md`), same family as the Vercel/Neon/Auth.js infra hand-offs flagged throughout `01-foundation`.
2. If Neon's specific connection-pooling mode (transaction vs. session pooler) affects which `pg_dump` invocation actually works, that is a detail this ticket's Builder must verify against Neon's own current documentation at implementation time (Neon's pooling behavior is a platform detail that may have changed since PRD's 2026-07 pricing/config check) — record any divergence from the assumed plain `pg_dump "$DATABASE_URL"` invocation directly in this ticket's Deliverable 1, don't silently work around it in a way that isn't visible to whoever reads this ticket later.

## Changelog

- v0.1 (2026-07-19, PLT-02 Builder writeback): initial implementation of Deliverables 1–2, following `docs/plans/PLT-02.md`. Full suite green — **278 tests, 29 files** (4 new in `tests/backup.test.ts`); no new production/runtime dependency added (`package.json`/`pnpm-lock.yaml` untouched — `backup.mjs` shells out to `pg_dump`/`aws` binaries, not npm packages). Files added: `.github/workflows/backup.yml`, `.github/scripts/backup.mjs` (no-op-guard pattern mirroring FND-09's `deploy-vercel.mjs`), `tests/backup.test.ts`, `docs/ops/backup.md`; `.env.example` appended. Load-bearing decisions and deviations:
  - **`.github/scripts/backup.mjs` + `tests/backup.test.ts` + `.env.example` are not literally in the ticket's File-scope list** (which names only `backup.yml` + `backup.md`), but all three are required by the ticket's own Test-plan sentence ("extracted into a script the workflow calls, so it's testable outside the GitHub Actions runner") and Deliverable 1 ("append these placeholder names to `.env.example`"). Same File-scope-narrower-than-Deliverables gap FND-09's plan navigated for `deploy-vercel.mjs`/its test. Recorded here rather than silently expanded.
  - **Workflow-YAML validity check is regex/substring-based, not a real YAML parser (plan §5 Q2 — Builder's discretion, chose regex).** No `yaml`/`js-yaml` package is installed in this repo and adding one for a single structural assertion isn't warranted; the check follows the existing `tests/toolchain.test.ts` precedent for `ci.yml`. Accepted, documented gap: a stray unbalanced quote elsewhere in the file could pass the regex while being invalid YAML — same class of gap `toolchain.test.ts` already accepts.
  - **Deviation from plan §2.3's literal regex.** The plan sketched `/schedule:\s*\n\s*- cron:\s*'[^']+'/`, which assumes `- cron:` immediately follows `schedule:`. The plan's own `backup.yml` sketch (§2.1) places two explanatory comment lines between `schedule:` and `- cron:`, so that regex would never match the file the plan itself specifies (false-red). Used a comment-tolerant variant — `/schedule:\s*\n(?:\s*#[^\n]*\n)*\s*- cron:\s*'[^']+'/` — same intent (a cron expression nested under `schedule:`), correct against the actual file. Verified green.
  - **`.env.example` append is commented-out (plan §2.4 / §5 Q3).** The four `R2_*` keys are added as `#`-prefixed lines under a labelled comment block, unlike the file's existing bare `KEY=` runtime lines — a typographic distinction reinforcing "these are CI-only GitHub Actions secrets, not `.env.local` values." Satisfies Deliverable 1's literal "append these placeholder names" while honoring its "document them as CI-only, NOT runtime" instruction. This deliberately diverges from FND-09's precedent (which omitted `VERCEL_*` from `.env.example` entirely) because PLT-02's ticket text explicitly instructs the append — flagged for the Reviewer; a future ticket should not assume this choice generalizes.
  - **DATABASE_URL is also a GitHub Actions repo secret (not literally in the ticket's Feedback-obligation list).** `pg_dump` needs a connection string, so the workflow reads `DATABASE_URL` from `secrets.DATABASE_URL` — a separate configuration surface from the app's own Vercel `DATABASE_URL` env var. Surfaced explicitly in `backup.yml`'s comments, `.env.example`, and `docs/ops/backup.md` §Secrets so it isn't missed during Horace's provisioning pass.
  - **Feedback obligation #2 (Neon pooled-vs-direct endpoint) — NOT resolvable offline; documented, not worked around.** No real `DATABASE_URL` exists in this environment (Neon provisioning is still a `[human]` item), so which endpoint `pg_dump` needs cannot be verified now. `backup.mjs` uses `DATABASE_URL` as-is per the ticket's literal instruction. The failure mode (pooled `-pooler`/PgBouncer transaction-pooling may not support `pg_dump`'s session-level needs → use the direct/unpooled endpoint for this workflow's secret) is documented up front in `docs/ops/backup.md`'s Troubleshooting section, so Horace hits documentation, not a cold failure, during the `[human]` end-to-end run. Whichever endpoint ends up working must be recorded here when that run happens.
  - **Real backup/upload path (`pg_dump | gzip` → `aws s3 cp`) is intentionally untested by automation** — needs a live `DATABASE_URL` + real R2 credentials, neither available here (same untested-real-path pattern as `deploy-vercel.mjs`'s real deploy call). Only the no-op/skip branch is machine-tested. Credentials are passed to child processes exclusively via environment variables (never argv, never logged), preserving the security property the plan §4 calls out for Reviewer attention.
  - **`[human]` acceptance item remains open:** Horace must provision the real Cloudflare R2 bucket + the five GitHub Actions repository secrets, then trigger one real run (Actions tab → Weekly backup → Run workflow, via the `workflow_dispatch` trigger) and confirm it succeeds end to end before P5 sign-off.
