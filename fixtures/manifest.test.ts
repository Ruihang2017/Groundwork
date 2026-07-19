import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Repo root, resolved from fixtures/manifest.test.ts (one level down) — same
// pattern as tests/toolchain.test.ts / tests/deploy-vercel.test.ts, independent
// of process.cwd() so this test is safe to run from any invocation directory.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

type ManifestEntry = { file: string; category?: string; seniority?: string; label?: string };
type Manifest = { jds: ManifestEntry[]; resumes: ManifestEntry[] };

const manifest: Manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'fixtures', 'manifest.json'), 'utf8'),
);

const readFixture = (relFile: string) => readFileSync(path.join(repoRoot, relFile), 'utf8');

// Mechanical word-count proxy — does not strip markdown syntax (#, -, **); the
// ~2.5x gap between the adversarial-thin threshold (150) and the non-adversarial
// average threshold (400) absorbs that noise. Matches the ticket acceptance
// checklist's own framing ("a mechanical proxy for 极薄").
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

describe('fixtures/manifest.json', () => {
  it('lists exactly 10 JD entries: 5 ai-ml, 3 senior-swe, 2 adversarial', () => {
    expect(manifest.jds).toHaveLength(10);
    const byCategory = (cat: string) => manifest.jds.filter((j) => j.category === cat).length;
    expect(byCategory('ai-ml')).toBe(5);
    expect(byCategory('senior-swe')).toBe(3);
    expect(byCategory('adversarial')).toBe(2);
  });

  it('lists exactly 3 resume entries', () => {
    expect(manifest.resumes).toHaveLength(3);
  });

  it('every file referenced in the manifest exists on disk', () => {
    for (const entry of [...manifest.jds, ...manifest.resumes]) {
      expect(existsSync(path.join(repoRoot, entry.file)), `missing file: ${entry.file}`).toBe(true);
    }
  });

  it('adversarial-thin.md has a substantially shorter word count than the average of the 8 non-adversarial JDs', () => {
    const thinEntry = manifest.jds.find((j) => j.file.endsWith('adversarial-thin.md'));
    expect(thinEntry, 'adversarial-thin.md must be listed in manifest.json').toBeDefined();
    const thinWords = wordCount(readFixture(thinEntry!.file));

    const nonAdversarial = manifest.jds.filter((j) => j.category !== 'adversarial');
    expect(nonAdversarial).toHaveLength(8);
    const avgWords =
      nonAdversarial.reduce((sum, j) => sum + wordCount(readFixture(j.file)), 0) /
      nonAdversarial.length;

    expect(thinWords).toBeLessThan(150);
    expect(avgWords).toBeGreaterThan(400);
    // "substantially shorter than the average" — relative check, not just two
    // independent absolute thresholds.
    expect(thinWords).toBeLessThan(avgWords * 0.5);
  });

  it('at least one resume fixture contains a project entry with an empty metrics representation', () => {
    const hasEmptyMetrics = manifest.resumes.some((r) =>
      /Metrics:\s*none reported/i.test(readFixture(r.file)),
    );
    expect(hasEmptyMetrics).toBe(true);
  });
});
