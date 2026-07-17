import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Repo root, resolved from tests/toolchain.test.ts (one level down).
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

// Regression guard for the FND-01 bounce finding: on the reference dev
// environment (Node 22.11.0 / Corepack 0.29.4) `corepack enable && pnpm install`
// aborts with "Cannot find matching keyid" because the bundled Corepack predates
// the npm registry signing-key rotation and cannot verify the pinned
// pnpm@10.34.5. The scaffold itself is correct — CI provisions pnpm via
// pnpm/action-setup (no Corepack), and the mandated Feedback-obligation writeback
// documents the corrected LOCAL provisioning. These tests lock in the invariants
// that keep that true so a future edit cannot silently reintroduce the break or
// drop the writeback.
describe('toolchain provisioning', () => {
  it('pins packageManager as a fully-qualified pnpm version (what both Corepack and pnpm/action-setup read)', () => {
    const pkg = JSON.parse(read('package.json')) as { packageManager?: string };
    // Must be an exact pnpm@x.y.z pin — a floating/absent pin is what makes
    // Corepack provisioning non-deterministic and un-verifiable.
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('provisions pnpm in CI via pnpm/action-setup, not Corepack (this is why CI is immune to the signing-key friction)', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/pnpm\/action-setup@v\d+/);
    // If CI ever switched to `corepack enable`, it would inherit the same
    // "Cannot find matching keyid" failure the finding describes — forbid it.
    expect(ci).not.toMatch(/corepack\s+enable/);
  });

  it('documents the corrected local pnpm provisioning in the sub-PRD README changelog (Feedback-obligation #1 writeback)', () => {
    const readme = read('docs/prd/01-foundation/README.md');
    // The writeback must survive future edits: it names the failing path
    // (Corepack) and a working alternative (pnpm/action-setup and/or the
    // integrity-key bypass) so downstream Builders aren't blindsided.
    expect(readme).toMatch(/[Cc]orepack/);
    expect(readme).toMatch(/pnpm\/action-setup|COREPACK_INTEGRITY_KEYS|npm i(?:nstall)? -g pnpm/);
  });

  it('records the toolchain deviation as a version bump + changelog in the ticket file (Feedback-obligation #1 writeback)', () => {
    const ticket = read('docs/prd/01-foundation/tickets/FND-01-repo-toolchain-bootstrap.md');
    // version field present and >= 0.2 (initial draft was v0.1, +0.1 for this writeback).
    const m = ticket.match(/^version:\s*([\d.]+)\s*$/m);
    expect(m, 'ticket must carry a version field').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(0.2);
    expect(ticket).toMatch(/## Changelog/);
    expect(ticket).toMatch(/[Cc]orepack/);
  });
});
