import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// FND-08 Reviewer bounce-fix regression tests for finding #1: a clean-checkout
// `pnpm build` exited 1 because `next build`'s "Collecting page data" step imports
// the app/api/auth/[...nextauth] route → @/auth → (previously) @/auth.config →
// @/db/index, and db/index.ts throws at import time when DATABASE_URL is unset (an
// intentional FND-05 fail-fast, enforced by db/index.test.ts — we must NOT weaken
// it). The fix: auth.ts uses Auth.js v5's lazy `NextAuth(async () => …)` config
// factory (buildAuthConfig), so the `db` import is DEFERRED to request time and
// never runs during module evaluation / page-data collection.
//
// Why `next-auth` is mocked here: importing the real next-auth runtime under
// Vitest fails (its lib/env.js imports `next/server`, which Node's ESM resolver
// can't load for the nested package outside Next's bundler) — the same reason
// middleware.test.ts / session.test.ts mock @/auth. We mock ONLY next-auth's
// default `NextAuth` export (used solely for the top-level destructure in auth.ts);
// everything DB-relevant — @/db/index, @/db/schema, @auth/drizzle-adapter,
// @/auth.config, and buildAuthConfig itself — runs for real, so the DB-freeness
// invariant and the adapter wiring are both tested faithfully. The genuine
// end-to-end proof that `pnpm build` now succeeds without DATABASE_URL is the build
// step itself (see FND-08 changelog); this suite locks the structural invariant in.
vi.mock('next-auth', () => ({
  // NextAuth(buildAuthConfig) is called at auth.ts module top; the mock ignores its
  // argument and returns the standard handler shape so the destructure succeeds.
  default: () => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

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

describe('auth.ts — build-time DB independence (clean-checkout `pnpm build` blocker regression)', () => {
  it('imports @/auth with DATABASE_URL UNSET and does not throw (page-data collection stays DB-free)', async () => {
    delete process.env.DATABASE_URL;
    // If @/auth (or anything it STATICALLY imports — @/auth.config, @/db/schema,
    // @auth/drizzle-adapter) pulled in @/db/index, this import would reject with the
    // DATABASE_URL fail-fast — exactly the error that broke `pnpm build`. The
    // next-auth mock does not touch @/db/index, so this genuinely guards finding #1:
    // it resolves only because the `db` import is deferred into buildAuthConfig().
    await expect(import('@/auth')).resolves.toBeDefined();
  });

  it('exports the lazy factory (buildAuthConfig) without needing DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;
    const mod = await import('@/auth');
    // NextAuth(buildAuthConfig) does NOT invoke the factory at construction (Auth.js
    // only calls it per-request), so buildAuthConfig is reachable with no
    // DATABASE_URL set and no db import has happened yet.
    expect(typeof mod.buildAuthConfig).toBe('function');
  });
});

describe('auth.ts — buildAuthConfig() wires the Drizzle adapter at request time (Deliverable 1)', () => {
  it('returns a config with a defined adapter + the Google/Resend providers once DATABASE_URL is present', async () => {
    // neon() construction is lazy/network-free with a syntactically valid dummy
    // URL — same proven pattern as db/index.test.ts. buildAuthConfig runs the REAL
    // DrizzleAdapter(db, …) + real @/auth.config; this preserves the adapter-wiring
    // coverage that used to live on auth.config and is what the running app invokes
    // per-request.
    process.env.DATABASE_URL =
      'postgresql://user:pass@fake-host.example.invalid/db';
    const { buildAuthConfig } = await import('@/auth');
    const config = await buildAuthConfig();

    expect(config.adapter).toBeDefined();
    expect(config.session?.strategy).toBe('database');
    const ids = config.providers.map((p) =>
      typeof p === 'function' ? undefined : p.id,
    );
    expect(ids).toContain('google');
    expect(ids).toContain('resend');
  });
});
