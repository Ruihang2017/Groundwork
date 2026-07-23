import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALPHABET,
  DEFAULT_COUNT,
  GROUPS,
  GROUP_LENGTH,
  makeCode,
  MAX_COUNT,
  parseCount,
} from '../scripts/generate-invite-codes.mjs';

// PLT-04 Deliverable 3 — unit coverage for the code-minting CLI.
//
// The script exports its PURE parts (makeCode, parseCount) and runs the DB work
// only behind an is-main guard, which is what makes this a real in-process unit
// test rather than a subprocess smoke test. The one subprocess case below covers
// the guard itself. Precedent for a tests/** file owning a scripts/** module:
// tests/backup.test.ts (PLT-02).

const scriptPath = path.join(process.cwd(), 'scripts', 'generate-invite-codes.mjs');

describe('makeCode — the registration credential', () => {
  it('emits the documented XXXX-XXXX-XXXX shape over the ambiguity-free alphabet', () => {
    const code = makeCode();
    expect(code).toHaveLength(GROUPS * GROUP_LENGTH + (GROUPS - 1));
    expect(code.split('-')).toHaveLength(GROUPS);
    for (const group of code.split('-')) {
      expect(group).toHaveLength(GROUP_LENGTH);
      for (const ch of group) expect(ALPHABET).toContain(ch);
    }
  });

  it('excludes the visually ambiguous characters 0/O and 1/I/L', () => {
    // These codes get read aloud and retyped; O/0 and I/l/1 confusion turns a
    // valid code into a support ticket.
    for (const ch of ['0', 'O', '1', 'I', 'L']) {
      expect(ALPHABET).not.toContain(ch);
    }
  });

  it('is readable by auth.ts\'s cookie filter — a minted code the gate rejects would be a silent end-to-end break', () => {
    // auth.ts's readInviteCodeCookie drops anything outside [A-Za-z0-9-]. If the
    // two ever disagree, every minted code becomes unusable and NEITHER side's own
    // tests would notice. This is the seam test.
    for (let i = 0; i < 200; i += 1) {
      expect(makeCode()).toMatch(/^[A-Za-z0-9-]+$/);
    }
    expect(makeCode().length).toBeLessThanOrEqual(64); // the gate's length cap
  });

  it('produces 1000 distinct codes (no accidental constant / seeded generator)', () => {
    const codes = new Set(Array.from({ length: 1000 }, makeCode));
    expect(codes.size).toBe(1000);
  });

  it('uses node:crypto and NEVER Math.random (plan §4 R-5 — the entropy IS the control)', () => {
    // There is no rate limit on redemption attempts, so ~59 bits of CSPRNG
    // entropy is the whole anti-guessing control. A Math.random() substitution
    // would look harmless in a diff and silently reduce the code to a guessable
    // token — hence a direct source assertion, not just a statistical one.
    const src = fs.readFileSync(scriptPath, 'utf8');
    // Comment lines are stripped first: the script's own header explains WHY
    // Math.random is forbidden, and that prose must not trip its own guard.
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/Math\.random/);
    expect(src).toMatch(/from 'node:crypto'/);
    expect(src).toMatch(/randomInt\(/);
  });
});

describe('parseCount', () => {
  it('defaults to DEFAULT_COUNT with no arguments', () => {
    expect(parseCount([])).toBe(DEFAULT_COUNT);
    expect(parseCount()).toBe(DEFAULT_COUNT);
    expect(parseCount(['--something-else', '5'])).toBe(DEFAULT_COUNT);
  });

  it('accepts --count N and --count=N', () => {
    expect(parseCount(['--count', '20'])).toBe(20);
    expect(parseCount(['--count=20'])).toBe(20);
    expect(parseCount(['--count', '1'])).toBe(1);
    expect(parseCount(['--count', String(MAX_COUNT)])).toBe(MAX_COUNT);
  });

  it('rejects 0, negatives, non-integers, junk, and anything over the hard cap', () => {
    for (const bad of ['0', '-1', 'abc', '', '1.5', '12abc', String(MAX_COUNT + 1)]) {
      expect(() => parseCount(['--count', bad]), bad).toThrow(RangeError);
    }
    // A missing value after the flag is junk too (argv[i+1] is undefined).
    expect(() => parseCount(['--count'])).toThrow(RangeError);
  });

  it('names the accepted range in the error message (actionable, per plan §2.6)', () => {
    expect(() => parseCount(['--count', '0'])).toThrow(
      new RegExp(`between 1 and ${MAX_COUNT}`),
    );
  });
});

describe('the CLI entry point (is-main guard)', () => {
  it('exits non-zero with an actionable message when DATABASE_URL is unset, and never echoes a connection string', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;

    const result = spawnSync(process.execPath, [scriptPath, '--count', '1'], {
      cwd: process.cwd(),
      env,
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/DATABASE_URL is not set/);
    expect(result.stderr).toMatch(/\.env\.example/);
    // Nothing was minted, so nothing may be printed to stdout — a shell doing
    // `... > codes.txt` must not end up with a file full of noise.
    expect(result.stdout.trim()).toBe('');
    expect(result.stderr).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('exits non-zero on a bad --count WITHOUT needing a database at all', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;

    const result = spawnSync(process.execPath, [scriptPath, '--count', 'nope'], {
      cwd: process.cwd(),
      env,
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--count must be an integer/);
  });

  it('does NOT run main() on import (the guard is what makes this file a unit test)', () => {
    // Importing at the top of this file already proves it: if the guard were
    // missing, that import would have attempted a DB connection during
    // collection. Assert the guard's presence explicitly so a refactor cannot
    // quietly drop it.
    const src = fs.readFileSync(scriptPath, 'utf8');
    expect(src).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
  });

  it('is invoked as a plain node script, with no package.json entry (an operator tool, not a dev-loop step)', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(Object.values(pkg.scripts)).not.toContain(
      'node scripts/generate-invite-codes.mjs',
    );
    expect(fs.existsSync(fileURLToPath(new URL('../scripts/generate-invite-codes.mjs', import.meta.url)))).toBe(true);
  });
});
