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

describe('auth.ts — readInviteCodeCookie (PLT-04: the invite code\'s only carrier)', () => {
  async function read(cookie?: string) {
    const { readInviteCodeCookie } = await import('@/auth');
    const req = cookie === undefined
      ? undefined
      : new Request('https://example.test/api/auth/callback/google', {
          headers: { cookie },
        });
    return readInviteCodeCookie(req);
  }

  it('returns undefined for no request at all (RSC / server-action invocation of the factory)', async () => {
    // next-auth calls the SAME config factory with `undefined` from React Server
    // Components and the signIn/signOut server actions — this must not throw.
    expect(await read()).toBeUndefined();
  });

  it('returns undefined when the request carries no Cookie header', async () => {
    const { readInviteCodeCookie } = await import('@/auth');
    expect(readInviteCodeCookie(new Request('https://example.test/'))).toBeUndefined();
  });

  it('finds gw_invite among several cookies, in any position', async () => {
    expect(await read('gw_invite=ABCD-EFGH-JKMN')).toBe('ABCD-EFGH-JKMN');
    expect(
      await read('authjs.csrf-token=xyz; gw_invite=ABCD-EFGH-JKMN; other=1'),
    ).toBe('ABCD-EFGH-JKMN');
    expect(await read('other=1; gw_invite=ABCD-EFGH-JKMN')).toBe('ABCD-EFGH-JKMN');
  });

  it('splits each pair at the FIRST "=" only (a co-resident cookie value may contain one)', async () => {
    // A base32 code contains no '=', but a neighbouring base64 cookie does; a
    // naive split('=') would mis-parse the whole header.
    expect(await read('authjs.session-token=abc==; gw_invite=ABCD-EFGH-JKMN')).toBe(
      'ABCD-EFGH-JKMN',
    );
  });

  it('URL-decodes the value', async () => {
    expect(await read('gw_invite=ABCD%2DEFGH')).toBe('ABCD-EFGH');
  });

  it('returns undefined for a malformed percent-escape instead of throwing', async () => {
    // decodeURIComponent('%zz') throws URIError; an attacker-controlled cookie
    // must never be able to crash the auth route.
    expect(await read('gw_invite=%zz')).toBeUndefined();
  });

  it('returns undefined for an empty or whitespace-only value', async () => {
    expect(await read('gw_invite=')).toBeUndefined();
    expect(await read('gw_invite=%20%20')).toBeUndefined();
  });

  it('rejects an over-long value before it can reach the database', async () => {
    expect(await read(`gw_invite=${'A'.repeat(200)}`)).toBeUndefined();
    expect(await read(`gw_invite=${'A'.repeat(64)}`)).toBe('A'.repeat(64));
  });

  it('rejects anything outside [A-Za-z0-9-]', async () => {
    // Defence in depth (drizzle parameterises every query), and it means nothing
    // shaped unlike a code ever reaches SQL.
    expect(await read("gw_invite=ABC'; DROP TABLE invite_codes;--")).toBeUndefined();
    expect(await read('gw_invite=ABC%20DEF')).toBeUndefined();
    expect(await read('gw_invite=%3Cscript%3E')).toBeUndefined();
  });

  it('ignores a cookie whose name merely CONTAINS gw_invite', async () => {
    expect(await read('xgw_invite=ABCD; gw_invite_old=WXYZ')).toBeUndefined();
  });

  it('accepts the exact shape scripts/generate-invite-codes.mjs mints', async () => {
    // End-to-end agreement check: a minted code the gate refuses to read would be
    // a silent break neither side\'s own tests would catch.
    expect(await read('gw_invite=K7QD-2M9V-XBTR')).toBe('K7QD-2M9V-XBTR');
  });
});

