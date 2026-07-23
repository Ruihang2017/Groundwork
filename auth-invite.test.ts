import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { inviteCodes } from '@/db/schema';

// PLT-04 — the invite gate wired into auth.ts (acceptance items 4 and 5).
//
// A SEPARATE FILE from FND-08's auth.test.ts on purpose (plan §2.7): that file's
// mock set (next-auth only, everything else real, DATABASE_URL juggling) is a very
// different environment from this one's (a PGlite-backed @/db/index plus a fake
// next/headers cookie store), and FND-08's file stays byte-for-byte unmodified as a
// regression guard.
//
// Why `next-auth` is mocked file-level: importing the real next-auth runtime under
// Vitest fails (its lib/env.js imports `next/server`, which Node's ESM resolver
// cannot load for the nested package outside Next's bundler) — verbatim the reason
// auth.test.ts:12-21 records. Only the default `NextAuth` export is mocked; the
// invite gate itself, @/auth.config, @/lib/db/queries/invite-codes and the real
// Drizzle adapter all run for real.
vi.mock('next-auth', () => ({
  default: () => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

const PGLITE_TEST_TIMEOUT_MS = 30_000; // ISS-29 — third argument, the only bound one.

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let db: TestDb;

const ORIGINAL_URL = process.env.DATABASE_URL;
const NOW = 1_700_000_000_000;

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './db/migrations' });
}, PGLITE_TEST_TIMEOUT_MS);

beforeEach(async () => {
  vi.resetModules();
  // A syntactically valid dummy URL: neon() construction is lazy/network-free (same
  // proven pattern as db/index.test.ts). @/db/index is doMock-ed per test anyway;
  // this keeps any incidental real import from tripping FND-05's fail-fast.
  process.env.DATABASE_URL = 'postgresql://user:pass@fake-host.example.invalid/db';
  await db.execute(sql`truncate table invite_codes, users restart identity cascade`);
}, PGLITE_TEST_TIMEOUT_MS);

afterEach(() => {
  if (ORIGINAL_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_URL;
  }
  vi.doUnmock('next/headers');
  vi.doUnmock('@/db/index');
});

/**
 * Mocks the two request-time modules auth.ts reaches dynamically, then imports a
 * FRESH @/auth and returns its composed signIn callback + events.
 *
 * `cookie === undefined` means "no invite cookie present"; `cookie === 'THROW'`
 * makes next/headers throw, i.e. the no-request-scope case.
 */
async function loadAuth(cookie?: string | 'THROW') {
  vi.doMock('@/db/index', () => ({ db, dbTx: db }));
  vi.doMock('next/headers', () => ({
    cookies: async () => {
      if (cookie === 'THROW') throw new Error('called outside a request scope');
      return {
        get: (name: string) =>
          name === 'gw_invite_code' && cookie !== undefined
            ? { name, value: cookie }
            : undefined,
      };
    },
  }));

  const { buildAuthConfig, INVITE_COOKIE_NAME } = await import('@/auth');
  const config = await buildAuthConfig();
  return { config, signIn: config.callbacks!.signIn!, INVITE_COOKIE_NAME };
}

async function seedUser(email: string): Promise<string> {
  const [row] = await db
    .insert(schema.users)
    .values({ email })
    .returning({ id: schema.users.id });
  return row.id;
}

async function seedCode(code: string, used?: { at: number; by: string | null }) {
  await db.insert(inviteCodes).values({
    code,
    createdAt: NOW - 1000,
    usedAt: used?.at ?? null,
    usedBy: used?.by ?? null,
  });
}

async function readCode(code: string) {
  const [row] = await db
    .select()
    .from(inviteCodes)
    .where(sql`${inviteCodes.code} = ${code}`);
  return row;
}

// @auth/core-shaped callback params. The real callback receives exactly
// `{ user, account?, profile?, email?, credentials? }` — no `isNewUser`, no request.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const params = (over: Record<string, unknown>): any => ({
  user: { id: 'throwaway-id', email: 'someone@example.com' },
  account: { type: 'oauth', provider: 'google', providerAccountId: 'g1' },
  ...over,
});

