#!/usr/bin/env node
// Invoked by .github/workflows/backup.yml's "Run backup" step (PLT-02 Deliverable 1).
// No-ops gracefully (exit 0, no error) when any required credential is unset — real
// Cloudflare R2 bucket/secret provisioning is Horace's manual task (ticket Feedback
// obligation #1), so this step must never hard-fail CI before that happens. Extracted
// to a standalone script (not inline YAML) specifically so its logic is directly,
// deterministically unit-testable — see tests/backup.test.ts. Mirrors
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
//
// Fail-closed guarantees (PLT-02 Reviewer bounce — plan §4's "fail-closed" principle):
//   1. The dump runs under `bash -o pipefail` so a pg_dump failure (auth error,
//      unreachable host, mid-stream disconnect / truncated dump, or Neon pooler
//      protocol failure) propagates as a non-zero pipeline status. Without pipefail a
//      POSIX pipeline reports only gzip's exit status, so a failed pg_dump would still
//      exit 0 and a structurally-valid-but-empty .sql.gz would be uploaded while the
//      workflow went green — silent backup corruption. bash (not sh) is used because
//      GitHub's ubuntu-latest runner guarantees bash, whereas its /bin/sh is dash,
//      whose older builds lack `set -o pipefail`.
//   2. As defense-in-depth, the gzipped dump's size is checked before upload; an
//      empty/near-empty archive aborts the run rather than being uploaded.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ENV = [
  'DATABASE_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENDPOINT',
];

// gzip of empty input is 20 bytes; a real pg_dump — even of an empty database —
// emits a multi-line header/footer that gzips to well over 100 bytes. A dump at or
// below this bound means pg_dump produced essentially nothing, so the archive is
// rejected before upload. This is a secondary guard: the primary guard against a
// *failed* pg_dump is `set -o pipefail` in dumpCommand() below.
export const MIN_BACKUP_BYTES = 64;

export function backupFileName(date = new Date()) {
  const stamp = date.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  return `backup-${stamp}.sql.gz`;
}

// Plain-format pg_dump piped through gzip — matches the ticket's own literal example
// command (no -Fc custom format), so restore is a single `gunzip | psql`
// (docs/ops/backup.md), no pg_restore step to document.
//
// `set -o pipefail` is the load-bearing fix: it makes the pipeline exit non-zero when
// pg_dump fails, instead of masking the failure behind gzip's success (a POSIX
// pipeline otherwise reports only the last command's status). Run under `bash`, not
// `sh`, because pipefail is not portable to dash (ubuntu-latest's /bin/sh).
//
// DATABASE_URL and the output filename are passed via shell variable expansion
// ($DATABASE_URL / $BACKUP_FILE), NOT interpolated into the command string or passed
// as argv, keeping the connection string (which may embed a password) out of
// argv/process-listing visibility.
export function dumpCommand(fileName) {
  return {
    command: 'bash',
    args: ['-c', 'set -o pipefail; pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"'],
    env: { DATABASE_URL: process.env.DATABASE_URL, BACKUP_FILE: fileName },
  };
}

// R2 is S3-API-compatible (ticket Deliverable 1) — `aws s3 cp` against R2's
// account-specific endpoint. Credentials are supplied via env (same argv-avoidance
// rationale). AWS_DEFAULT_REGION is set to 'auto' because GitHub-hosted runners have
// no ambient AWS region and AWS CLI v2 hard-fails ("You must specify a region") when
// none resolves; Cloudflare's R2 S3-compat docs prescribe region 'auto'.
export function uploadCommand(fileName, env = process.env) {
  return {
    command: 'aws',
    args: [
      's3',
      'cp',
      fileName,
      `s3://${env.R2_BUCKET}/${fileName}`,
      '--endpoint-url',
      env.R2_ENDPOINT,
    ],
    env: {
      AWS_DEFAULT_REGION: 'auto',
      AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    },
  };
}

// Returns the process exit code. Throws on any dump/upload/integrity failure so the
// workflow fails loudly (fail-closed) instead of reporting a false success.
export function runBackup() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    // Exact phrase from the ticket's Deliverable 1 ("R2 credentials not configured,
    // skipping backup") is preserved verbatim so any consumer asserting on that
    // literal substring matches regardless of which specific var(s) are missing;
    // the bracketed list is an additive debugging aid, not a replacement.
    console.log(
      `R2 credentials not configured, skipping backup (missing: ${missing.join(', ')})`,
    );
    return 0;
  }

  const fileName = backupFileName();

  const dump = dumpCommand(fileName);
  execFileSync(dump.command, dump.args, {
    stdio: 'inherit',
    env: { ...process.env, ...dump.env },
  });

  // Integrity guard: never upload an empty/near-empty archive. pipefail already fails
  // the run on a pg_dump *error*; this additionally catches a pg_dump that exits 0
  // having written no data (the "structurally valid but empty gzip" case).
  const { size } = statSync(fileName);
  if (size < MIN_BACKUP_BYTES) {
    throw new Error(
      `backup aborted: ${fileName} is ${size} bytes (< ${MIN_BACKUP_BYTES}); ` +
        'pg_dump produced no usable output — refusing to upload an empty backup',
    );
  }

  const upload = uploadCommand(fileName);
  execFileSync(upload.command, upload.args, {
    stdio: 'inherit',
    env: { ...process.env, ...upload.env },
  });

  console.log(`backup uploaded: ${fileName} (${size} bytes)`);
  return 0;
}

// Run only when executed directly (`node backup.mjs`), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(runBackup());
  } catch (error) {
    // Fail-closed: surface the message and exit non-zero so the workflow goes red.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
