import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from '@/db/schema';
import { inviteCodes, users } from '@/db/schema';

// -----------------------------------------------------------------------------
// PLT-04 — invite-code gated registration (PRD §9: "上线初期以邀请码控制注册节奏").
//
// READ THIS HEADER BEFORE CHANGING ANYTHING IN THIS FILE.
//
// 1. THE ATOMICITY HERE IS THE POINT. `redeemInviteCode` is the ONE operation in
//    this repo where a race must be actively PREVENTED rather than documented and
//    accepted (contrast lib/config/quota.ts, whose check/record race is explicitly
//    tolerated): a double-redeemed invite code defeats the registration-pacing
//    control PRD §9 relies on. See redeemInviteCode's own comment for the exact
//    Postgres semantics that carry the guarantee — and for the two shapes
//    (SELECT-then-UPDATE, and guarding on `used_by`) that silently destroy it.
//
// 2. BUILD-TIME SAFETY: no top-level `import { db } from '@/db/index'`. This
//    module is imported by auth.ts, which `next build` pulls into the static graph
//    for BOTH the app/api/auth/[...nextauth] route and middleware.ts. db/index.ts
//    throws at import time when DATABASE_URL is unset (an intentional, tested
//    FND-05 fail-fast), so a static import here re-breaks the clean-checkout
//    `pnpm build` that FND-08 already had to bounce-fix once. Use dbIndex() below.
//    lib/db/queries/invite-codes.test.ts pins this mechanically.
//
// 3. `db` (neon-http) ONLY — never `dbTx`, never `.transaction()`. neon-http's
//    `.transaction()` throws unconditionally (db/index.ts:30-39). Every function
//    here is deliberately ONE statement, so no transaction is wanted either.
// -----------------------------------------------------------------------------

// Memoized lazy `@/db/index` import — copied verbatim in shape from
// lib/db/queries/admin.ts:74-88 (which records the full reasoning). The memo is
// required for TESTABILITY, not performance: vitest's mocker re-resolves a
// vi.doMock-ed specifier on EVERY import() call, so two import()s issued in the
// same tick race — one gets the mock, the other loads the real module and dies on
// the DATABASE_URL fail-fast. A REJECTED import is deliberately not cached, so one
// transient failure does not poison the module for the process lifetime.
let dbIndexPromise: Promise<typeof import('@/db/index')> | null = null;

function dbIndex(): Promise<typeof import('@/db/index')> {
  dbIndexPromise ??= import('@/db/index').catch((err: unknown) => {
    dbIndexPromise = null;
    throw err;
  });
  return dbIndexPromise;
}

/** The neon-http client. Never `dbTx` — see header rule 3. */
async function defaultDb(): Promise<Executor> {
  const { db } = await dbIndex();
  return db;
}

/**
 * The common supertype of every Drizzle client these queries can run against: the
 * neon-http `db` and the PGlite client the tests inject. Declared LOCALLY,
 * mirroring lib/db/queries/admin.ts:99-103 and lib/db/queries/library.ts — a
 * four-line alias is cheaper than a cross-module coupling. The duplication is
 * deliberate.
 */
export type Executor = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Additive, optional; every function still works when called with no options. */
export type InviteCodeQueryOptions = { executor?: Executor };

/**
 * Atomically consume `code` if it exists and has never been consumed. Returns
 * `true` iff THIS call is the one that consumed it.
 *
 * `userId` is `string | null` because at the moment the gate runs there is NO
 * `users` row yet, for either provider: @auth/core calls `callbacks.signIn` BEFORE
 * `handleLoginOrRegister` creates the user, and the id it hands the callback is
 * Google's `sub` (or a throwaway `crypto.randomUUID()` for the email provider),
 * which @auth/drizzle-adapter then DISCARDS in favour of `users.id`'s own
 * `$defaultFn`. Writing that id into the `used_by` FK would violate the constraint
 * and fail every new sign-up. Production therefore passes `null` and attribution
 * happens later, in auth.ts's `createUser` event, via `attributeInviteCode`.
 *
 * WHY THIS EXACT SHAPE — one guarded UPDATE ... RETURNING, no read-then-write and
 * no transaction:
 *
 *   - Postgres evaluates `UPDATE … WHERE` under READ COMMITTED by taking a row
 *     lock and then RE-CHECKING the predicate against the updated row
 *     (EvalPlanQual). Two concurrent redemptions of the same code therefore
 *     produce exactly ONE updated row; the loser re-evaluates `used_at IS NULL`
 *     against the winner's committed version, matches zero rows, and returns
 *     false. A `SELECT` followed by an `UPDATE` has a genuine TOCTOU window and
 *     MUST NOT be used here.
 *   - The guard is `used_at IS NULL`, NEVER `used_by IS NULL` (db/schema.ts's
 *     invite_codes rule 1): `used_by` is nulled by ON DELETE SET NULL when an
 *     account is hard-deleted, so a `used_by` guard would free the code for re-use
 *     and let one code mint unlimited accounts by delete-and-re-register.
 *   - A nonexistent code and an already-used code take the SAME path and write
 *     ZERO rows — "returns false without modifying any row" is structural, not a
 *     branch someone can forget.
 *
 * LIMIT OF THE OFFLINE PROOF: the tests run against PGlite, a SINGLE-CONNECTION
 * WASM Postgres, so parallel calls there are serialised. They prove the guarded
 * predicate rejects the second redeemer; they do NOT exercise real row-lock
 * contention. Verifying that against a live Neon instance under genuine parallel
 * load is PLT-04's Feedback obligation #1 and is still OPEN (plan §5 Q1).
 *
 * `now` is injectable so timestamp assertions are exact instead of racing the wall
 * clock (same precedent as lib/db/queries/admin.ts's `now`).
 */
