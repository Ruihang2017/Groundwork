import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// EVL-02 Test-plan item 10 — `pnpm eval` self-check runs as a subprocess and
// exits 0. ANTHROPIC_API_KEY and DATABASE_URL are explicitly stripped from the
// child env: that is what actually proves Deliverable 7's "no real API calls, no
// real stage output wired in" claim, rather than merely happening to pass because
// the ambient env lacks them.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('pnpm eval self-check (subprocess)', () => {
  it('exits 0 and prints a passing report with no ANTHROPIC_API_KEY / DATABASE_URL', () => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.DATABASE_URL;

    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'eval.mjs')], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK\s+Q1/);
    expect(result.stdout).toMatch(/eval self-check: PASS/);
  }, 30_000);
});
