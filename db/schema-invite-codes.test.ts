import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { inviteCodes } from '@/db/schema';

// PLT-04 — schema-append shape test for `invite_codes`, modelled on
// db/schema-auth.test.ts (FND-08's precedent for a schema append): pure Drizzle
// introspection plus a PGlite round-trip. No db/index.ts import, no DATABASE_URL,
// no live Neon. db/schema.test.ts and db/schema-auth.test.ts stay BYTE-FOR-BYTE
// UNMODIFIED and keep running alongside this file as the prior-tables regression
// guard.

describe('db/schema — invite_codes table shape', () => {
  it("maps to the 'invite_codes' Postgres table", () => {
    expect(getTableName(inviteCodes)).toBe('invite_codes');
  });

  it('has exactly the expected columns (no more, no fewer)', () => {
    expect(Object.keys(getTableColumns(inviteCodes)).sort()).toEqual(
      ['code', 'createdAt', 'usedAt', 'usedBy'].sort(),
    );
  });

  it('maps camelCase properties to snake_case DB columns', () => {
    const cols = getTableColumns(inviteCodes);
    expect(cols.usedBy.name).toBe('used_by');
    expect(cols.usedAt.name).toBe('used_at');
    expect(cols.createdAt.name).toBe('created_at');
  });

  it('uses `code` as a single-column primary key (no composite PK)', () => {
    expect(getTableConfig(inviteCodes).primaryKeys).toHaveLength(0);
    expect(getTableColumns(inviteCodes).code.primary).toBe(true);
  });

  it('leaves used_by / used_at NULLABLE and created_at NOT NULL', () => {
    const cols = getTableColumns(inviteCodes);
    // Both nullable by design: a freshly minted code is unused, and used_by stays
    // NULL for the whole production gate path until the createUser event fills it
    // (and again, permanently, after that account is deleted).
    expect(cols.usedBy.notNull).toBe(false);
    expect(cols.usedAt.notNull).toBe(false);
    expect(cols.createdAt.notNull).toBe(true);
    expect(cols.code.notNull).toBe(true);
  });

  it('stores used_at / created_at as bigint epoch-ms (db/schema.ts convention #1)', () => {
    const cols = getTableColumns(inviteCodes);
    expect(cols.usedAt.getSQLType()).toBe('bigint');
    expect(cols.createdAt.getSQLType()).toBe('bigint');
  });

  it('carries NO email or other PII column (plan §4 R-3)', () => {
    // Load-bearing, not cosmetic: "no PII here" + ON DELETE SET NULL is what makes
    // a hard-deleted user's residue in this table non-identifying WITHOUT PLT-01's
    // delete route needing to know the table exists. Any future "record who used
    // it, by email" change must go back through that delete path.
    const names = Object.values(getTableColumns(inviteCodes)).map((c) => c.name);
    expect(names).not.toContain('email');
    expect(names.some((n) => /email|name|image/.test(n))).toBe(false);
  });

  it('declares exactly one index: none (every lookup is by the PK)', () => {
    expect(getTableConfig(inviteCodes).indexes).toHaveLength(0);
  });
});

// --- Migration regression -----------------------------------------------------
describe('db/schema — invite_codes generated migration SQL', () => {
  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
  let combinedSql: string;
  let sqlFileCount: number;

  beforeAll(() => {
    const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    sqlFileCount = sqlFiles.length;
    combinedSql = sqlFiles
      .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
      .join('\n');
  });

  it('a NEW migration file was generated (append, never an edit of an existing one)', () => {
    expect(sqlFileCount).toBeGreaterThanOrEqual(4);
  });

  it('creates invite_codes', () => {
    expect(combinedSql).toMatch(/CREATE TABLE "invite_codes"/);
  });

  it('enforces used_by → users.id with ON DELETE set null (NOT cascade, NOT no action)', () => {
    // THE mechanical guard for db/schema.ts's invite_codes rules 1+2:
    //   * `no action` (the default) would make PLT-01's `DELETE FROM users` FAIL
    //     for every user who used a code — silently breaking PRD §5.6's hard
    //     delete.
    //   * `cascade` would delete the invite_codes row outright, destroying the
    //     "when was this code consumed" record that is the entire reason a table
    //     was chosen over an env-var list.
    expect(combinedSql).toMatch(
      /"invite_codes_used_by_users_id_fk"[\s\S]*?ON DELETE set null/,
    );
    expect(combinedSql).not.toMatch(
      /"invite_codes_used_by_users_id_fk"[\s\S]*?ON DELETE cascade/,
    );
  });
});

// --- Tier 3: real round-trip against PGlite -----------------------------------
describe('db/schema — invite_codes PGlite round-trip', () => {
  it(
    'applies the migration and round-trips a minted code',
    async () => {
      const client = new PGlite();
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: './db/migrations' });

      await db.insert(inviteCodes).values({ code: 'AAAA-BBBB-CCCC' });

      const [row] = await db.select().from(inviteCodes);
      expect(row.code).toBe('AAAA-BBBB-CCCC');
      expect(row.usedBy).toBeNull();
      expect(row.usedAt).toBeNull();
      // $defaultFn(() => Date.now()) runs client-side in drizzle, so a freshly
      // inserted row must carry a real epoch-ms number, not null.
      expect(typeof row.createdAt).toBe('number');
      expect(row.createdAt).toBeGreaterThan(1_700_000_000_000);

      await client.close();
    },
    30_000,
  );
});