export async function redeemInviteCode(
  code: string,
  userId: string | null,
  opts?: InviteCodeQueryOptions & { now?: number },
): Promise<boolean> {
  const db = opts?.executor ?? (await defaultDb());

  const rows = await db
    .update(inviteCodes)
    .set({ usedBy: userId, usedAt: opts?.now ?? Date.now() })
    .where(and(eq(inviteCodes.code, code), isNull(inviteCodes.usedAt)))
    .returning({ code: inviteCodes.code });

  return rows.length === 1;
}

/**
 * Best-effort attribution: record WHICH user an already-claimed code produced. Called from
 * auth.ts's `createUser` event, the first moment a real `users.id` exists.
 *
 * The `used_at IS NOT NULL` conjunct means this can only ever ANNOTATE a code that
 * was genuinely claimed — it can never claim one, so it is not a second, unguarded
 * redemption path. The `used_by IS NULL` conjunct makes it idempotent and stops it
 * overwriting an earlier attribution.
 *
 * Returns `void` on purpose: `used_by` is advisory and no caller may branch on the
 * outcome (db/schema.ts's invite_codes rule 3). A no-op is a legitimate,
 * uninteresting outcome.
 */
export async function attributeInviteCode(
  code: string,
  userId: string,
  opts?: InviteCodeQueryOptions,
): Promise<void> {
  const db = opts?.executor ?? (await defaultDb());

  await db
    .update(inviteCodes)
    .set({ usedBy: userId })
    .where(
      and(
        eq(inviteCodes.code, code),
        isNull(inviteCodes.usedBy),
        isNotNull(inviteCodes.usedAt),
      ),
    );
}

/**
 * Does a `users` row with exactly this email already exist?
 *
 * WHY IT LIVES HERE and not in a general `lib/db/queries/users.ts`: it exists
 * SOLELY as the invite gate's new-vs-existing discriminator. @auth/core's
 * `callbacks.signIn` carries no `isNewUser` signal and the `user.id` it passes is
 * not a `users.id` (see redeemInviteCode), so an email lookup is the only reliable
 * discriminator left. It is not a general user lookup and must not grow into one;
 * a real users-query module is outside PLT-04's file scope.
 *
 * EXACT MATCH, DELIBERATELY. @auth/drizzle-adapter's `getUserByEmail` is an exact
 * `eq`, and @auth/core's `handleLoginOrRegister` uses that to decide whether to
 * CREATE a user. Matching case-insensitively here would make this gate and the
 * adapter disagree about who is new — an existing user would be waved through by
 * one and charged a code by the other. (@auth/core's email provider already
 * lower-cases and trims before anything reaches us.)
 *
 * FAILS CLOSED: null/undefined/empty email ⇒ `false` ⇒ treated as a NEW user ⇒ an
 * invite code is required. And if this THROWS (DB outage), auth.ts's gate turns
 * that into AccessDenied — which locks out existing users too, not just new ones.
 * That blast radius is accepted for a launch gate; know it before an outage
 * surprises you (plan §4 R-8).
 */
export async function hasExistingUserWithEmail(
  email: string | null | undefined,
  opts?: InviteCodeQueryOptions,
): Promise<boolean> {
  if (!email) return false;

  const db = opts?.executor ?? (await defaultDb());

  const rows = await db
    .select({ one: sql<number>`1` })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return rows.length > 0;
}