describe('auth.ts — createInviteGate.signIn (PLT-04 acceptance items 4 and 5)', () => {
  type Fakes = {
    exists: ReturnType<typeof vi.fn>;
    redeem: ReturnType<typeof vi.fn>;
    attribute: ReturnType<typeof vi.fn>;
  };

  async function gateWith(
    code: string | undefined,
    { existing = false, redeemResult = true }: { existing?: boolean; redeemResult?: boolean } = {},
  ) {
    const { createInviteGate } = await import('@/auth');
    const fakes: Fakes = {
      exists: vi.fn(async () => existing),
      redeem: vi.fn(async () => redeemResult),
      attribute: vi.fn(async () => undefined),
    };
    const gate = createInviteGate(code, {
      hasExistingUserWithEmail: fakes.exists as never,
      redeemInviteCode: fakes.redeem as never,
      attributeInviteCode: fakes.attribute as never,
    });
    return { gate, fakes };
  }

  const newUser = { email: 'newcomer@example.com' };

  it('REJECTS a new user with no invite code, and never touches the codes table (acceptance 4)', async () => {
    const { gate, fakes } = await gateWith(undefined);
    const ok = await gate.signIn({ user: newUser, account: { type: 'oauth' } });
    expect(ok).toBe(false);
    expect(fakes.redeem).not.toHaveBeenCalled();
  });

  it('REJECTS a new user whose code the atomic redemption refuses (invalid / already used) (acceptance 4)', async () => {
    const { gate, fakes } = await gateWith('BAD-CODE-0001', { redeemResult: false });
    const ok = await gate.signIn({ user: newUser, account: { type: 'oauth' } });
    expect(ok).toBe(false);
    expect(fakes.redeem).toHaveBeenCalledTimes(1);
  });

  it('ADMITS a new user with a valid code, consuming it with userId = null', async () => {
    // null, not user.id: no users row exists yet at gate time, and user.id here is
    // Google's `sub` — writing it into the used_by FK would violate the constraint
    // and fail every new sign-up.
    const { gate, fakes } = await gateWith('GOOD-CODE-001');
    const ok = await gate.signIn({ user: newUser, account: { type: 'oauth' } });
    expect(ok).toBe(true);
    expect(fakes.redeem).toHaveBeenCalledWith('GOOD-CODE-001', null);
  });

  it('ADMITS an EXISTING user with NO code, for BOTH providers, without consuming anything (acceptance 5)', async () => {
    for (const type of ['oauth', 'email'] as const) {
      const { gate, fakes } = await gateWith(undefined, { existing: true });
      const ok = await gate.signIn({
        user: { email: 'returning@example.com' },
        account: { type },
        email: type === 'email' ? { verificationRequest: true } : undefined,
      });
      expect(ok, type).toBe(true);
      expect(fakes.redeem, type).not.toHaveBeenCalled();
    }
  });

  it('does NOT charge an existing user a code even when one IS present in the cookie', async () => {
    const { gate, fakes } = await gateWith('GOOD-CODE-001', { existing: true });
    const ok = await gate.signIn({
      user: { email: 'returning@example.com' },
      account: { type: 'oauth' },
    });
    expect(ok).toBe(true);
    expect(fakes.redeem).not.toHaveBeenCalled();
  });

  it('gates the magic-link REQUEST (email.verificationRequest === true) but NOT the click', async () => {
    // @auth/core calls signIn twice for the email provider. Gating the REQUEST is
    // what stops POST /api/auth/signin/resend being a free, ungated email-sending
    // amplifier; re-gating the CLICK would deny every user who opens the link on a
    // different device, where the cookie does not exist.
    const requestStep = await gateWith(undefined);
    expect(
      await requestStep.gate.signIn({
        user: newUser,
        account: { type: 'email' },
        email: { verificationRequest: true },
      }),
    ).toBe(false);

    const clickStep = await gateWith(undefined);
    expect(
      await clickStep.gate.signIn({ user: newUser, account: { type: 'email' } }),
    ).toBe(true);
    expect(clickStep.fakes.redeem).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the redemption query throws (DB outage ⇒ AccessDenied, never an open door)', async () => {
    const { createInviteGate } = await import('@/auth');
    const gate = createInviteGate('GOOD-CODE-001', {
      hasExistingUserWithEmail: (async () => false) as never,
      redeemInviteCode: (async () => {
        throw new Error('connection refused');
      }) as never,
    });
    await expect(
      gate.signIn({ user: newUser, account: { type: 'oauth' } }),
    ).rejects.toThrow('connection refused');
  });

  it('treats a user with no email as new (fails closed)', async () => {
    const { gate } = await gateWith(undefined);
    expect(await gate.signIn({ user: { email: null }, account: { type: 'oauth' } })).toBe(
      false,
    );
    expect(await gate.signIn({})).toBe(false);
  });
});

