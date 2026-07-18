#!/usr/bin/env node
// Invoked by .github/workflows/ci.yml's "Deploy to Vercel" step (FND-09
// Deliverable 5). No-ops gracefully (exit 0, no error) when VERCEL_TOKEN is unset —
// real Vercel project creation/secrets are Horace's manual task (ticket Feedback
// obligation #2), so this step must never hard-fail CI before that happens.
// Extracted to a standalone script (not inline YAML) specifically so the no-op path
// is directly, deterministically unit-testable — see tests/deploy-vercel.test.ts.
//
// Security: the token is passed as a CLI argument to `vercel` and is NEVER logged;
// do not add debug logging that echoes process.env here or in the test.
import { execFileSync } from 'node:child_process';

const token = process.env.VERCEL_TOKEN;

if (!token) {
  console.log('no VERCEL_TOKEN configured, skipping deploy');
  process.exit(0);
}

// Exact version pinned (no floating @latest) matching this repo's
// dependency-pinning convention. Current stable `vercel` CLI at build time:
// 56.3.1 (verified via `npm view vercel version`, 2026-07-18). This path only runs
// once Horace supplies VERCEL_TOKEN (Feedback obligation #2/#3) — untested here.
execFileSync(
  'npx',
  ['--yes', 'vercel@56.3.1', 'deploy', '--prod', '--token', token, '--yes'],
  { stdio: 'inherit' },
);
