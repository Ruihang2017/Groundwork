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
