import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { getTableColumns, getTableName, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { inviteCodes } from '@/db/schema';
import {
  attachInviteCodeUser,
  isExistingUserEmail,
  normalizeInviteCode,
  redeemInviteCode,
  type Executor,
} from '@/lib/db/queries/invite-codes';

// PLT-04 — the machine-checkable acceptance surface for lib/db/queries/invite-codes.ts
// (acceptance items 1, 2 and 3).
//
// The module under test is imported STATICALLY, exactly as lib/db/queries/
// admin.test.ts does, and for the same reason: that is itself a regression guard.
// This file would fail to load at all if invite-codes.ts ever grew a top-level
// `@/db/index` import (db/index.ts throws without DATABASE_URL, which the test env
// does not set) — the mistake that breaks `pnpm build` on a clean checkout AND puts
// the DB driver into the Edge middleware bundle via middleware.ts → @/auth → here.
//
// ISS-29: a PGlite boot + the real migration chain exceeds Vitest's 5000ms default
// under full-suite load. Passed as each hook's/test's THIRD ARGUMENT because that is
// the only placement Vitest actually binds (a task's timeout is closed over at
// COLLECTION time, so vi.setConfig inside a hook is a silent no-op).
const PGLITE_TEST_TIMEOUT_MS = 30_000;

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let db: TestDb;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  // The real committed migration through drizzle's own migrator — the same code path
  // production runs (db/migrate.test.ts Tier 3). This is also what proves migration
  // 0004 actually applies.
  await migrate(db, { migrationsFolder: './db/migrations' });
}, PGLITE_TEST_TIMEOUT_MS);

beforeEach(async () => {
  await db.execute(
    sql`truncate table invite_codes, users restart identity cascade`,
  );
}, PGLITE_TEST_TIMEOUT_MS);

/** The injected client, typed as the module's public Executor. */
function exec(): Executor {
  return db as unknown as Executor;
}

// A FIXED clock so `usedAt` assertions are exact instead of racing the wall clock.
const NOW = 1_700_000_000_000;

async function seedUser(email: string): Promise<string> {
  const [row] = await db
    .insert(schema.users)
    .values({ email })
    .returning({ id: schema.users.id });
  return row.id;
}

async function seedCode(code: string): Promise<void> {
  await db.insert(inviteCodes).values({ code, createdAt: NOW - 1000 });
}

async function readCode(code: string) {
  const [row] = await db
    .select()
    .from(inviteCodes)
    .where(sql`${inviteCodes.code} = ${code}`);
  return row;
}

async function countCodes(): Promise<number> {
  const rows = await db.select().from(inviteCodes);
  return rows.length;
}

describe('normalizeInviteCode', () => {
  it('trims, upper-cases and accepts the canonical shape', () => {
    expect(normalizeInviteCode('  abc123xyz9  ')).toBe('ABC123XYZ9');
    expect(normalizeInviteCode('AB-CD')).toBe('AB-CD');
  });

  it('returns null for anything that cannot be a code (so nothing unvalidated reaches SQL)', () => {
    for (const bad of [
      '',
      '   ',
      'ABC', // too short
      'A'.repeat(65), // too long
      "ABC'; drop table invite_codes; --",
      "ABCD' OR 1=1",
      'ABCD EFGH', // internal whitespace
      'ABCD;PATH=/',
      null,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      42 as any,
    ]) {
      expect(normalizeInviteCode(bad)).toBeNull();
    }
  });
});

