import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from '@/db/schema';
import { inviteCodes, users } from '@/db/schema';

// -----------------------------------------------------------------------------
// PLT-04 — invite-code gated registration (PRD §9: "上线初期以邀请码控制注册节奏").
//
// READ THIS HEADER BEFORE CHANGING ANYTHING IN THIS FILE.
//
// 1. `redeemInviteCode` MUST STAY A SINGLE GUARDED `UPDATE ... RETURNING`.
//    NEVER "improve" it into a SELECT-then-UPDATE (a read-check plus a write).
//    That refactor silently reintroduces the exact double-redemption race the
//    ticket names as a P0: two concurrent sign-ups would both see "unused" and
//    both proceed, defeating the registration-pacing control PRD §9 relies on.
//    Under Postgres READ COMMITTED the single statement is single-winner — the
//    loser blocks on the winner's row lock, then re-evaluates its `used_at IS
//    NULL` qual against the committed row and matches nothing. Contrast FND-06's
//    quota check, which explicitly ACCEPTS a documented race; this one must not.
//
// 2. `used_at IS NULL` — NEVER `used_by IS NULL` — is the authoritative "this code
//    is unused" predicate. `invite_codes.used_by` is an `ON DELETE SET NULL` FK
//    (db/schema.ts), so PLT-01's account hard-delete (PRD §5.6) nulls it while
//    leaving the code spent. A `used_by`-based guard would put a spent code back
//    into circulation the moment its redeemer deleted their account.
//
// 3. BUILD-TIME SAFETY: no top-level `@/db/index` import — see dbIndex() below.
//    `@/auth` imports this module (dynamically) and `middleware.ts` imports
//    `@/auth`, so this module's static graph reaches both the Edge middleware
//    bundle and `next build`'s "Collecting page data" phase. db/index.ts throws at
//    import time without DATABASE_URL (an intentional, tested FND-05 fail-fast).
//
// 4. NORMALIZATION LIVES IN EXACTLY ONE PLACE (`normalizeInviteCode`).
//    scripts/generate-invite-codes.mjs mints codes in this canonical form, so a
//    stored code is always reachable by a user who typed it in any case or with
//    surrounding whitespace. If the accepted shape changes here, the generator's
//    alphabet/length must be re-checked against it — tests/generate-invite-codes.
//    test.ts pins the round-trip mechanically. Nothing that fails normalization
//    ever reaches SQL.
//
// 5. NEVER LOG A CODE OR AN EMAIL from this module. The gate returns bare booleans
//    on purpose: nothing distinguishes "no such code" from "already used" from
//    "you need a code" (PRD §12 / §8.3 privacy posture).
// -----------------------------------------------------------------------------

// The promise is MEMOIZED so one module instance issues EXACTLY ONE
// import('@/db/index') and concurrent callers await the same in-flight promise.
// Load-bearing, not a micro-optimization (verbatim the reason lib/db/queries/
// admin.ts:64-73 and library.ts record): vitest's mocker re-resolves a
// vi.doMock-ed specifier on EVERY import() call, and two import()s issued in the
// same tick race — one gets the mock, the other loads the REAL module and dies on
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

/**
 * The common supertype of every Drizzle client these queries can run against: the
 * neon-http `db` and the PGlite client the tests inject. Defined LOCALLY, mirroring
 * lib/db/queries/admin.ts:99-103 — a short type alias is cheaper than a cross-module
 * coupling. The duplication is deliberate.
 */
export type Executor = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * `executor` and `now` are ADDITIVE and optional — every function below still holds
 * the ticket's stated signature when called with no options, which is how the
 * production sign-in gate calls them. Same precedent LIB-02/PLT-03 set.
 *
 * `now` exists so timestamp assertions are exact instead of racing the wall clock,
 * without fake timers (PGlite drives a WASM runtime through async scheduling; its
 * interaction with faked timers is unverified in this repo) — exactly as
 * lib/db/queries/admin.ts:105-117 documents.
 */
export type InviteCodeQueryOptions = { executor?: Executor; now?: number };

async function resolveDb(opts?: InviteCodeQueryOptions): Promise<Executor> {
  if (opts?.executor) return opts.executor;
  // `dbTx` is not needed anywhere here: every write is a single statement, which
  // Postgres already runs in its own implicit transaction.
  const { db } = await dbIndex();
  return db;
}

