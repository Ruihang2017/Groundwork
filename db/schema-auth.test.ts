import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { accounts, sessions, users, verificationTokens } from '@/db/schema';

// FND-08 regression + new-table shape test (acceptance item 4 + Test-plan's
// "schema-append regression test"). Pure Drizzle introspection + a PGlite
// round-trip — no db/index.ts import, no DATABASE_URL, no live Neon. db/schema.test.ts
// is left BYTE-FOR-BYTE UNMODIFIED and still runs alongside this file as the
// eight-table regression guard (acceptance item 4's first half).

// Expected JS-property column keys (NOT the snake_case DB names). The load-bearing
// snake_case-looking property keys on `accounts` (refresh_token/access_token/...)
// mirror OAuth2 wire-format names and are structurally required by
// @auth/drizzle-adapter — a rename would break the DrizzleAdapter(...) call site.
const expectedColumns: Record<string, string[]> = {
  accounts: [
    'userId',
    'type',
    'provider',
    'providerAccountId',
    'refresh_token',
    'access_token',
    'expires_at',
    'token_type',
    'scope',
    'id_token',
    'session_state',
  ],
  sessions: ['sessionToken', 'userId', 'expires'],
  verification_tokens: ['identifier', 'token', 'expires'],
};

const tables = {
  accounts,
  sessions,
  verification_tokens: verificationTokens,
} as const;

describe('db/schema (auth) — table names', () => {
  for (const [expectedName, table] of Object.entries(tables)) {
    it(`maps to the '${expectedName}' Postgres table`, () => {
      expect(getTableName(table)).toBe(expectedName);
    });
  }
});

describe('db/schema (auth) — column sets', () => {
  for (const [name, table] of Object.entries(tables)) {
    it(`${name} has exactly the expected columns (no more, no fewer)`, () => {
      const actual = Object.keys(getTableColumns(table)).sort();
      const expected = [...expectedColumns[name]].sort();
      expect(actual).toEqual(expected);
    });
  }
});

describe('db/schema (auth) — composite / single primary keys', () => {
  it('accounts PK is the composite (provider, providerAccountId)', () => {
    const pks = getTableConfig(accounts).primaryKeys;
    expect(pks).toHaveLength(1);
    expect(pks[0].columns.map((c) => c.name)).toEqual([
      'provider',
      'provider_account_id',
    ]);
  });

  it('verification_tokens PK is the composite (identifier, token)', () => {
    const pks = getTableConfig(verificationTokens).primaryKeys;
    expect(pks).toHaveLength(1);
    expect(pks[0].columns.map((c) => c.name)).toEqual(['identifier', 'token']);
  });

  it('sessions PK is sessionToken alone (single-column, not composite)', () => {
    expect(getTableConfig(sessions).primaryKeys).toHaveLength(0);
    expect(getTableColumns(sessions).sessionToken.primary).toBe(true);
  });
});

describe('db/schema (auth) — column SQL types (adapter-contract exceptions)', () => {
  it('sessions.expires / verificationTokens.expires are native timestamp (not bigint)', () => {
    expect(getTableColumns(sessions).expires.getSQLType()).toBe('timestamp');
    expect(getTableColumns(verificationTokens).expires.getSQLType()).toBe('timestamp');
  });

  it('accounts.expires_at is integer (raw OAuth2 unix-seconds), NOT bigint/timestamp', () => {
    expect(getTableColumns(accounts).expires_at.getSQLType()).toBe('integer');
  });

  it('maps camelCase properties to snake_case DB columns', () => {
    expect(getTableColumns(accounts).userId.name).toBe('user_id');
    expect(getTableColumns(accounts).providerAccountId.name).toBe('provider_account_id');
    expect(getTableColumns(sessions).sessionToken.name).toBe('session_token');
  });
});

describe('db/schema (auth) — NOT NULL constraints', () => {
  it('accounts required columns are NOT NULL; optional OAuth fields are nullable', () => {
    const cols = getTableColumns(accounts);
    expect(cols.userId.notNull).toBe(true);
    expect(cols.type.notNull).toBe(true);
    expect(cols.provider.notNull).toBe(true);
    expect(cols.providerAccountId.notNull).toBe(true);
    expect(cols.refresh_token.notNull).toBe(false);
    expect(cols.access_token.notNull).toBe(false);
    expect(cols.expires_at.notNull).toBe(false);
  });

  it('sessions / verification_tokens required columns are NOT NULL', () => {
    expect(getTableColumns(sessions).sessionToken.notNull).toBe(true);
    expect(getTableColumns(sessions).userId.notNull).toBe(true);
    expect(getTableColumns(sessions).expires.notNull).toBe(true);
    expect(getTableColumns(verificationTokens).identifier.notNull).toBe(true);
    expect(getTableColumns(verificationTokens).token.notNull).toBe(true);
    expect(getTableColumns(verificationTokens).expires.notNull).toBe(true);
  });
});

