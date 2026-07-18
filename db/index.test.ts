import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Deliverable 2's literal text: db/index.ts must "throw a clear error at import
// time if the env var is missing", and must NOT make any network call at
// construction time (so it is unit-testable with a dummy URL and no live Neon).
// Each case resets the module registry so the top-level import-time code re-runs.

const ORIGINAL_URL = process.env.DATABASE_URL;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_URL;
  }
});

describe('db/index — fail-fast on missing DATABASE_URL', () => {
  it('throws an error mentioning DATABASE_URL when the env var is unset', async () => {
    delete process.env.DATABASE_URL;
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });

  it('constructs the client (no throw, no network call) with a syntactically valid dummy URL', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@fake-host.example.invalid/db';
    const mod = await import('@/db/index');
    expect(mod.db).toBeDefined();
  });
});

// PLT-01 additive `dbTx` export (neon-serverless, transaction-capable). Same two
// invariants as `db` above: fail-fast when DATABASE_URL is unset, and lazy
// construction (no network) with a dummy URL. The fail-fast is a single
// module-level throw shared by both exports, so the "unset → reject" case is
// exercised here against the same import for `dbTx`'s sake explicitly.
describe('db/index — dbTx (transaction-capable export)', () => {
  it('the module import rejects (mentioning DATABASE_URL) when the env var is unset — dbTx is never constructed', async () => {
    delete process.env.DATABASE_URL;
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });

  it('constructs dbTx with a transaction() method (no throw, no network call) with a dummy URL', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@fake-host.example.invalid/db';
    const mod = await import('@/db/index');
    expect(mod.dbTx).toBeDefined();
    // The whole point of this export: it exposes a real interactive transaction
    // API (unlike neon-http's `db`, whose .transaction() throws). Constructing
    // it must not open a socket — the Pool is lazy until the first query.
    expect(typeof mod.dbTx.transaction).toBe('function');
  });
});