describe('auth.ts invite gate — NEW users (acceptance item 4)', () => {
  it(
    'rejects a new user with NO invite cookie',
    async () => {
      const { signIn } = await loadAuth(undefined);
      await expect(
        signIn(params({ user: { id: 'x', email: 'new@example.com' } })),
      ).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'rejects a new user whose cookie holds a NONEXISTENT code',
    async () => {
      const { signIn } = await loadAuth('NOSUCHCODE');
      await expect(
        signIn(params({ user: { id: 'x', email: 'new@example.com' } })),
      ).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'rejects a new user whose cookie holds an ALREADY-USED code',
    async () => {
      const owner = await seedUser('owner@example.com');
      await seedCode('ABC123XYZ9', { at: NOW - 500, by: owner });

      const { signIn } = await loadAuth('ABC123XYZ9');
      await expect(
        signIn(params({ user: { id: 'x', email: 'new@example.com' } })),
      ).resolves.toBe(false);

      // The existing redemption is untouched.
      const row = await readCode('ABC123XYZ9');
      expect(row.usedBy).toBe(owner);
      expect(row.usedAt).toBe(NOW - 500);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'rejects a sign-in attempt carrying no email at all (fail closed)',
    async () => {
      const { signIn } = await loadAuth('ABC123XYZ9');
      await expect(signIn(params({ user: { id: 'x' } }))).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'ALLOWS a new user with a valid unused code, and CLAIMS the row (usedAt set, usedBy null)',
    async () => {
      await seedCode('ABC123XYZ9');

      const { signIn } = await loadAuth('abc123xyz9'); // lower case: normalization
      await expect(
        signIn(params({ user: { id: 'throwaway', email: 'new@example.com' } })),
      ).resolves.toBe(true);

      const row = await readCode('ABC123XYZ9');
      expect(row.usedAt).not.toBeNull();
      // usedBy stays NULL at gate time: the users row does not exist yet, and the id
      // visible to the callback is one @auth/drizzle-adapter discards.
      expect(row.usedBy).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('auth.ts invite gate — EXISTING users are unaffected (acceptance item 5, Non-goals)', () => {
  it(
    'allows an existing user with NO cookie',
    async () => {
      await seedUser('back@example.com');
      const { signIn } = await loadAuth(undefined);
      await expect(
        signIn(params({ user: { id: 'x', email: 'back@example.com' } })),
      ).resolves.toBe(true);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'allows an existing user with a GARBAGE cookie, and modifies no invite row',
    async () => {
      await seedUser('back@example.com');
      await seedCode('ABC123XYZ9');
      const before = await readCode('ABC123XYZ9');

      const { signIn } = await loadAuth("'; drop table invite_codes; --");
      await expect(
        signIn(params({ user: { id: 'x', email: 'back@example.com' } })),
      ).resolves.toBe(true);

      expect(await readCode('ABC123XYZ9')).toEqual(before);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'gates a DIFFERENTLY-CASED address (upstream would create a new user, so it must be gated)',
    async () => {
      await seedUser('back@example.com');
      const { signIn } = await loadAuth(undefined);
      await expect(
        signIn(params({ user: { id: 'x', email: 'Back@Example.com' } })),
      ).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('auth.ts invite gate — the email provider is gated in phase 1, not phase 2', () => {
  it(
    'gates PHASE 1 (verificationRequest: true) — a new address with no code gets no magic link',
    async () => {
      const { signIn } = await loadAuth(undefined);
      await expect(
        signIn(
          params({
            user: { id: 'x', email: 'new@example.com' },
            account: { type: 'email', provider: 'resend', providerAccountId: 'new@example.com' },
            email: { verificationRequest: true },
          }),
        ),
      ).resolves.toBe(false);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'ALLOWS PHASE 2 (the link was clicked) with no cookie — a regression here breaks every cross-device magic link',
    async () => {
      const { signIn } = await loadAuth(undefined);
      await expect(
        signIn(
          params({
            user: { id: 'x', email: 'new@example.com' },
            account: { type: 'email', provider: 'resend', providerAccountId: 'new@example.com' },
          }),
        ),
      ).resolves.toBe(true);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('auth.ts invite gate — the race is decided AT THE GATE', () => {
  it(
    'two concurrent new-user sign-ins sharing ONE code: exactly one is allowed',
    async () => {
      await seedCode('ABC123XYZ9');
      const { signIn } = await loadAuth('ABC123XYZ9');

      const results = await Promise.all([
        signIn(params({ user: { id: 'a', email: 'a@example.com' } })),
        signIn(params({ user: { id: 'b', email: 'b@example.com' } })),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('auth.ts events.createUser — best-effort attribution that must never throw', () => {
  it(
    'attaches used_by once the users row exists',
    async () => {
      await seedCode('ABC123XYZ9', { at: NOW - 10, by: null });
      const { config } = await loadAuth('ABC123XYZ9');
      const userId = await seedUser('new@example.com');

      expect(config.events?.createUser).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await config.events!.createUser!({ user: { id: userId } } as any);

      expect((await readCode('ABC123XYZ9')).usedBy).toBe(userId);
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    'RESOLVES (never throws) when next/headers throws, and leaves the row alone',
    async () => {
      // @auth/core awaits events.createUser inside the callback route's try block, so
      // a throw here would fail a sign-in whose account ALREADY EXISTS.
      await seedCode('ABC123XYZ9', { at: NOW - 10, by: null });
      const { config } = await loadAuth('THROW');
      const userId = await seedUser('new@example.com');

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config.events!.createUser!({ user: { id: userId } } as any),
      ).resolves.toBeUndefined();

      expect((await readCode('ABC123XYZ9')).usedBy).toBeNull();
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('auth.ts — the cookie transport name', () => {
  it(
    'INVITE_COOKIE_NAME is the exact literal app/(auth)/signin/page.tsx duplicates',
    async () => {
      // The two files share this string BY VALUE (the page is 'use client' and cannot
      // import server-only @/auth). page-invite.test.tsx pins the same literal on the
      // client side; together they are the drift guard.
      const { INVITE_COOKIE_NAME } = await loadAuth(undefined);
      expect(INVITE_COOKIE_NAME).toBe('gw_invite_code');
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});

describe('auth.ts — build-safety invariant re-asserted after PLT-04s appends', () => {
  it('imports @/auth with DATABASE_URL UNSET and does not throw', async () => {
    // FND-08's auth.test.ts asserts this for the pre-PLT-04 file; re-asserted here
    // because this ticket added two new dynamic imports (next/headers and
    // @/lib/db/queries/invite-codes) to the same module. Either one made static
    // would break `pnpm build` on a clean checkout and drag the DB driver into the
    // Edge middleware bundle.
    delete process.env.DATABASE_URL;
    await expect(import('@/auth')).resolves.toBeDefined();
  });
});
