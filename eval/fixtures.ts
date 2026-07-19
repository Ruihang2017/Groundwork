import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// EVL-02 Deliverable 1 — fixture loader over EVL-01's `fixtures/**` corpus.
//
// IMPORT-STYLE NOTE (applies to every non-test file under eval/**): this module
// and its siblings are reachable from `scripts/eval.mjs`'s self-check path, which
// runs them under plain `node --experimental-strip-types` (no bundler, no `@/*`
// alias resolver). See docs/plans/EVL-02.md §2.1. This file only imports Node
// builtins, so it is trivially plain-Node-safe with nothing further required.

export type FixtureJd = { id: string; category: string; text: string };
export type FixtureResume = { id: string; seniority: string; text: string };

type ManifestJdEntry = { file: string; category: string; label?: string };
type ManifestResumeEntry = { file: string; seniority: string };
type Manifest = { jds: ManifestJdEntry[]; resumes: ManifestResumeEntry[] };

// Repo root: eval/fixtures.ts is one level below root, the same depth as
// fixtures/manifest.test.ts (EVL-01), which resolves the root identically —
// independent of process.cwd() so this is safe from any invocation directory.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// The manifest carries only `file` + `category`/`seniority` (+ a `label`) — no
// `id`/`text`. This loader derives `id` from the file's basename and reads the
// referenced markdown for `text`, matching the shape EVL-02's Goal names.
export function loadFixtures(): { jds: FixtureJd[]; resumes: FixtureResume[] } {
  const manifest: Manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'fixtures', 'manifest.json'), 'utf8'),
  );

  const jds: FixtureJd[] = manifest.jds.map((entry) => ({
    id: path.basename(entry.file, '.md'),
    category: entry.category,
    text: readFileSync(path.join(repoRoot, entry.file), 'utf8'),
  }));

  const resumes: FixtureResume[] = manifest.resumes.map((entry) => ({
    id: path.basename(entry.file, '.md'),
    seniority: entry.seniority,
    text: readFileSync(path.join(repoRoot, entry.file), 'utf8'),
  }));

  return { jds, resumes };
}