describe('redeemInviteCode (acceptance items 1-3)', () => {
  it(
    'returns true and marks the code used for a valid, unused code (acceptance 1)',
    async () => {
      const userId = await seedUser('new@example.com');
      await seedCode('ABC123XYZ9');

      await expect(
        redeemInviteCode('ABC123XYZ9', userId, { executor: exec(), now: NOW }),
      ).resolves.toBe(true);

      const row = await readCode('ABC123XYZ9');
      expect(row.usedBy).toBe(userId);
      expect(row.usedAt).toBe(NOW);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns false for a nonexistent code without modifying any row (acceptance 2)',
    async () => {
      await seedCode('ABC123XYZ9');
      const before = await readCode('ABC123XYZ9');

      await expect(
        redeemInviteCode('NOSUCHCODE', null, { executor: exec(), now: NOW }),
      ).resolves.toBe(false);

      expect(await countCodes()).toBe(1);
      expect(await readCode('ABC123XYZ9')).toEqual(before);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns false for an already-used code and leaves the original redemption byte-identical (acceptance 2)',
    async () => {
      const first = await seedUser('first@example.com');
      const second = await seedUser('second@example.com');
      await seedCode('ABC123XYZ9');

      await expect(
        redeemInviteCode('ABC123XYZ9', first, { executor: exec(), now: NOW }),
      ).resolves.toBe(true);
      const afterFirst = await readCode('ABC123XYZ9');

      await expect(
        redeemInviteCode('ABC123XYZ9', second, { executor: exec(), now: NOW + 5_000 }),
      ).resolves.toBe(false);

      expect(await readCode('ABC123XYZ9')).toEqual(afterFirst);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  // ---- acceptance item 3: the P0 concurrency guarantee -----------------------
  //
  // HONESTY NOTE (ticket Feedback obligation #1). PGlite serializes every query
  // through a single WASM connection, so this proves the GUARDED-UPDATE ROW-COUNT
  // SEMANTICS — the loser's `WHERE used_at IS NULL` no longer matches the committed
  // row — not true parallel row-lock contention. That is precisely the substitution
  // the ticket's acceptance item 3 anticipates ("or a direct assertion on the
  // guarded-UPDATE's row-count semantics if the test substitute doesn't support true
  // concurrency"). Under real Postgres READ COMMITTED the same single statement is
  // still single-winner: the second UPDATE blocks on the first's row lock, then
  // re-evaluates its qual against the committed row and matches nothing.
  //
  // The obligation to re-verify against a REAL Neon instance under concurrent load
  // before P5 sign-off is carried in the ticket Changelog. Do not treat this test as
  // discharging it.
  it(
    'exactly ONE of two simultaneous redemptions of the SAME code wins (acceptance 3, P0)',
    async () => {
      const u1 = await seedUser('race1@example.com');
      const u2 = await seedUser('race2@example.com');
      await seedCode('ABC123XYZ9');

      const results = await Promise.all([
        redeemInviteCode('ABC123XYZ9', u1, { executor: exec(), now: NOW }),
        redeemInviteCode('ABC123XYZ9', u2, { executor: exec(), now: NOW }),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((r) => r === false)).toHaveLength(1);

      const row = await readCode('ABC123XYZ9');
      expect([u1, u2]).toContain(row.usedBy);
      expect(row.usedAt).toBe(NOW);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'claims the code with a NULL usedBy (the production sign-in-gate path)',
    async () => {
      await seedCode('ABC123XYZ9');

      await expect(
        redeemInviteCode('abc123xyz9', null, { executor: exec(), now: NOW }),
      ).resolves.toBe(true);

      const row = await readCode('ABC123XYZ9');
      expect(row.usedAt).toBe(NOW);
      expect(row.usedBy).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'REJECTS (does not swallow) a userId with no users row — the used_by FK is live',
    async () => {
      // Guards the widened `userId: string | null` signature: anyone "fixing" it back
      // to the ticket's literal `string` by passing the signIn callback's throwaway
      // user.id would hit exactly this, loudly, instead of silently corrupting rows.
      await seedCode('ABC123XYZ9');

      await expect(
        redeemInviteCode('ABC123XYZ9', 'no-such-user', { executor: exec(), now: NOW }),
      ).rejects.toThrow();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'normalizes case/whitespace to the same row, and never sends un-normalizable input to SQL',
    async () => {
      await seedCode('ABC123XYZ9');

      await expect(
        redeemInviteCode('  abc123xyz9 ', null, { executor: exec(), now: NOW }),
      ).resolves.toBe(true);

      // Reseed a second, untouched code and prove the hostile inputs touch nothing.
      await seedCode('ZZZZ999999');
      const before = await readCode('ZZZZ999999');
      for (const bad of ["'; drop table invite_codes; --", "ZZZZ999999' OR 1=1", '']) {
        await expect(
          redeemInviteCode(bad, null, { executor: exec(), now: NOW }),
        ).resolves.toBe(false);
      }
      expect(await readCode('ZZZZ999999')).toEqual(before);
      expect(await countCodes()).toBe(2);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('attachInviteCodeUser', () => {
  it(
    'attributes a null-claimed code, refuses to overwrite an existing attribution, and refuses a never-claimed code',
    async () => {
      const u1 = await seedUser('one@example.com');
      const u2 = await seedUser('two@example.com');
      await seedCode('ABC123XYZ9');
      await seedCode('UNCLAIMED9');

      // Claimed with no user (the gate path), then attributed.
      await redeemInviteCode('ABC123XYZ9', null, { executor: exec(), now: NOW });
      await expect(
        attachInviteCodeUser('ABC123XYZ9', u1, { executor: exec() }),
      ).resolves.toBe(true);
      expect((await readCode('ABC123XYZ9')).usedBy).toBe(u1);

      // A second attach must not steal the attribution.
      await expect(
        attachInviteCodeUser('ABC123XYZ9', u2, { executor: exec() }),
      ).resolves.toBe(false);
      expect((await readCode('ABC123XYZ9')).usedBy).toBe(u1);

      // A code that was never claimed must not become attributed — this is not a
      // back-door redemption path.
      await expect(
        attachInviteCodeUser('UNCLAIMED9', u2, { executor: exec() }),
      ).resolves.toBe(false);
      const unclaimed = await readCode('UNCLAIMED9');
      expect(unclaimed.usedBy).toBeNull();
      expect(unclaimed.usedAt).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns false for an un-normalizable code instead of touching the table',
    async () => {
      await expect(
        attachInviteCodeUser('', 'whoever', { executor: exec() }),
      ).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('isExistingUserEmail (the gate\'s new-vs-existing test)', () => {
  it(
    'is true for a seeded email, false for an unknown one, and CASE-SENSITIVE',
    async () => {
      await seedUser('user@example.com');

      await expect(
        isExistingUserEmail('user@example.com', { executor: exec() }),
      ).resolves.toBe(true);
      await expect(
        isExistingUserEmail('nobody@example.com', { executor: exec() }),
      ).resolves.toBe(false);

      // THE BYPASS GUARD. @auth/core's own getUserByEmail lookup is exact-match, so
      // 'User@Example.com' is a NEW user upstream and must be gated. A
      // case-insensitive match here would wave it through as "existing" and no code
      // would ever be redeemed.
      await expect(
        isExistingUserEmail('User@Example.com', { executor: exec() }),
      ).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns false for an empty address without querying',
    async () => {
      await expect(isExistingUserEmail('', { executor: exec() })).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('account deletion interaction (PRD §5.6 hard delete)', () => {
  it(
    'DELETE FROM users succeeds, nulls used_by, keeps used_at set, and does NOT recycle the code',
    async () => {
      const userId = await seedUser('leaving@example.com');
      await seedCode('ABC123XYZ9');
      await redeemInviteCode('ABC123XYZ9', userId, { executor: exec(), now: NOW });

      // PLT-01's account hard-delete ends with exactly this statement inside one
      // transaction. With drizzle's DEFAULT referential action (NO ACTION) it would
      // fail here for every user who ever redeemed a code — i.e. users would be
      // unable to delete their account. `onDelete: 'set null'` is what makes it work.
      await db.execute(sql`delete from users where id = ${userId}`);

      const row = await readCode('ABC123XYZ9');
      expect(row.usedBy).toBeNull();
      // used_at survives — which is exactly why it, and never used_by, is the
      // "unused" predicate.
      expect(row.usedAt).toBe(NOW);

      await expect(
        redeemInviteCode('ABC123XYZ9', null, { executor: exec(), now: NOW + 1 }),
      ).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('schema + migration shape (PLT-04 Deliverable 1)', () => {
  // Asserted HERE rather than by editing db/schema.test.ts / db/migrate.test.ts,
  // which stay byte-for-byte unmodified as regression guards (plan §2.7).
  const migrationsDir = join(process.cwd(), 'db', 'migrations');
  const committedSql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
    .join('\n');

  it('the committed migration creates invite_codes', () => {
    expect(committedSql).toContain('CREATE TABLE "invite_codes"');
  });

  it('the used_by FK carries ON DELETE set null (PRD §5.6 hard delete keeps working)', () => {
    expect(committedSql).toMatch(
      /ALTER TABLE "invite_codes" ADD CONSTRAINT [^\n]*"used_by"[^\n]*ON DELETE set null/,
    );
  });

  it('the drizzle table is named invite_codes with exactly the four ticket columns', () => {
    expect(getTableName(inviteCodes)).toBe('invite_codes');
    expect(Object.keys(getTableColumns(inviteCodes)).sort()).toEqual(
      ['code', 'createdAt', 'usedAt', 'usedBy'].sort(),
    );
  });
});
