import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { inviteCodes, users } from '@/db/schema';
import {
  attributeInviteCode,
  hasExistingUserWithEmail,
  redeemInviteCode,
  type Executor,
} from '@/lib/db/queries/invite-codes';

// PLT-04 — the machine-checkable acceptance surface for
// lib/db/queries/invite-codes.ts (ticket acceptance items 1, 2, 3 and the
// existing-user half of 5).
//
// The module under test is imported STATICALLY, which is itself a regression
// guard: this file would fail to LOAD if invite-codes.ts ever grew a top-level
// `@/db/index` import (db/index.ts throws without DATABASE_URL, which the test env
// does not set) — the single most likely implementation mistake here, and the one
// that breaks `pnpm build` on a clean checkout AND the Edge middleware bundle. One
// test at the bottom deliberately goes through the production lazy-import path
// instead.
//
// ISS-29: PGlite boot + the real migration chain exceeds Vitest's 5000ms default
// under full-suite load. Passed as each hook's/test's THIRD ARGUMENT because that
// is the only placement Vitest actually binds (a task's timeout is closed over at
// COLLECTION time, so vi.setConfig inside a hook is a silent no-op).
const PGLITE_TEST_TIMEOUT_MS = 30_000;

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let db: TestDb;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  // The real committed migration through drizzle's own migrator — the same code
  // path production runs.
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

const NOW = 1_700_000_000_000;

async function seedCode(code: string, values: Partial<typeof inviteCodes.$inferInsert> = {}) {
  await db.insert(inviteCodes).values({ code, createdAt: NOW, ...values });
  return code;
}

async function seedUser(email = `u-${crypto.randomUUID()}@example.com`) {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email });
  return { id, email };
}

async function readCode(code: string) {
  const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.code, code));
  return row;
}

async function allRows() {
  return db.select().from(inviteCodes).orderBy(inviteCodes.code);
}

