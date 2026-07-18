import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = path.join(repoRoot, '.github', 'scripts', 'deploy-vercel.mjs');

describe('.github/scripts/deploy-vercel.mjs — CI deploy no-op guard (acceptance item 4)', () => {
  it('exits 0 and logs a clear message when VERCEL_TOKEN is unset (no real deploy attempted)', () => {
    const env = { ...process.env };
    delete env.VERCEL_TOKEN;

    // Runs the exact script the CI workflow invokes, not a re-implementation —
    // satisfies acceptance item 4's "verified by running the workflow's deploy step
    // logic locally with the env var unset". The real-deploy path (token present)
    // is intentionally untested: it needs a live Vercel account (ticket Feedback
    // obligation #2/#3).
    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no VERCEL_TOKEN configured, skipping deploy');
  });
});
