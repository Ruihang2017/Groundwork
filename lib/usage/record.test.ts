import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { estimateCostUsd } from '@/lib/config/pricing';
import type { RecordUsageEvent } from '@/lib/usage/record';

// record.ts imports the real `db` from `@/db/index`, which THROWS at import
// time without DATABASE_URL. So record is NEVER statically imported here; every
// access goes through a dynamic import() made AFTER a vi.doMock('@/db/index',
// ...) has swapped in a substitute (+ vi.resetModules() so record re-evaluates
// against the mock). Same pattern as lib/config/quota.test.ts (FND-06).

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  // Apply the real committed migrations (now including §2.4's 0002 migration)
  // through drizzle's own migrator — the same code path production runs.
  await migrate(db, { migrationsFolder: './db/migrations' });
  return db;
}

async function seedUser(db: TestDb, userId: string) {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
}

async function readRow(db: TestDb, userId: string) {
  const [row] = await db
    .select()
    .from(schema.usageEvents)
    .where(eq(schema.usageEvents.userId, userId));
  return row;
}

describe('recordUsage — happy path (PGlite-backed real insert)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    vi.resetModules();
    vi.doMock('@/db/index', () => ({ db }));
  });

  function importRecord() {
    return import('@/lib/usage/record');
  }

  // [acceptance item 1, part 1] costUsd is computed via estimateCostUsd,
  // reusing pricing.test.ts's own hand-verified sonnet5 example.
  it('computes costUsd via estimateCostUsd(sonnet5) from tokensIn/tokensOut/searches', async () => {
    const { recordUsage } = await importRecord();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    await recordUsage({
      userId,
      op: 'read',
      tokensIn: 100_000,
      tokensOut: 20_000,
      searches: 0,
      durationMs: 1500,
    });

    const row = await readRow(db, userId);
    expect(row.costUsd).toBe(0.4);
    expect(row.op).toBe('read');
    expect(row.durationMs).toBe(1500);
  });

  // [acceptance item 2]
  it('defaults droppedCount:0 and status:"success" when omitted', async () => {
    const { recordUsage } = await importRecord();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    await recordUsage({ userId, op: 'tailor', tokensIn: 1, tokensOut: 1, searches: 0, durationMs: 1 });

    const row = await readRow(db, userId);
    expect(row.droppedCount).toBe(0);
    expect(row.status).toBe('success');
  });

  // supplementary — proves explicit values pass through, not just defaults.
  it('forwards explicit droppedCount/status when provided', async () => {
    const { recordUsage } = await importRecord();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    await recordUsage({
      userId,
      op: 'cross',
      tokensIn: 1,
      tokensOut: 1,
      searches: 0,
      durationMs: 1,
      droppedCount: 3,
      status: 'failure',
    });

    const row = await readRow(db, userId);
    expect(row.droppedCount).toBe(3);
    expect(row.status).toBe('failure');
  });

  // [acceptance item 1, part 2 — load-bearing] a caller cannot override
  // costUsd even by smuggling an extra property past TypeScript via a type
  // escape — the production code path always recomputes it.
  it('ignores a smuggled costUsd field and recomputes cost instead', async () => {
    const { recordUsage } = await importRecord();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    const smuggled = {
      userId,
      op: 'tailor',
      tokensIn: 100_000,
      tokensOut: 20_000,
      searches: 0,
      durationMs: 1,
      costUsd: 999_999, // NOT part of RecordUsageEvent — smuggled via the cast below
    } as unknown as RecordUsageEvent;

    await recordUsage(smuggled);

    const row = await readRow(db, userId);
    const expectedCost = estimateCostUsd({
      model: 'sonnet5',
      tokensIn: 100_000,
      tokensOut: 20_000,
      searches: 0,
    });
    expect(row.costUsd).toBe(expectedCost);
    expect(row.costUsd).not.toBe(999_999);
  });
});

describe('recordUsage — DB-insert failure is swallowed, not re-thrown', () => {
  // [acceptance item 3 — load-bearing]
  it('resolves (does not reject) when the insert rejects, and logs via console.error', async () => {
    vi.resetModules();
    const insertError = new Error('simulated insert failure');
    const fakeDb = { insert: () => ({ values: () => Promise.reject(insertError) }) };
    vi.doMock('@/db/index', () => ({ db: fakeDb }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { recordUsage } = await import('@/lib/usage/record');

    await expect(
      recordUsage({ userId: 'u1', op: 'parse', tokensIn: 1, tokensOut: 1, searches: 0, durationMs: 1 }),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