/**
 * The canonical code form: trimmed, upper-cased, and shape-checked. Returns `null`
 * for anything that cannot be a code, so no caller ever builds a query from
 * unvalidated input.
 *
 * The shape is deliberately permissive about WHICH characters (A-Z, 0-9, `-`) and
 * strict about the character CLASS: `;`, quotes, whitespace-in-the-middle and every
 * other metacharacter are rejected outright. Length 4..64 comfortably contains
 * scripts/generate-invite-codes.mjs's 10-character output while leaving room for a
 * future format change (see header rule 4 before making one).
 */
export function normalizeInviteCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase();
  return /^[A-Z0-9-]{4,64}$/.test(value) ? value : null;
}

/**
 * ATOMIC single-winner redemption (ticket Deliverable 2, acceptance items 1-3).
 *
 * ONE statement, no read-then-write (header rule 1):
 *
 *     UPDATE invite_codes SET used_at = $now, used_by = $userId
 *      WHERE code = $code AND used_at IS NULL
 *      RETURNING code
 *
 * → `true` iff exactly one row came back.
 *
 * `userId` is WIDENED to `string | null` versus the ticket's literal
 * `(code: string, userId: string)`. Reason (docs/plans/PLT-04.md §0 facts 3-5):
 * production calls this from the Auth.js `signIn` callback, which runs BEFORE the
 * `users` row exists, and whose `user.id` is a value @auth/drizzle-adapter will
 * throw away (it strips the incoming id when the users table's id column has a
 * default — ours does). Writing that id would trip the `used_by` FK. Passing `null`
 * claims the code atomically; `attachInviteCodeUser()` fills in the attribution once
 * the row exists. Callers that DO hold a real `users.id` (the tests, any future call
 * site) pass it and get the ticket's exact one-shot behaviour.
 *
 * Deliberately does NOT catch an FK violation: passing a `userId` with no `users`
 * row is a programming error and must fail loudly.
 */
export async function redeemInviteCode(
  code: string,
  userId: string | null,
  opts?: InviteCodeQueryOptions,
): Promise<boolean> {
  const normalized = normalizeInviteCode(code);
  if (normalized === null) return false;

  const db = await resolveDb(opts);
  const rows = await db
    .update(inviteCodes)
    .set({ usedAt: opts?.now ?? Date.now(), usedBy: userId })
    .where(and(eq(inviteCodes.code, normalized), isNull(inviteCodes.usedAt)))
    .returning({ code: inviteCodes.code });

  return rows.length === 1;
}

/**
 * Best-effort attribution once the `users` row finally exists (the sub-PRD's
 * "谁用了、何时用" tracking):
 *
 *     UPDATE invite_codes SET used_by = $userId
 *      WHERE code = $code AND used_by IS NULL AND used_at IS NOT NULL
 *
 * Both extra conjuncts matter: `used_at IS NOT NULL` refuses to attribute a code
 * that was never claimed (so this can never be used as a back-door redemption), and
 * `used_by IS NULL` refuses to overwrite somebody else's attribution.
 *
 * Returns `false` — never throws — when nothing matched.
 */
export async function attachInviteCodeUser(
  code: string,
  userId: string,
  opts?: InviteCodeQueryOptions,
): Promise<boolean> {
  const normalized = normalizeInviteCode(code);
  if (normalized === null) return false;

  const db = await resolveDb(opts);
  const rows = await db
    .update(inviteCodes)
    .set({ usedBy: userId })
    .where(
      and(
        eq(inviteCodes.code, normalized),
        isNull(inviteCodes.usedBy),
        isNotNull(inviteCodes.usedAt),
      ),
    )
    .returning({ code: inviteCodes.code });

  return rows.length === 1;
}

/**
 * EXACT-match `users.email` existence check — the gate's new-vs-existing test.
 *
 * This mirrors @auth/core's OWN determination: both the email and the OAuth login
 * paths branch on `getUserByEmail(<address>)`, an exact-match adapter lookup (a hit
 * means "existing user", a miss means `createUser` runs). See docs/plans/PLT-04.md
 * §0 fact 2.
 *
 * MUST STAY CASE-SENSITIVE. A case-insensitive hit where upstream would still create
 * a brand-new user is a SILENT INVITE-GATE BYPASS: the gate would wave the sign-up
 * through as "existing" and no code would ever be redeemed. Do not add `lower(...)`
 * here for "robustness" — invite-codes.test.ts asserts the case-sensitivity directly.
 *
 * Never logs or returns the address.
 */
export async function isExistingUserEmail(
  email: string,
  opts?: InviteCodeQueryOptions,
): Promise<boolean> {
  if (typeof email !== 'string' || email.length === 0) return false;

  const db = await resolveDb(opts);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return rows.length === 1;
}
