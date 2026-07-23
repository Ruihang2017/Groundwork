#!/usr/bin/env node
// PLT-04 Deliverable 3 — mint N unused invite codes into the `invite_codes` table.
//
//     node scripts/generate-invite-codes.mjs --count 20
//     node scripts/generate-invite-codes.mjs --count 20 > codes.txt
//
// The generated codes are printed ONE PER LINE TO STDOUT (the human summary goes to
// stderr, so the redirect above yields a clean distributable list). Horace then
// distributes them MANUALLY — email, Slack, wherever — OUTSIDE this system. That is
// the point: PRD §9's "上线初期以邀请码控制注册节奏" is an operational pacing lever
// Horace operates, not a self-service feature. There is deliberately no referral
// flow and no "invite a friend" endpoint (ticket Non-goals).
//
// Codes NEVER EXPIRE. They are valid until redeemed, indefinitely, unless Horace
// removes the row by hand (ticket Non-goals: no TTL). Redemption is what spends a
// code — see lib/db/queries/invite-codes.ts.
//
// This is a HUMAN-RUN OPS TOOL, so it FAILS LOUDLY on a missing DATABASE_URL rather
// than no-op'ing. That is a deliberate departure from .github/scripts/backup.mjs's
// silent-skip pattern, which exists only because CI runs it unattended; here a silent
// "success" that minted nothing would be a trap (Horace would hand out codes that
// were never inserted).
//
// Raw SQL, not @/db/schema: a .mjs cannot import a TypeScript module behind the `@/`
// path alias without the strip-types launcher dance scripts/eval.mjs needs. The
// duplication of the table/column names below is deliberate and is PINNED BY A TEST
// (tests/generate-invite-codes.test.ts asserts they match getTableName/
// getTableColumns of the real drizzle table).
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Crockford-ish: no I, L, O, 0 or 1, so a code read aloud or copied off a screen
// cannot be mistyped into a DIFFERENT valid code. Uppercase + digits only, which is
// exactly the character class lib/db/queries/invite-codes.ts's normalizeInviteCode()
// accepts — a minted code must always survive normalization unchanged, or it would be
// unredeemable. tests/generate-invite-codes.test.ts pins that round-trip.
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 10;

export const MAX_COUNT = 500;
export const DEFAULT_COUNT = 10;

/**
 * SECURITY: randomInt() is node:crypto's CSPRNG, NOT Math.random(). A guessable
 * invite code is a direct bypass of the PRD §9 registration-pacing control, so this
 * is a security choice, not a style one. 31^10 ≈ 8.2e14 ≈ 2^49.5 possibilities;
 * combined with the fact that each guess costs a full OAuth/magic-link round trip,
 * brute force is not a credible path at v1 scale. NEVER swap in Math.random(), and if
 * the alphabet or length is ever shortened, redo that reasoning first.
 */
export function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/**
 * `--count N` or `--count=N`. Defaults to DEFAULT_COUNT. Throws (with an actionable
 * message) on anything that is not an integer in [1, MAX_COUNT] — including `1e9`,
 * which Number() would happily accept.
 */
export function parseCount(argv = []) {
  let raw = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--count') {
      raw = argv[i + 1] ?? '';
      i += 1;
    } else if (typeof arg === 'string' && arg.startsWith('--count=')) {
      raw = arg.slice('--count='.length);
    }
  }
  if (raw === null) return DEFAULT_COUNT;

  // /^\d+$/ rather than Number.isInteger(Number(raw)): the latter accepts '1e9',
  // ' 12 ', '0x10' and '12.0', none of which a human meant to type here.
  if (!/^\d+$/.test(String(raw).trim())) {
    throw new Error(
      `--count must be a whole number between 1 and ${MAX_COUNT} (got: ${JSON.stringify(raw)})`,
    );
  }
  const value = Number(String(raw).trim());
  if (value < 1 || value > MAX_COUNT) {
    throw new Error(
      `--count must be between 1 and ${MAX_COUNT} (got: ${value})`,
    );
  }
  return value;
}

/**
 * One INSERT per code (N ≤ 500; an ops script's round-trips do not matter).
 *
 * `on conflict (code) do nothing returning code` means a collision returns NO row —
 * we retry once and then report it, and we NEVER print a code we did not newly
 * insert. Printing a pre-existing code would hand out somebody else's invite.
 */
export async function main(argv = [], env = {}, deps = {}) {
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const warn = deps.warn ?? ((line) => process.stderr.write(`${line}\n`));

  let count;
  try {
    count = parseCount(argv);
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!env.DATABASE_URL) {
    warn(
      'DATABASE_URL is not set — cannot insert invite codes. Set it in your shell ' +
        '(see .env.example) and re-run. Nothing was generated.',
    );
    return 1;
  }

  // Dynamic import so `parseCount`/`generateCode` stay importable by the test without
  // pulling the driver in.
  const connect =
    deps.connect ??
    (async (url) => {
      const { neon } = await import('@neondatabase/serverless');
      return neon(url);
    });
  const sql = await connect(env.DATABASE_URL);

  const now = deps.now ?? Date.now();
  const minted = [];

  for (let i = 0; i < count; i += 1) {
    let inserted = null;
    // Two attempts: a collision at 2^49.5 is astronomically unlikely, so a second
    // failure means something is actually wrong and must be reported, not retried
    // in a loop.
    for (let attempt = 0; attempt < 2 && inserted === null; attempt += 1) {
      const code = generateCode();
      const rows = await sql`
        insert into invite_codes (code, created_at)
        values (${code}, ${now})
        on conflict (code) do nothing
        returning code
      `;
      if (rows.length === 1) inserted = rows[0].code;
    }
    if (inserted === null) {
      warn(
        `failed to insert a unique invite code after 2 attempts (minted ${minted.length} of ${count})`,
      );
      break;
    }
    minted.push(inserted);
  }

  for (const code of minted) log(code);
  warn(`generated ${minted.length} invite code(s); distribute them manually.`);

  // Exit 0 ONLY if every requested code was actually inserted.
  return minted.length === count ? 0 : 1;
}

// Run only when executed directly (`node scripts/generate-invite-codes.mjs`), not
// when imported by a test — same guard .github/scripts/backup.mjs uses.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await main(process.argv.slice(2), process.env));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
