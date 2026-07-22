import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MIN_BACKUP_BYTES,
  backupFileName,
  dumpCommand,
  uploadCommand,
} from '../.github/scripts/backup.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'backup.yml');
const scriptPath = path.join(repoRoot, '.github', 'scripts', 'backup.mjs');

describe('.github/workflows/backup.yml — weekly schedule trigger (acceptance item 51)', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  it('declares a `schedule:` trigger with a cron expression', () => {
    expect(workflow).toMatch(/schedule:\s*\n(?:\s*#[^\n]*\n)*\s*- cron:\s*'[^']+'/);
  });

  it('does not touch the existing CI workflow (independent file, per ticket File-scope)', () => {
    // Regression guard, not a workflow-content assertion: this file's own existence
    // must not have required editing ci.yml. Cheap sanity check colocated here
    // rather than a separate file.
    const ci = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).not.toMatch(/backup/i);
  });
});

describe('.github/workflows/backup.yml — pg_dump client major (Reviewer bounce: server version mismatch)', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  it('installs the PGDG apt repo, not ubuntu-24.04 stock postgresql-client (which is v16)', () => {
    // ubuntu-24.04 ships postgresql-client 16; pg_dump aborts against a NEWER server
    // major (Neon's current default is Postgres 17). The fix installs a version-pinned
    // client from the official PGDG repo instead of the stock package.
    expect(workflow).toMatch(/apt\.postgresql\.org/);
  });

  it('pins the client major to a version-suffixed package matched to the Neon server (>= 17)', () => {
    // A version-pinned package name, driven by a PG_MAJOR env set to at least 17.
    expect(workflow).toMatch(/postgresql-client-\$\{PG_MAJOR\}/);
    const major = workflow.match(/PG_MAJOR:\s*'?(\d+)'?/);
    expect(major).not.toBeNull();
    expect(Number(major![1])).toBeGreaterThanOrEqual(17);
  });

  it('does NOT apt-get install the bare, unversioned postgresql-client package (regression guard)', () => {
    // The bare package resolves to ubuntu's v16 and reintroduces the mismatch abort.
    // Scoped to an install command so this file's own explanatory comments (which name
    // the bare package) do not trip the guard.
    expect(workflow).not.toMatch(/apt-get install[^\n]*postgresql-client(?![-\w])/);
  });
});

describe('.github/scripts/backup.mjs — no-op guard (acceptance item 52)', () => {
  it('exits 0 and logs a clear skip message when R2/DB credentials are unset', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.R2_ACCESS_KEY_ID;
    delete env.R2_SECRET_ACCESS_KEY;
    delete env.R2_BUCKET;
    delete env.R2_ENDPOINT;

    // Runs the exact script the CI workflow invokes, not a re-implementation —
    // satisfies the acceptance item's "verified by running the step's logic locally
    // with the env vars unset" wording, same pattern as tests/deploy-vercel.test.ts.
    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('R2 credentials not configured, skipping backup');
  });

  it('no-ops the same way when only the R2 secrets are unset but DATABASE_URL happens to be set', () => {
    // DATABASE_URL alone is not sufficient to attempt a real backup — this locks in
    // that the R2 credential check is not bypassable by a partially-configured env,
    // without needing a real Postgres connection (the sh/pg_dump branch is never
    // reached because the missing-var check runs first).
    const env = { ...process.env, DATABASE_URL: 'postgres://example-not-real/db' };
    delete env.R2_ACCESS_KEY_ID;
    delete env.R2_SECRET_ACCESS_KEY;
    delete env.R2_BUCKET;
    delete env.R2_ENDPOINT;

    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('R2 credentials not configured, skipping backup');
  });
});

describe('.github/scripts/backup.mjs — dump command wiring (Reviewer bounce: pipefail)', () => {
  it('runs the dump under bash with `set -o pipefail` so a pg_dump failure is not masked by gzip', () => {
    const cmd = dumpCommand('backup-20260719.sql.gz');
    // bash, not sh: pipefail is not portable to dash (ubuntu-latest's /bin/sh).
    expect(cmd.command).toBe('bash');
    expect(cmd.args[0]).toBe('-c');
    expect(cmd.args[1]).toContain('set -o pipefail');
    // The pipeline itself is still pg_dump | gzip to the target file.
    expect(cmd.args[1]).toMatch(/pg_dump\s+"\$DATABASE_URL"\s*\|\s*gzip\s*>\s*"\$BACKUP_FILE"/);
  });

  it('passes DATABASE_URL via env / shell expansion, never interpolated into argv', () => {
    const cmd = dumpCommand('backup-20260719.sql.gz');
    // The connection string (which may embed a password) must reach the child only
    // through the environment, referenced as $DATABASE_URL — never as a literal argv
    // token that would show up in a process listing.
    expect(cmd.args[1]).toContain('"$DATABASE_URL"');
    expect(cmd.args.join(' ')).not.toContain('postgres://');
    expect(cmd.env).toHaveProperty('DATABASE_URL');
    expect(cmd.env.BACKUP_FILE).toBe('backup-20260719.sql.gz');
  });
});

