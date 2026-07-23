import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { inviteCodes } from '@/db/schema';
import { normalizeInviteCode } from '@/lib/db/queries/invite-codes';

import {
  ALPHABET,
  CODE_LENGTH,
  DEFAULT_COUNT,
  MAX_COUNT,
  generateCode,
  main,
  parseCount,
} from '../scripts/generate-invite-codes.mjs';

// PLT-04 Deliverable 3. The script ships executable code, its CSPRNG choice is
// security-relevant, and its raw-SQL table/column names duplicate the schema on
// purpose — all three need pinning. Imports the .mjs directly, the same way
// tests/backup.test.ts imports .github/scripts/backup.mjs.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = path.join(repoRoot, 'scripts', 'generate-invite-codes.mjs');
const source = readFileSync(scriptPath, 'utf8');

/**
 * The script's own comments NAME `Math.random()` (to forbid it), so the CSPRNG guard
 * below must look at executable code only — otherwise it trips on the very comment
 * that documents the rule. Same scoping problem tests/backup.test.ts:63-68 solved for
 * its own guard. Deliberately crude: this is a lint-grade check over one small file,
 * not a JS parser.
 */
const executableSource = source
  .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. JSDoc)
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('#!'))
  .join('\n');

describe('generateCode', () => {
  it('draws CODE_LENGTH characters from ALPHABET only', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      for (const ch of code) expect(ALPHABET).toContain(ch);
    }
  });

  it('produces 500 distinct codes in a row (no degenerate generator)', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateCode()));
    expect(codes.size).toBe(500);
  });

  it('the alphabet excludes the confusable characters I, L, O, 0 and 1', () => {
    for (const ch of ['I', 'L', 'O', '0', '1']) expect(ALPHABET).not.toContain(ch);
  });

  // THE TEST THAT PREVENTS A MINTED CODE FROM BEING UNREDEEMABLE. The generator and
  // the redeemer must agree on the canonical form or a code Horace hands out simply
  // will not work.
  it('a minted code round-trips through normalizeInviteCode unchanged', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCode();
      expect(normalizeInviteCode(code)).toBe(code);
    }
  });
});

describe('CSPRNG requirement (security — a guessable code bypasses PRD §9 pacing)', () => {
  it('the script uses node:crypto and never Math.random', () => {
    expect(executableSource).toContain('node:crypto');
    expect(executableSource).toContain('randomInt');
    expect(executableSource).not.toContain('Math.random');
    // Belt: the comment that forbids it must survive too, so the reason stays with
    // the code rather than only in this test.
    expect(source).toMatch(/NOT Math\.random/);
  });

  it('the code space stays large enough that brute force is not credible', () => {
    // 31^10 ≈ 8.2e14 ≈ 2^49.5. If the alphabet or length is ever shortened, the
    // no-rate-limiting argument in docs/plans/PLT-04.md §4 R6 must be redone.
    expect(Math.log2(ALPHABET.length ** CODE_LENGTH)).toBeGreaterThan(40);
  });
});

describe('parseCount', () => {
  it('accepts --count N and --count=N', () => {
    expect(parseCount(['--count', '20'])).toBe(20);
    expect(parseCount(['--count=20'])).toBe(20);
  });

  it('defaults to DEFAULT_COUNT with no flag', () => {
    expect(parseCount([])).toBe(DEFAULT_COUNT);
    expect(DEFAULT_COUNT).toBe(10);
  });

  it('rejects 0, negatives, non-numbers, exponent notation and over-MAX values', () => {
    for (const bad of ['0', '-1', 'abc', '1e9', '', '12.0', '0x10']) {
      expect(() => parseCount(['--count', bad])).toThrow();
    }
    expect(() => parseCount(['--count', String(MAX_COUNT + 1)])).toThrow();
    expect(parseCount(['--count', String(MAX_COUNT)])).toBe(MAX_COUNT);
  });
});