// --- Migration regression: the NEW second migration file exists and creates the
// three auth tables (drizzle-kit generate produced a diff-only migration, proving
// the eight existing tables were not touched). --------------------------------
describe('db/schema (auth) — generated migration SQL', () => {
  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
  let combinedSql: string;
  let sqlFileCount: number;

  beforeAll(() => {
    const sqlFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'));
    sqlFileCount = sqlFiles.length;
    combinedSql = sqlFiles
      .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
      .join('\n');
  });

  it('a second migration file was generated (append, not an edit of 0000)', () => {
    expect(sqlFileCount).toBeGreaterThanOrEqual(2);
  });

  it('creates accounts / sessions / verification_tokens', () => {
    expect(combinedSql).toMatch(/CREATE TABLE "accounts"/);
    expect(combinedSql).toMatch(/CREATE TABLE "sessions"/);
    expect(combinedSql).toMatch(/CREATE TABLE "verification_tokens"/);
  });

  it('enforces the accounts/sessions → users foreign keys with ON DELETE cascade', () => {
    expect(combinedSql).toMatch(/"accounts_user_id_users_id_fk".*ON DELETE cascade/);
    expect(combinedSql).toMatch(/"sessions_user_id_users_id_fk".*ON DELETE cascade/);
  });

  it('declares the composite primary keys', () => {
    expect(combinedSql).toMatch(
      /PRIMARY KEY\("provider","provider_account_id"\)/,
    );
    expect(combinedSql).toMatch(/PRIMARY KEY\("identifier","token"\)/);
  });
});

// --- Tier 3: real round-trip against PGlite (same driver/migrator the production
// path uses). Proves the migration applies and the three tables actually persist
// and cascade — not just that they type-check. ---------------------------------
describe('db/schema (auth) — PGlite round-trip', () => {
  it('applies the migration and round-trips a user + account + session + verification token', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: './db/migrations' });

    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: 'ada@example.com' });

    await db.insert(accounts).values({
      userId,
      type: 'oauth',
      provider: 'google',
      providerAccountId: 'google-sub-123',
      access_token: 'tok',
      expires_at: 1_700_000_000, // unix SECONDS
      scope: 'openid email',
    });

    const expires = new Date('2030-01-01T00:00:00.000Z');
    await db.insert(sessions).values({
      sessionToken: 'sess-abc',
      userId,
      expires,
    });

    await db.insert(verificationTokens).values({
      identifier: 'ada@example.com',
      token: 'magic-xyz',
      expires,
    });

    const [acct] = await db.select().from(accounts);
    const [sess] = await db.select().from(sessions);
    const [vt] = await db.select().from(verificationTokens);

    expect(acct.provider).toBe('google');
    expect(acct.providerAccountId).toBe('google-sub-123');
    expect(acct.expires_at).toBe(1_700_000_000);
    expect(typeof acct.expires_at).toBe('number');
    expect(sess.sessionToken).toBe('sess-abc');
    expect(sess.expires).toBeInstanceOf(Date);
    expect(sess.expires.getTime()).toBe(expires.getTime());
    expect(vt.identifier).toBe('ada@example.com');
    expect(vt.expires).toBeInstanceOf(Date);

    await client.close();
  }, 30_000);

  it('cascades: deleting a user removes that user\'s account + session rows', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: './db/migrations' });

    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: 'b@example.com' });
    await db.insert(accounts).values({
      userId,
      type: 'oauth',
      provider: 'google',
      providerAccountId: 'sub-b',
    });
    await db.insert(sessions).values({
      sessionToken: 'sess-b',
      userId,
      expires: new Date('2030-01-01T00:00:00.000Z'),
    });

    // Sanity: rows exist before the delete.
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(1);

    await db.delete(users).where(eq(users.id, userId));

    // onDelete: 'cascade' (§2.2) removes the dependent rows.
    expect(await db.select().from(accounts)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);

    await client.close();
  }, 30_000);
});
