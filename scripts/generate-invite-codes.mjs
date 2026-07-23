#!/usr/bin/env node
// PLT-04 Deliverable 3 — mint N unused invite codes (PRD §9: "上线初期以邀请码控制
// 注册节奏"). Horace runs this locally and distributes the printed codes by hand
// (email, Slack, …). That manual step is the FEATURE: the ticket's Non-goals rule
// out any self-service / referral generation — invite codes are Horace pacing
// registrations, not users inviting each other.
//
//   node scripts/generate-invite-codes.mjs --count 20
//
// Deliberately NOT a package.json script: it is an occasional operator tool, not
// part of the dev loop. Plain .mjs (no TypeScript, no build step, no @/ alias —
// tsconfig paths do not exist for plain node).
//
// SECURITY — the code IS the whole registration credential:
//   * `randomInt` from node:crypto, NEVER Math.random(). There is no rate limit on
//     redemption attempts, so the ~60 bits of entropy below IS the anti-guessing
//     control. tests/generate-invite-codes.test.ts asserts this file contains no
//     Math.random precisely because that substitution would look harmless in a
//     diff and silently reduce the code to a guessable token.
//   * If the format is ever shortened (e.g. to a 6-character human-friendly code)
//     that reasoning COLLAPSES and rate limiting becomes mandatory.
//   * DATABASE_URL is never printed, not even on error.
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Ambiguity-free alphabet: no 0/O, no 1/I/L — these codes get read aloud and
// retyped. 31 characters (23 letters + 8 digits) ⇒ log2(31) ≈ 4.95 bits each.
// randomInt() rejection-samples, so a non-power-of-two size introduces no bias.
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GROUPS = 3;
export const GROUP_LENGTH = 4;

/** Hard cap; a typo like `--count 100000` should not mint 100k rows. */
export const MAX_COUNT = 1000;
export const DEFAULT_COUNT = 10;

/**
 * A single code, shaped `XXXX-XXXX-XXXX`. 12 alphabet characters ≈ 59 bits.
 *
 * The hyphens must stay inside auth.ts's `[A-Za-z0-9-]` cookie filter — a minted
 * code that the gate refuses to read would be an end-to-end break that neither
 * side's own tests would catch, which is why tests/generate-invite-codes.test.ts
 * asserts the two agree.
 */
export function makeCode() {
  const groups = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < GROUP_LENGTH; i += 1) {
      group += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * Parse `--count N` (or `--count=N`) out of argv. Returns a positive integer.
 * Throws a RangeError with an actionable message on anything else — main()
 * converts that into exit 1. Throwing rather than exiting keeps this unit-testable
 * in-process.
 */
export function parseCount(argv = []) {
  let raw;
  let seen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--count') {
      // `seen` is tracked SEPARATELY from `raw` so a bare `--count` with no value
      // is an ERROR rather than silently falling back to the default — a typo
      // that quietly mints 10 codes instead of the 200 you meant is worse than a
      // hard stop.
      seen = true;
      raw = argv[i + 1];
      break;
    }
    if (typeof arg === 'string' && arg.startsWith('--count=')) {
      seen = true;
      raw = arg.slice('--count='.length);
      break;
    }
  }

  if (!seen) return DEFAULT_COUNT;

  // Number() (not parseInt) so '12abc' and '' are rejected rather than truncated
  // to a plausible-looking 12.
  const n = Number(raw);
  // Number(undefined) is NaN and Number('') is 0, so a bare `--count` and
  // `--count=` both land in the error branch below rather than sneaking through.
  if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) {
    throw new RangeError(
      `--count must be an integer between 1 and ${MAX_COUNT}; got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

async function main(argv) {
  let count;
  try {
    count = parseCount(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // Same actionable wording as db/index.ts's fail-fast. Never echo the value.
    console.error(
      'DATABASE_URL is not set. Set it in your environment (see .env.example) before running scripts/generate-invite-codes.mjs.',
    );
    return 1;
  }

  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(connectionString);

  const codes = Array.from({ length: count }, makeCode);
  const now = Date.now();

  // ON CONFLICT DO NOTHING + RETURNING: only genuinely-inserted codes come back,
  // so a (vanishingly unlikely) collision with an existing code can never be
  // printed as if it were freshly minted — printing someone else's live code would
  // hand out a second copy of it.
  //
  // `created_at` is set explicitly: the $defaultFn lives in Drizzle, not in the
  // database, and this is raw SQL.
  const rows = await sql`
    INSERT INTO invite_codes (code, created_at)
    SELECT c, ${now} FROM unnest(${codes}::text[]) AS c
    ON CONFLICT (code) DO NOTHING
    RETURNING code
  `;

  for (const row of rows) console.log(row.code);

  // Summary on stderr so `... > codes.txt` captures codes only.
  console.error(`Inserted ${rows.length} of ${count} requested invite code(s).`);

  // Exit non-zero on a shortfall: a silent partial success must not read as
  // success to a shell script or to a tired human.
  return rows.length === count ? 0 : 1;
}

// Run only when executed directly, so the exported helpers above stay importable
// (and unit-testable) without touching a database. Same guard style as
// .github/scripts/backup.mjs.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error('[invite-codes] generation failed:', err?.message ?? err);
      process.exit(1);
    });
}
