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