describe('auth.ts — createInviteGate.createUser (attribution is advisory and must never throw)', () => {
  it('attributes the code to the freshly created users.id', async () => {
    const { createInviteGate } = await import('@/auth');
    const attribute = vi.fn(async () => undefined);
    const gate = createInviteGate('GOOD-CODE-001', {
      attributeInviteCode: attribute as never,
    });
    await gate.createUser({ user: { id: 'user-123' } });
    expect(attribute).toHaveBeenCalledWith('GOOD-CODE-001', 'user-123');
  });

  it('is a no-op when no cookie was present', async () => {
    const { createInviteGate } = await import('@/auth');
    const attribute = vi.fn(async () => undefined);
    const gate = createInviteGate(undefined, { attributeInviteCode: attribute as never });
    await gate.createUser({ user: { id: 'user-123' } });
    expect(attribute).not.toHaveBeenCalled();
  });

  it('SWALLOWS a throwing attribution — @auth/core would otherwise turn it into a CallbackRouteError that fails a sign-in whose account row already exists', async () => {
    const { createInviteGate } = await import('@/auth');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const gate = createInviteGate('GOOD-CODE-001', {
        attributeInviteCode: (async () => {
          throw new Error('boom');
        }) as never,
      });
      await expect(gate.createUser({ user: { id: 'user-123' } })).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
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

describe('auth.ts — buildAuthConfig(req) composes the invite gate onto the per-request config (PLT-04)', () => {
  const DUMMY_URL = 'postgresql://user:pass@fake-host.example.invalid/db';

  it('overrides callbacks.signIn and installs events.createUser when a request is supplied', async () => {
    process.env.DATABASE_URL = DUMMY_URL;
    const { buildAuthConfig } = await import('@/auth');
    const config = await buildAuthConfig(
      new Request('https://example.test/api/auth/callback/google', {
        headers: { cookie: 'gw_invite=ABCD-EFGH-JKMN' },
      }),
    );

    expect(typeof config.callbacks?.signIn).toBe('function');
    expect(typeof config.events?.createUser).toBe('function');
  });

  it('PRESERVES auth.config.ts\'s session callback (FND-08 finding #2 — session-token leak regression)', async () => {
    // The gate spreads ...authConfig.callbacks rather than retyping the object.
    // Dropping the session callback would return the raw AdapterSession — which
    // carries `sessionToken`, the exact httpOnly cookie value — to any same-origin
    // script.
    process.env.DATABASE_URL = DUMMY_URL;
    const { buildAuthConfig } = await import('@/auth');
    const authConfig = (await import('@/auth.config')).default;
    const config = await buildAuthConfig(new Request('https://example.test/'));

    expect(config.callbacks?.session).toBe(authConfig.callbacks.session);
  });

  it('still works with NO request at all (the RSC / server-action invocation)', async () => {
    process.env.DATABASE_URL = DUMMY_URL;
    const { buildAuthConfig } = await import('@/auth');
    const config = await buildAuthConfig();
    expect(config.adapter).toBeDefined();
    expect(typeof config.callbacks?.signIn).toBe('function');
  });

  it('leaves auth.config.ts\'s STATIC config untouched (auth.config.test.ts must stay green)', async () => {
    process.env.DATABASE_URL = DUMMY_URL;
    const { signInCallback } = await import('@/auth.config');
    const authConfig = (await import('@/auth.config')).default;
    // The override lives ONLY on the per-request object buildAuthConfig returns.
    expect(authConfig.callbacks.signIn).toBe(signInCallback);
  });
});