describe('.github/scripts/backup.mjs — upload command wiring (Reviewer bounce: AWS region)', () => {
  const fakeEnv = {
    R2_BUCKET: 'my-bucket',
    R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    R2_SECRET_ACCESS_KEY: 'super-secret-value',
  };

  it('sets AWS_DEFAULT_REGION=auto so AWS CLI v2 does not hard-fail on region-less R2 uploads', () => {
    const cmd = uploadCommand('backup-20260719.sql.gz', fakeEnv);
    expect(cmd.env.AWS_DEFAULT_REGION).toBe('auto');
  });

  it('targets the R2 endpoint and bucket for the dated object key', () => {
    const cmd = uploadCommand('backup-20260719.sql.gz', fakeEnv);
    expect(cmd.command).toBe('aws');
    expect(cmd.args).toEqual([
      's3',
      'cp',
      'backup-20260719.sql.gz',
      's3://my-bucket/backup-20260719.sql.gz',
      '--endpoint-url',
      'https://acct.r2.cloudflarestorage.com',
    ]);
  });

  it('passes R2 credentials via env, never as argv tokens', () => {
    const cmd = uploadCommand('backup-20260719.sql.gz', fakeEnv);
    expect(cmd.env.AWS_ACCESS_KEY_ID).toBe('AKIDEXAMPLE');
    expect(cmd.env.AWS_SECRET_ACCESS_KEY).toBe('super-secret-value');
    const argv = cmd.args.join(' ');
    expect(argv).not.toContain('AKIDEXAMPLE');
    expect(argv).not.toContain('super-secret-value');
  });
});

describe('.github/scripts/backup.mjs — backupFileName', () => {
  it('formats the object key as backup-YYYYMMDD.sql.gz', () => {
    expect(backupFileName(new Date('2026-07-19T03:00:00Z'))).toBe('backup-20260719.sql.gz');
  });
});

// Integration tests that exercise the REAL dump path (the branch the two Reviewer
// findings live in) by putting a fake `pg_dump` on PATH. The dump runs via `bash`,
// which honours PATH + shebang on both the ubuntu-latest runner and local MSYS/Git
// bash, so no live Postgres/R2 is needed. The upload (`aws`) step is never reached in
// either case because the run fails-closed first — so the real aws binary is not
// invoked and no network access occurs.
describe('.github/scripts/backup.mjs — fail-closed dump (Reviewer bounce: silent corruption)', () => {
  function runWithFakePgDump(fakeScriptBody: string) {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'plt02-backup-'));
    try {
      const binDir = path.join(workdir, 'bin');
      mkdirSync(binDir);
      const fake = path.join(binDir, 'pg_dump');
      writeFileSync(fake, fakeScriptBody);
      chmodSync(fake, 0o755);

      // Prepend the fake bin to PATH, mutating whatever casing the key already has
      // (Windows uses `Path`) so a single, canonical PATH reaches the child.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL: 'postgres://user:pw@example-not-real/db',
        R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
        R2_SECRET_ACCESS_KEY: 'super-secret-value',
        R2_BUCKET: 'my-bucket',
        R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      };
      const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      env[pathKey] = binDir + path.delimiter + (env[pathKey] ?? '');

      return spawnSync('node', [scriptPath], { cwd: workdir, env, encoding: 'utf8' });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  it('exits non-zero and does NOT upload when pg_dump fails (pipefail, not gzip, decides the outcome)', () => {
    // A failing pg_dump whose stderr mimics an auth/connection error. Before the fix,
    // the pipeline reported gzip's exit 0, a valid empty .sql.gz was produced, and
    // "backup uploaded" was logged. With pipefail the run must fail.
    const result = runWithFakePgDump(
      '#!/bin/bash\necho "pg_dump: error: connection to server failed" >&2\nexit 1\n',
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout ?? '').not.toContain('backup uploaded');
  });

  it('exits non-zero and does NOT upload when pg_dump succeeds but produces an empty dump (size guard)', () => {
    // pg_dump exits 0 having written nothing -> gzip yields a 20-byte structurally
    // valid archive. The size guard must reject it (< MIN_BACKUP_BYTES) rather than
    // upload an empty backup.
    const result = runWithFakePgDump('#!/bin/bash\nexit 0\n');

    expect(result.status).not.toBe(0);
    expect(result.stdout ?? '').not.toContain('backup uploaded');
    expect(result.stderr ?? '').toContain('empty backup');
  });

  it('MIN_BACKUP_BYTES is a small positive bound above an empty gzip (20 bytes)', () => {
    // Documents the guard's intent: reject the ~20-byte empty-input gzip while never
    // false-failing a real dump (even an empty DB gzips to > 100 bytes).
    expect(MIN_BACKUP_BYTES).toBeGreaterThan(20);
    expect(MIN_BACKUP_BYTES).toBeLessThan(100);
  });
});