describe('raw-SQL duplication is pinned to the real schema', () => {
  // The script cannot import @/db/schema (a .mjs cannot resolve a TS module behind
  // the `@/` alias without a strip-types launcher), so the names are duplicated. This
  // is the guard that the duplication stays true.
  it('the INSERT names the table and columns the drizzle table actually has', () => {
    const cols = getTableColumns(inviteCodes);
    expect(getTableName(inviteCodes)).toBe('invite_codes');
    expect(executableSource).toContain('insert into invite_codes (code, created_at)');
    expect(cols.code.name).toBe('code');
    expect(cols.createdAt.name).toBe('created_at');
  });

  it('does not insert used_at / used_by — a minted code must start UNUSED', () => {
    // `used_at IS NULL` is the "unused" predicate; a generator that stamped used_at
    // would mint dead codes.
    expect(executableSource).not.toMatch(/insert into invite_codes[^;]*used_at/);
  });
});

describe('main() — behaviour without a database', () => {
  it('fails loudly (exit 1) when DATABASE_URL is unset — no silent no-op', async () => {
    const errs: string[] = [];
    const outs: string[] = [];
    const status = await main(['--count', '5'], {}, {
      log: (l: string) => outs.push(l),
      warn: (l: string) => errs.push(l),
    });

    expect(status).toBe(1);
    expect(outs).toEqual([]); // nothing printed as if it had been minted
    expect(errs.join('\n')).toMatch(/DATABASE_URL is not set/);
  });

  it('rejects a bad --count before ever touching the database', async () => {
    let connected = false;
    const errs: string[] = [];
    const status = await main(
      ['--count', 'abc'],
      { DATABASE_URL: 'postgres://example-not-real/db' },
      {
        warn: (l: string) => errs.push(l),
        connect: async () => {
          connected = true;
          return (() => []) as never;
        },
      },
    );

    expect(status).toBe(1);
    expect(connected).toBe(false);
    expect(errs.join('\n')).toMatch(/--count/);
  });

  it('inserts exactly `count` codes, prints them one per line, and exits 0', async () => {
    const inserted: string[] = [];
    const outs: string[] = [];
    // A stand-in tagged-template `sql` — no driver, no network. Mirrors what
    // `on conflict do nothing returning code` yields on success.
    const fakeSql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const code = values[0] as string;
      inserted.push(code);
      return Promise.resolve([{ code }]);
    };

    const status = await main(
      ['--count', '7'],
      { DATABASE_URL: 'postgres://example-not-real/db' },
      {
        log: (l: string) => outs.push(l),
        warn: () => {},
        connect: async () => fakeSql as never,
        now: 1_700_000_000_000,
      },
    );

    expect(status).toBe(0);
    expect(inserted).toHaveLength(7);
    expect(outs).toEqual(inserted);
    for (const code of outs) expect(normalizeInviteCode(code)).toBe(code);
  });

  it('NEVER prints a code it did not newly insert, and exits non-zero on repeated collision', async () => {
    // `on conflict (code) do nothing returning code` yields zero rows on collision.
    // Printing the colliding code would hand out somebody else's live invite.
    const outs: string[] = [];
    const errs: string[] = [];
    const status = await main(
      ['--count', '3'],
      { DATABASE_URL: 'postgres://example-not-real/db' },
      {
        log: (l: string) => outs.push(l),
        warn: (l: string) => errs.push(l),
        connect: async () => (() => Promise.resolve([])) as never,
      },
    );

    expect(status).toBe(1);
    expect(outs).toEqual([]);
    expect(errs.join('\n')).toMatch(/failed to insert a unique invite code/);
  });
});

describe('running the script as a CLI', () => {
  it('exits non-zero with an actionable message when DATABASE_URL is unset', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;

    const result = spawnSync('node', [scriptPath, '--count', '3'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout ?? '').toBe('');
    expect(result.stderr ?? '').toMatch(/DATABASE_URL is not set/);
    expect(result.stderr ?? '').toMatch(/\.env\.example/);
  });
});
