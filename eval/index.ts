// EVL-02 barrel export. Consumed via the normal `@/eval` alias from within the
// Next.js app / Vitest (where alias resolution is not a concern) — this satisfies
// the Goal's literal example: `import { assertQ1Schema, ..., assertQ2Grounded,
// assertQ3Specific } from '@/eval'`.
//
// Re-exports use relative + explicit `.ts` extensions (docs/plans/EVL-02.md §2.1)
// so this barrel itself stays plain-Node-loadable if a future file ever imports
// through it rather than the concrete sibling files directly.

export { loadFixtures } from './fixtures.ts';
export type { FixtureJd, FixtureResume } from './fixtures.ts';

export { judgeCall } from './judge.ts';
export type { JudgeVerdict, JudgeCallOptions } from './judge.ts';

export {
  assertQ1Schema,
  assertQ1Coverage,
  assertQ1Questions,
  assertQ1NumberIntegrity,
  assertQ1DroppedRate,
} from './assertions/q1.ts';

export { assertQ2Grounded, assertQ2GroundedBatch } from './assertions/q2.ts';
export type { Q2JudgeOptions } from './assertions/q2.ts';

export { assertQ3Specific, assertQ3SpecificBatch } from './assertions/q3.ts';
export type { Q3JudgeOptions } from './assertions/q3.ts';

export { writeEvalRun } from './report.ts';

export { runSuite } from './run-suite.ts';
export type { RunSuiteInput, RunSuiteResult, Q1Case, Q1Result } from './run-suite.ts';
