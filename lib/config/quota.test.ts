import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import * as schema from '@/db/schema';
import type { UsageOp } from '@/lib/schemas/persisted';

// quota.ts imports the real `db` from `@/db/index`, which THROWS at import time
// without DATABASE_URL. Tests must never let that real module load — so quota is
// NEVER statically imported here; every access goes through a dynamic import()
// made AFTER a vi.doMock('@/db/index', ...) has swapped in a PGlite-backed
// Drizzle client (+ vi.resetModules() so quota re-evaluates against the mock).
// This is the "reset the module registry so import-time code re-runs" pattern
// established by db/index.test.ts (FND-05), extended to swap the implementation.

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  // Apply the real committed migration through drizzle's own migrator — the
  // same code path production runs (see db/migrate.test.ts Tier 3).
  await migrate(db, { migrationsFolder: './db/migrations' });
  return db;
}

async function seedUser(db: TestDb, userId: string) {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com` });
}

// Inserts one usage_events row. Caller must have already seeded the user (FK).
async function seedUsageEvent(
  db: TestDb,
  opts: { userId: string; op: UsageOp; createdAt: number; costUsd?: number },
) {
  await db.insert(schema.usageEvents).values({
    userId: opts.userId,
    op: opts.op,
    tokensIn: 100,
    tokensOut: 100,
    searches: 0,
    costUsd: opts.costUsd ?? 0.01,
    durationMs: 1000,
    createdAt: opts.createdAt,
  });
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Local duplicate of quota.ts's (unexported) day-boundary helper, so the tests
// compute "today"/"yesterday" the exact same way the production code does,
// rather than hardcoding a literal that would flake near midnight UTC.
function startOfTodayUtcMs(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// -----------------------------------------------------------------------------
// checkAndIncrementQuota — one shared PGlite for the block; each it() uses a
// fresh random userId (the function's own query is userId-scoped, so distinct
// users give full test-to-test isolation without truncating between tests).
// -----------------------------------------------------------------------------
describe('checkAndIncrementQuota', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    vi.resetModules();
    vi.doMock('@/db/index', () => ({ db }));
  });

  function importQuota() {
    return import('@/lib/config/quota');
  }

  // [acceptance item 2] at the cap → allowed:false, remaining:0.
  it('returns allowed:false, remaining:0 once DAILY_QUOTA[op] rows exist today', async () => {
    const { checkAndIncrementQuota, DAILY_QUOTA } = await importQuota();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);
    const today = startOfTodayUtcMs();
    for (let i = 0; i < DAILY_QUOTA.tailor; i++) {
      await seedUsageEvent(db, { userId, op: 'tailor', createdAt: today });
    }

    const result = await checkAndIncrementQuota(userId, 'tailor');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  // [acceptance item 2] one under the cap → allowed:true, remaining:1.
  it('returns allowed:true, remaining:1 with one fewer than the cap', async () => {
    const { checkAndIncrementQuota, DAILY_QUOTA } = await importQuota();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);
    const today = startOfTodayUtcMs();
    for (let i = 0; i < DAILY_QUOTA.tailor - 1; i++) {
      await seedUsageEvent(db, { userId, op: 'tailor', createdAt: today });
    }

    const result = await checkAndIncrementQuota(userId, 'tailor');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  // [acceptance item 3] yesterday's rows must not count toward today's quota.
  it('does not count rows from a previous UTC day', async () => {
    const { checkAndIncrementQuota, DAILY_QUOTA } = await importQuota();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);
    const yesterday = startOfTodayUtcMs() - 1; // 1ms before today's UTC midnight
    for (let i = 0; i < DAILY_QUOTA.tailor; i++) {
      await seedUsageEvent(db, { userId, op: 'tailor', createdAt: yesterday });
    }

    const result = await checkAndIncrementQuota(userId, 'tailor');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(DAILY_QUOTA.tailor); // none of yesterday's rows count
  });

  // resetAt is start-of-tomorrow (UTC), asserted against a locally recomputed
  // boundary rather than a hardcoded literal.
  it('reports resetAt as the start of tomorrow (UTC)', async () => {
    const { checkAndIncrementQuota } = await importQuota();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    const result = await checkAndIncrementQuota(userId, 'fit');
    expect(result.resetAt).toBe(startOfTodayUtcMs() + ONE_DAY_MS);
  });

  // [supplementary — proves the §2.3 mapping] fit counts op='read' ONLY, not
  // op='cross': one completed Fit action writes both, but is one quota charge.
  it("counts fit against op='read' only, not double-counting the paired 'cross' row", async () => {
    const { checkAndIncrementQuota, DAILY_QUOTA } = await importQuota();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);
    const today = startOfTodayUtcMs();
    await seedUsageEvent(db, { userId, op: 'read', createdAt: today });
    await seedUsageEvent(db, { userId, op: 'cross', createdAt: today });

    const result = await checkAndIncrementQuota(userId, 'fit');
    // Exactly ONE action counted, not two.
    expect(result.remaining).toBe(DAILY_QUOTA.fit - 1);
    expect(result.allowed).toBe(true);
  });

  // [supplementary — same rationale] prep counts op='research' ONLY, not
  // op='rehearse'.
  it("counts prep against op='research' only, not double-counting the paired 'rehearse' row", async () => {
    const { checkAndIncrementQuota, DAILY_QUOTA } = await importQuota();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);
    const today = startOfTodayUtcMs();
    await seedUsageEvent(db, { userId, op: 'research', createdAt: today });
    await seedUsageEvent(db, { userId, op: 'rehearse', createdAt: today });

    const result = await checkAndIncrementQuota(userId, 'prep');
    expect(result.remaining).toBe(DAILY_QUOTA.prep - 1);
    expect(result.allowed).toBe(true);
  });

  // Baseline/empty-state: a user with zero rows has full quota for every bucket.
  it('reports full remaining quota for a user with no usage rows', async () => {
    const { checkAndIncrementQuota, DAILY_QUOTA } = await importQuota();
    const userId = crypto.randomUUID();
    await seedUser(db, userId);

    for (const op of ['fit', 'tailor', 'prep'] as const) {
      const result = await checkAndIncrementQuota(userId, op);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(DAILY_QUOTA[op]);
    }
  });
});

// -----------------------------------------------------------------------------
// checkGlobalBreaker — sums costUsd across ALL users (no userId filter), so it
// gets a FRESH PGlite per it() to stop one test's spend leaking into another.
// -----------------------------------------------------------------------------
describe('checkGlobalBreaker', () => {
  const ORIGINAL_LIMIT = process.env.GLOBAL_DAILY_SPEND_LIMIT_USD;
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    vi.resetModules();
    vi.doMock('@/db/index', () => ({ db }));
  });

  afterEach(() => {
    if (ORIGINAL_LIMIT === undefined) delete process.env.GLOBAL_DAILY_SPEND_LIMIT_USD;
    else process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = ORIGINAL_LIMIT;
  });

  function importQuota() {
    return import('@/lib/config/quota');
  }

  // Seeds one fresh user + one usage event of the given cost.
  async function seedSpend(cost: number, createdAt: number = startOfTodayUtcMs()) {
    const userId = crypto.randomUUID();
    await seedUser(db, userId);
    await seedUsageEvent(db, { userId, op: 'tailor', createdAt, costUsd: cost });
  }

  // [acceptance item 4] unset env → throws (never a silent tripped:false).
  it('throws if GLOBAL_DAILY_SPEND_LIMIT_USD is unset', async () => {
    delete process.env.GLOBAL_DAILY_SPEND_LIMIT_USD;
    const { checkGlobalBreaker } = await importQuota();
    await expect(checkGlobalBreaker()).rejects.toThrow(/GLOBAL_DAILY_SPEND_LIMIT_USD/);
  });

  // [supplementary — Deliverable 3 "or non-numeric"] non-numeric env → throws.
  it('throws if GLOBAL_DAILY_SPEND_LIMIT_USD is non-numeric', async () => {
    process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = 'not-a-number';
    const { checkGlobalBreaker } = await importQuota();
    await expect(checkGlobalBreaker()).rejects.toThrow(/GLOBAL_DAILY_SPEND_LIMIT_USD/);
  });

  // [supplementary — the Number('') === 0 pitfall] empty-string env → throws
  // (proves the explicit .trim() === '' guard is load-bearing, not redundant).
  it('throws if GLOBAL_DAILY_SPEND_LIMIT_USD is an empty string', async () => {
    process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = '';
    const { checkGlobalBreaker } = await importQuota();
    await expect(checkGlobalBreaker()).rejects.toThrow(/GLOBAL_DAILY_SPEND_LIMIT_USD/);
  });

  // Under the limit → tripped:false, correct spend sum across users.
  it('sums today spend across all users and reports tripped:false under the limit', async () => {
    process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = '10';
    await seedSpend(2);
    await seedSpend(3);

    const { checkGlobalBreaker } = await importQuota();
    const result = await checkGlobalBreaker();
    expect(result).toEqual({ tripped: false, spentTodayUsd: 5, limitUsd: 10 });
  });

  // Boundary is inclusive (>=): spend exactly equal to the limit trips.
  it('trips when today spend exactly equals the limit (inclusive boundary)', async () => {
    process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = '5';
    await seedSpend(2);
    await seedSpend(3);

    const { checkGlobalBreaker } = await importQuota();
    const result = await checkGlobalBreaker();
    expect(result.tripped).toBe(true);
    expect(result.spentTodayUsd).toBe(5);
    expect(result.limitUsd).toBe(5);
  });

  // The day-window filter applies to the breaker too: yesterday's spend is
  // excluded.
  it("excludes a previous UTC day's spend from today's total", async () => {
    process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = '1000000';
    await seedSpend(500, startOfTodayUtcMs() - 1); // yesterday, large cost

    const { checkGlobalBreaker } = await importQuota();
    const result = await checkGlobalBreaker();
    expect(result.spentTodayUsd).toBe(0);
    expect(result.tripped).toBe(false);
  });

  // sum() over zero rows returns SQL NULL → Number(null ?? 0) → 0, not NaN.
  it('reports spentTodayUsd:0 (not NaN) when there are no usage rows at all', async () => {
    process.env.GLOBAL_DAILY_SPEND_LIMIT_USD = '10';
    const { checkGlobalBreaker } = await importQuota();
    const result = await checkGlobalBreaker();
    expect(result.spentTodayUsd).toBe(0);
    expect(Number.isNaN(result.spentTodayUsd)).toBe(false);
    expect(result.tripped).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// DAILY_QUOTA — pure constant; no DB/env dependency, but quota.ts's import-time
// `db` load still has to be mocked away with a stub (never dereferenced here).
// -----------------------------------------------------------------------------
describe('DAILY_QUOTA', () => {
  beforeAll(() => {
    vi.resetModules();
    vi.doMock('@/db/index', () => ({ db: {} }));
  });

  // [acceptance item 5] encodes the Background decision that PARSE has no quota.
  it('has no parse key', async () => {
    const { DAILY_QUOTA } = await import('@/lib/config/quota');
    expect(DAILY_QUOTA).not.toHaveProperty('parse');
  });

  // Direct transcription check (PRD §8.3 numbers).
  it('transcribes the PRD §8.3 quota numbers exactly', async () => {
    const { DAILY_QUOTA } = await import('@/lib/config/quota');
    expect(DAILY_QUOTA).toEqual({ fit: 10, tailor: 5, prep: 3 });
  });
});
