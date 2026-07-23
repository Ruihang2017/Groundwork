import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Library, Project } from '@/lib/schemas/entities';

// LIB-03 — TEST-ONLY fixtures. No production component may import this module:
// it reads from disk with `node:fs`, which is fine under Vitest but has no
// business in a client bundle.
//
// The ticket's Test plan requires the mocked PARSE response to be grounded in
// 02-evaluation/EVL-01's real fixture corpus rather than an ad-hoc test object,
// "exercising the same 'at least one metrics-less project' property called out in
// EVL-01's Deliverable 5". So `resumeMd` is the literal text of
// fixtures/resumes/synthetic-junior.md, and the hand-built draft `Library` below
// mirrors what that resume actually contains — including the fact that its second
// project's line reads verbatim "Metrics: none reported", which is exactly the
// empty-metrics case PRD §5.7 asks the UI to flag.
//
// DEVIATION from docs/plans/LIB-03.md §2.10, which said to call `loadFixtures()`
// from `@/eval/fixtures` and asserted (its §0 fact 4) that this works from a
// jsdom-environment test file. It does not, in this toolchain: under Vitest's
// jsdom environment `import.meta.url` is NOT a `file://` URL, so that module's
// top-level `fileURLToPath(new URL('..', import.meta.url))` throws
// `TypeError: The URL must be of scheme file` at import time. Verified by running
// it. The corpus file is therefore read directly here, resolving the repo root by
// walking up from `process.cwd()` for `fixtures/manifest.json` — no
// `import.meta.url`, so this works under both the node and jsdom environments.
// `library-edits.test.ts` (node environment) cross-checks that the text read here
// is byte-identical to what EVL-02's `loadFixtures()` returns, so the two cannot
// silently drift apart.

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(dir, 'fixtures', 'manifest.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'LIB-03 fixtures: could not locate fixtures/manifest.json from ' + process.cwd(),
  );
}

/** EVL-01's junior resume, verbatim. Used as the pass-through `resumeMd`. */
export const RESUME_MD_FIXTURE: string = readFileSync(
  path.join(findRepoRoot(), 'fixtures', 'resumes', 'synthetic-junior.md'),
  'utf8',
);

/**
 * The draft `Library` a correct PARSE of `RESUME_MD_FIXTURE` would produce.
 *
 * MIXED METRICS BY CONSTRUCTION — exactly one of the two projects has
 * `metrics: []`. Every "warns on the right subset only" assertion in this ticket
 * derives its expected set from this data rather than hardcoding names, so a
 * fixture where every project looked alike would make those tests pass for the
 * wrong reason.
 */
export const DRAFT_LIBRARY_FIXTURE: Library = {
  profile: {
    name: 'Jordan Avery',
    headline: 'Junior Software Engineer',
    targetRole: 'Software Engineer',
    contact: { email: 'jordan.avery@example.com', links: ['github.com/example-jordan'] },
  },
  projects: [
    {
      id: 'trailmark',
      name: 'Trailmark — hiking route tracker',
      stage: 'bootcamp capstone',
      role: 'sole developer',
      stack: ['TypeScript', 'React', 'Node.js', 'Express', 'PostgreSQL'],
      summary:
        'Full-stack route and elevation logger. Chose a normalised Postgres schema over a document store because routes and waypoints have a clear relational shape, and added server-side pagination once the seed data grew past a few thousand rows.',
      metrics: ['92% test coverage on the API layer', 'page load under 1.5s on the route list'],
      tags: ['full-stack', 'postgres'],
    },
    {
      id: 'pantry',
      name: 'Pantry — recipe suggestion tool',
      stage: 'personal project',
      role: 'sole developer',
      stack: ['Python', 'Flask', 'SQLite'],
      summary:
        'Suggests recipes from ingredients on hand. Built a scoring function ranking recipes by pantry-item overlap, then refactored nested loops into a single set-intersection pass once it got hard to follow.',
      // The resume literally says "Metrics: none reported" — the empty-metrics
      // state PRD §5.6 calls "合法且被显式展示".
      metrics: [],
      tags: ['python', 'side-project'],
    },
  ],
};

/** The shape `POST /api/parse` returns on success (`lib/parse/schema.ts`). */
export const PARSE_OK_FIXTURE = {
  resumeMd: RESUME_MD_FIXTURE,
  draftLibrary: DRAFT_LIBRARY_FIXTURE,
};

const EXTRA_PROJECT: Project = {
  id: 'admin-dashboard',
  name: 'Internal admin dashboard',
  stage: 'internship',
  role: 'engineering intern',
  stack: ['JavaScript', 'React'],
  summary: 'Shipped bug fixes and small features under senior review; wrote the first automated tests in the codebase.',
  metrics: [],
  tags: ['internship'],
};

/** 3 projects, 2 of them metrics-less — drives the banner's plural tally. */
export const THREE_PROJECT_FIXTURE: Library = {
  profile: DRAFT_LIBRARY_FIXTURE.profile,
  projects: [...DRAFT_LIBRARY_FIXTURE.projects, EXTRA_PROJECT],
};

/** Every project has metrics — the banner must render nothing for this one. */
export const ALL_METRICS_FIXTURE: Library = {
  profile: DRAFT_LIBRARY_FIXTURE.profile,
  projects: DRAFT_LIBRARY_FIXTURE.projects.map((project) =>
    project.metrics.length > 0
      ? project
      : { ...project, metrics: ['cut the ranking pass from 4s to 0.4s'] },
  ),
};
