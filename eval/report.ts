import type { EvalSuite, UsageOp } from '../lib/schemas/persisted.ts';

// EVL-02 Deliverable 6 — the report writer. Inserts one `eval_runs` row via
// FND-05's `db` client (schema/shape from FND-04). See docs/plans/EVL-02.md §2.7.
//
// PLAIN-NODE NOTE (§2.1): `db`/`evalRuns` are reached only through LAZY dynamic
// imports inside writeEvalRun — db/index.ts imports the neon driver and throws at
// import time without DATABASE_URL, and its own `import * as schema from './schema'`
// is extensionless (unresolvable under plain Node). Deferring them means merely
// loading this module (e.g. via run-suite.ts on the self-check path) never touches
// either. This mirrors the repo's existing test pattern for db-touching modules
// (lib/usage/record.test.ts mocks a dynamically-substituted db/index).
//
// Unlike recordUsage() (FND-10), writeEvalRun DELIBERATELY does NOT swallow its
// own insert error: it runs in a CI/quality-gate context (`pnpm eval`) where a
// report failing to persist is itself a signal worth surfacing loudly, not a
// user-facing request that must degrade rather than block.
export async function writeEvalRun(
  suite: EvalSuite,
  op: UsageOp,
  passRate: number,
  details: Record<string, unknown>,
): Promise<void> {
  const { db } = await import('../db/index.ts');
  const { evalRuns } = await import('../db/schema.ts');
  // `id`/`createdAt` auto-generate via Drizzle's $defaultFn (db/schema.ts).
  await db.insert(evalRuns).values({ suite, op, passRate, details });
}
