#!/usr/bin/env node
// EVL-02 — the `pnpm eval` entry point (package.json's "eval" script).
//
// This is a THIN plain-JavaScript launcher (no TypeScript syntax, so it needs no
// stripping flag for itself). Its whole job is to spawn a child Node process that
// runs eval/self-check.ts under `--experimental-strip-types`, because the literal
// npm-script text fixed by the ticket's File-scope is `node scripts/eval.mjs`
// (plain node, no bundler / tsx / ts-node). See docs/plans/EVL-02.md §2.1 / §2.11.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(repoRoot, 'eval', 'self-check.ts');

// Node's `--experimental-strip-types` requires >=22.6. package.json's "engines"
// field understates this ticket's real floor (Risk #4) — guard here so a
// contributor on Node 20/21 gets an actionable error, not a cryptic CLI failure.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `pnpm eval requires Node >=22.6 (for --experimental-strip-types); you have ` +
      `${process.version}. package.json's "engines" field currently understates ` +
      `this — see docs/plans/EVL-02.md Risk #4.`,
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', entry],
  { stdio: 'inherit', cwd: repoRoot },
);

process.exit(result.status ?? 1);
