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
    expect(workflow).toMatch(/schedule:\s*\n(?:\s*#[^\n]*\n)*\s*- cron:\s*'[^']+'/);
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
