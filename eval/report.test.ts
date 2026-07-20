import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { EvalRun } from '@/lib/schemas/persisted';

// EVL-02 Test-plan item 7 — writeEvalRun inserts one eval_runs row matching
// FND-04's EvalRun schema, against a PGlite substitute (FND-05 pattern). report.ts
// reaches db via a dynamic `import('../db/index.ts')`; this test mocks that exact
// relative specifier (same eval/ depth → same resolved module — Risk #2 in the
// plan), following lib/usage/record.test.ts's established doMock + dynamic-import
// approach.

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './db/migrations' });
  return db;
}

describe('writeEvalRun (PGlite-backed real insert)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    vi.resetModules();
    vi.doMock('../db/index.ts', () => ({ db }));
  });

  it('inserts an eval_runs row with suite/op/passRate/details and autogen id/createdAt', async () => {
    const { writeEvalRun } = await import('./report.ts');

    await writeEvalRun('q1', 'read', 0.92, { failures: ['case-3'] });

    const rows = await db.select().from(schema.evalRuns);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row.suite).toBe('q1');
    expect(row.op).toBe('read');
    expect(row.passRate).toBe(0.92);
    expect(row.details).toEqual({ failures: ['case-3'] });
    // id / createdAt auto-populate via Drizzle $defaultFn.
    expect(typeof row.id).toBe('string');
    expect(row.id.length).toBeGreaterThan(0);
    expect(typeof row.createdAt).toBe('number');

    // The persisted row round-trips through FND-04's EvalRun schema.
    expect(() => EvalRun.parse(row)).not.toThrow();
  });

  it('persists distinct rows for q2/q3 suites (append-only report log)', async () => {
    const { writeEvalRun } = await import('./report.ts');

    await writeEvalRun('q2', 'cross', 0.95, { note: 'grounding' });
    await writeEvalRun('q3', 'rehearse', 0.9, { note: 'specificity' });

    const rows = await db.select().from(schema.evalRuns);
    // 1 from the previous test + 2 here (same PGlite instance across the describe).
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.suite).sort()).toEqual(['q1', 'q2', 'q3']);
  });
});