// =============================================================================
describe('redeemInviteCode — the happy path (acceptance 1)', () => {
  it(
    'returns true and marks a valid, unused code as used by the given user',
    async () => {
      const user = await seedUser();
      await seedCode('GOOD-CODE-0001');

      const ok = await redeemInviteCode('GOOD-CODE-0001', user.id, {
        executor: exec(),
        now: NOW + 5,
      });

      expect(ok).toBe(true);
      const row = await readCode('GOOD-CODE-0001');
      expect(row.usedBy).toBe(user.id);
      expect(row.usedAt).toBe(NOW + 5);
      expect(row.createdAt).toBe(NOW); // untouched
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'accepts userId = null (THE production gate path) — used_at is set, used_by stays NULL',
    async () => {
      // This, not the case above, is what actually runs in production: the gate
      // fires BEFORE any users row exists, so it can only pass null. Attribution
      // happens later, in auth.ts's createUser event.
      await seedCode('NULL-USER-0001');

      const ok = await redeemInviteCode('NULL-USER-0001', null, {
        executor: exec(),
        now: NOW + 9,
      });

      expect(ok).toBe(true);
      const row = await readCode('NULL-USER-0001');
      expect(row.usedBy).toBeNull();
      expect(row.usedAt).toBe(NOW + 9); // consumed nonetheless — used_at is the guard
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('redeemInviteCode — rejection without side effects (acceptance 2)', () => {
  it(
    'returns false for a NONEXISTENT code and leaves the table byte-identical',
    async () => {
      await seedCode('AAAA-AAAA-AAAA');
      await seedCode('BBBB-BBBB-BBBB', { usedAt: NOW, usedBy: null });
      const before = await allRows();

      const ok = await redeemInviteCode('NOPE-NOPE-NOPE', 'whoever', {
        executor: exec(),
        now: NOW + 1,
      });

      expect(ok).toBe(false);
      expect(await allRows()).toEqual(before);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns false for an ALREADY-USED code and does NOT overwrite the first redeemer',
    async () => {
      const first = await seedUser();
      const second = await seedUser();
      await seedCode('ONCE-ONLY-0001');

      expect(
        await redeemInviteCode('ONCE-ONLY-0001', first.id, {
          executor: exec(),
          now: NOW + 1,
        }),
      ).toBe(true);

      const ok = await redeemInviteCode('ONCE-ONLY-0001', second.id, {
        executor: exec(),
        now: NOW + 2,
      });

      expect(ok).toBe(false);
      const row = await readCode('ONCE-ONLY-0001');
      // The second redeemer must not stamp its own id/time over the first's — an
      // UPDATE that "fails" by matching zero rows still returns false, but a
      // buggy unguarded UPDATE would return false-ish AND clobber. Assert both.
      expect(row.usedBy).toBe(first.id);
      expect(row.usedAt).toBe(NOW + 1);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'returns false for a code whose used_by was NULLED by an account deletion (the delete-and-re-register bypass)',
    async () => {
      // db/schema.ts's invite_codes rule 1, stated as an executable test: guarding
      // on `used_by IS NULL` — which is what PLT-04's ticket text literally asked
      // for — would return TRUE here and let one code mint unlimited accounts.
      await seedCode('REUSE-ME-0001', { usedAt: NOW, usedBy: null });

      const ok = await redeemInviteCode('REUSE-ME-0001', null, {
        executor: exec(),
        now: NOW + 100,
      });

      expect(ok).toBe(false);
      expect((await readCode('REUSE-ME-0001')).usedAt).toBe(NOW); // untouched
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('redeemInviteCode — concurrency (acceptance 3, the ticket-designated P0)', () => {
  // LIMIT OF THIS PROOF, stated so a green run is never mistaken for more than it
  // is: PGlite is a SINGLE-CONNECTION WASM Postgres, so `Promise.all`-ed queries
  // against one client are SERIALISED. These tests prove the guarded-UPDATE
  // PREDICATE (`WHERE code = $1 AND used_at IS NULL`) rejects every redeemer after
  // the first — i.e. that the implementation is not a SELECT-then-UPDATE and does
  // not guard on the wrong column. They do NOT exercise real row-lock contention.
  //
  // The production guarantee rests on Postgres READ COMMITTED semantics: an UPDATE
  // takes a row lock and then RE-EVALUATES the WHERE clause against the updated
  // row (EvalPlanQual), so the loser of a genuine race matches zero rows.
  // Verifying that against a live Neon instance under real parallel load is
  // PLT-04's Feedback obligation #1 and is STILL OPEN (plan §5 Q1) — a human item,
  // not discharged by this file.
  it(
    'two simultaneous redemptions of the SAME code: exactly one true, one false, one marked row',
    async () => {
      const a = await seedUser();
      const b = await seedUser();
      await seedCode('RACE-RACE-0001');

      const results = await Promise.all([
        redeemInviteCode('RACE-RACE-0001', a.id, { executor: exec(), now: NOW + 1 }),
        redeemInviteCode('RACE-RACE-0001', b.id, { executor: exec(), now: NOW + 2 }),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((r) => r === false)).toHaveLength(1);

      const row = await readCode('RACE-RACE-0001');
      expect(row.usedAt).not.toBeNull();
      expect([a.id, b.id]).toContain(row.usedBy);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'ten simultaneous redemptions of the SAME code: exactly one true',
    async () => {
      await seedCode('RACE-RACE-0010');
      const users10 = await Promise.all(Array.from({ length: 10 }, () => seedUser()));

      const results = await Promise.all(
        users10.map((u, i) =>
          redeemInviteCode('RACE-RACE-0010', u.id, {
            executor: exec(),
            now: NOW + i,
          }),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      const row = await readCode('RACE-RACE-0010');
      expect(row.usedAt).not.toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'parallel redemptions of DIFFERENT codes all succeed (the guard is per-row, not a global lock)',
    async () => {
      await Promise.all([
        seedCode('MANY-CODE-0001'),
        seedCode('MANY-CODE-0002'),
        seedCode('MANY-CODE-0003'),
      ]);

      const results = await Promise.all(
        ['MANY-CODE-0001', 'MANY-CODE-0002', 'MANY-CODE-0003'].map((c) =>
          redeemInviteCode(c, null, { executor: exec(), now: NOW + 1 }),
        ),
      );

      expect(results).toEqual([true, true, true]);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('attributeInviteCode — advisory attribution only (db/schema.ts rule 3)', () => {
  it(
    'fills used_by on a CLAIMED code whose used_by is still NULL',
    async () => {
      const user = await seedUser();
      await seedCode('ATTR-CODE-0001');
      await redeemInviteCode('ATTR-CODE-0001', null, { executor: exec(), now: NOW + 1 });

      await attributeInviteCode('ATTR-CODE-0001', user.id, { executor: exec() });

      const row = await readCode('ATTR-CODE-0001');
      expect(row.usedBy).toBe(user.id);
      expect(row.usedAt).toBe(NOW + 1); // attribution never touches the guard column
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'is a NO-OP on an unclaimed code — it can never claim one',
    async () => {
      // The `used_at IS NOT NULL` conjunct is what stops this being a second,
      // UNGUARDED redemption path around the atomic gate.
      const user = await seedUser();
      await seedCode('ATTR-CODE-0002');

      await attributeInviteCode('ATTR-CODE-0002', user.id, { executor: exec() });

      const row = await readCode('ATTR-CODE-0002');
      expect(row.usedBy).toBeNull();
      expect(row.usedAt).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'is a NO-OP when used_by is already set (idempotent; never overwrites the first attribution)',
    async () => {
      const first = await seedUser();
      const second = await seedUser();
      await seedCode('ATTR-CODE-0003', { usedAt: NOW, usedBy: first.id });

      await attributeInviteCode('ATTR-CODE-0003', second.id, { executor: exec() });

      expect((await readCode('ATTR-CODE-0003')).usedBy).toBe(first.id);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'is a NO-OP on a nonexistent code (and does not throw)',
    async () => {
      const user = await seedUser();
      await expect(
        attributeInviteCode('GONE-GONE-GONE', user.id, { executor: exec() }),
      ).resolves.toBeUndefined();
      expect(await allRows()).toEqual([]);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('account hard-delete interaction (plan §0.9 (b)+(c) — PLT-01 regression + the bypass)', () => {
  it(
    'DELETE FROM users still succeeds for a user who redeemed a code, and the code stays consumed',
    async () => {
      // TWO failures in one test:
      //   (c) a default (NO ACTION) FK would make this DELETE RAISE, silently
      //       breaking PRD §5.6's "删号 = 硬删该用户全部数据" for every user who
      //       ever used an invite code — and PLT-01's route knows nothing about
      //       this table, so it would surface as an opaque 500.
      //   (b) after the delete, used_by is NULL but used_at MUST still be set;
      //       otherwise "delete account, re-register with the same code" is an
      //       unlimited-signup bypass of the whole pacing control.
      const user = await seedUser();
      await seedCode('DEL-CODE-0001');
      await redeemInviteCode('DEL-CODE-0001', null, { executor: exec(), now: NOW + 1 });
      await attributeInviteCode('DEL-CODE-0001', user.id, { executor: exec() });
      expect((await readCode('DEL-CODE-0001')).usedBy).toBe(user.id);

      await db.delete(users).where(eq(users.id, user.id));

      const row = await readCode('DEL-CODE-0001');
      expect(row).toBeDefined(); // NOT cascaded away — the audit record survives
      expect(row.usedBy).toBeNull(); // ON DELETE set null
      expect(row.usedAt).toBe(NOW + 1); // still consumed

      // And the code cannot be redeemed again.
      expect(
        await redeemInviteCode('DEL-CODE-0001', null, {
          executor: exec(),
          now: NOW + 2,
        }),
      ).toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('hasExistingUserWithEmail — the new-vs-existing discriminator (acceptance 5)', () => {
  it(
    'returns true for a seeded email and false for an unknown one',
    async () => {
      await seedUser('ada@example.com');
      expect(
        await hasExistingUserWithEmail('ada@example.com', { executor: exec() }),
      ).toBe(true);
      expect(
        await hasExistingUserWithEmail('nobody@example.com', { executor: exec() }),
      ).toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'matches EXACTLY — a case variant is NOT an existing user',
    async () => {
      // Deliberate, not an oversight: @auth/drizzle-adapter's getUserByEmail is an
      // exact `eq`, and @auth/core uses that to decide whether to CREATE a user.
      // Matching case-insensitively here would make this gate and the adapter
      // disagree about who is new.
      await seedUser('ada@example.com');
      expect(
        await hasExistingUserWithEmail('Ada@Example.com', { executor: exec() }),
      ).toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'FAILS CLOSED on empty / null / undefined (⇒ treated as a new user ⇒ code required)',
    async () => {
      await seedUser('ada@example.com');
      expect(await hasExistingUserWithEmail('', { executor: exec() })).toBe(false);
      expect(await hasExistingUserWithEmail(null, { executor: exec() })).toBe(false);
      expect(await hasExistingUserWithEmail(undefined, { executor: exec() })).toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'never touches the database for a falsy email (no executor needed, no DATABASE_URL)',
    async () => {
      // Structural: the early return happens BEFORE defaultDb(), so this call
      // cannot explode on a missing DATABASE_URL in production either.
      await expect(hasExistingUserWithEmail(null)).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

// =============================================================================
describe('module structure — build-time safety (the Edge/middleware + clean-checkout guard)', () => {
  it('is importable with DATABASE_URL UNSET (no top-level @/db/index import)', async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      vi.resetModules();
      const mod = await import('@/lib/db/queries/invite-codes');
      expect(typeof mod.redeemInviteCode).toBe('function');
      expect(typeof mod.attributeInviteCode).toBe('function');
      expect(typeof mod.hasExistingUserWithEmail).toBe('function');
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
      vi.resetModules();
    }
  });

  it(
    'resolves @/db/index lazily and only ONCE under same-tick concurrency',
    async () => {
      // The production path: no `executor` injected, so every function must reach
      // its client through the memoized dbIndex(). Vitest's mocker re-resolves a
      // doMock-ed specifier on EVERY import() call, so without the memo one of
      // these would load the real @/db/index and die on its DATABASE_URL
      // fail-fast.
      const user = await seedUser('lazy@example.com');
      await seedCode('LAZY-CODE-0001');

      let imports = 0;
      vi.resetModules();
      vi.doMock('@/db/index', () => {
        imports += 1;
        return { db, dbTx: db };
      });
      try {
        const mod = await import('@/lib/db/queries/invite-codes');
        const [redeemed, exists] = await Promise.all([
          mod.redeemInviteCode('LAZY-CODE-0001', null),
          mod.hasExistingUserWithEmail('lazy@example.com'),
          mod.attributeInviteCode('LAZY-CODE-0001', user.id),
        ]);
        expect(redeemed).toBe(true);
        expect(exists).toBe(true);
        expect(imports).toBe(1);
      } finally {
        vi.doUnmock('@/db/index');
        vi.resetModules();
      }
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it('redeemInviteCode issues exactly ONE statement (no SELECT-then-UPDATE)', () => {
    // A cheap structural guard for the ticket's designated P0. The atomicity
    // argument only holds if redemption is a single guarded UPDATE; a
    // read-then-write reintroduces a TOCTOU window that no PGlite test could
    // observe (single connection ⇒ serialised). Asserted against the source text
    // because the failure mode is a refactor that still passes every behavioural
    // test above.
    const src = readSource();
    const body = src.slice(
      src.indexOf('export async function redeemInviteCode'),
      src.indexOf('export async function attributeInviteCode'),
    );
    expect(body).toContain('.update(inviteCodes)');
    expect(body).not.toContain('.select(');
    expect(body).not.toContain('.transaction(');
    // The guard column: used_at, never used_by (schema rule 1).
    expect(body).toContain('isNull(inviteCodes.usedAt)');
    expect(body).not.toContain('isNull(inviteCodes.usedBy)');
  });
});

function readSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'lib', 'db', 'queries', 'invite-codes.ts'),
    'utf8',
  );
}
