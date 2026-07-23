import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';

// Migration coverage for FND-05 (Test-plan items 2–4, acceptance items 1–4). Three
// tiers, in increasing order of environmental risk. All run fully offline — no live
// Neon, no DATABASE_URL. See the ticket Deviations note for why Tier 3 uses PGlite
// (a real WASM Postgres) rather than the ticket-named pg-mem.

const repoRoot = process.cwd();
const migrationsDir = path.join(repoRoot, 'db', 'migrations');

function readCommittedMigrationSql(): string {
  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  expect(sqlFiles.length).toBeGreaterThanOrEqual(1);
  return sqlFiles.map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8')).join('\n');
}

// --- Tier 1: migration-generation regression (Test-plan item 2, acceptance 1) ---
// Regenerate into a throwaway dir and assert the command still succeeds and emits
// a .sql — catches a future schema edit that breaks `drizzle-kit generate`.
describe('db/migrate — generation regression (Tier 1)', () => {
  it(
    'drizzle-kit generate exits 0 and emits a .sql migration into a scratch dir',
    () => {
      // drizzle-kit's `exports` map doesn't expose ./package.json, so resolve the
      // bin through the top-level node_modules symlink (drizzle-kit is a direct
      // devDependency, so pnpm always hoists it here).
      const drizzleKitBin = path.join(repoRoot, 'node_modules', 'drizzle-kit', 'bin.cjs');
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnd05-'));
      try {
        execFileSync(
          process.execPath,
          [
            drizzleKitBin,
            'generate',
            '--dialect',
            'postgresql',
            '--schema',
            './db/schema.ts',
            '--out',
            outDir,
          ],
          { cwd: repoRoot, stdio: 'pipe' },
        );
        const emitted = fs.readdirSync(outDir).filter((f) => f.endsWith('.sql'));
        expect(emitted.length).toBeGreaterThanOrEqual(1);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

// --- Tier 2: static SQL assertions on the committed migration (acceptance 1,3,4) --
describe('db/migrate — committed migration SQL (Tier 2)', () => {
  let sql: string;

  beforeAll(() => {
    sql = readCommittedMigrationSql();
  });

  it('creates all eight tables', () => {
    for (const table of [
      'users',
      'libraries',
      'resumes',
      'jobs',
      'tailored_resumes',
      'briefs',
      'usage_events',
      'eval_runs',
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE "${table}"`));
    }
  });

  // AMENDED by 04-fit/FIT-01 (docs/plans/FIT-01.md §0.1 resolution R-A).
  //
  // `sql` is the CONCATENATION of every committed migration, so the original
  // assertions (/"ledger" jsonb NOT NULL/) would still match migration 0000's
  // CREATE TABLE and stay GREEN while asserting something that is no longer true of
  // the live schema. What matters is where the MIGRATION CHAIN ENDS: 0000 created
  // all three NOT NULL, 0003 dropped the constraint on `ledger` and `fit` because
  // FIT-01 creates a job row with `jd` only and FIT-02 fills the other two later.
  // `jd` is still NOT NULL and nothing has ever relaxed it.
  it('declares jobs.jd NOT NULL and ends with jobs.ledger / jobs.fit nullable (FIT-01 §0.1 R-A)', () => {
    expect(sql).toMatch(/"jd" jsonb NOT NULL/);
    expect(sql).not.toMatch(/ALTER TABLE "jobs" ALTER COLUMN "jd" DROP NOT NULL/);
    expect(sql).toMatch(/ALTER TABLE "jobs" ALTER COLUMN "ledger" DROP NOT NULL/);
    expect(sql).toMatch(/ALTER TABLE "jobs" ALTER COLUMN "fit" DROP NOT NULL/);
  });

  it('leaves briefs.intel nullable (jsonb with no NOT NULL)', () => {
    // The intel column line is exactly `"intel" jsonb,` — a NOT NULL would fail this.
    expect(sql).toMatch(/"intel" jsonb,/);
    expect(sql).not.toMatch(/"intel" jsonb NOT NULL/);
  });

  it('creates the (user_id, op, created_at) composite index on usage_events (acceptance item 4)', () => {
    expect(sql).toMatch(
      /CREATE INDEX "usage_events_user_op_created_idx" ON "usage_events".*\("user_id","op","created_at"\)/,
    );
  });

  it('enforces user/job foreign keys with ON DELETE cascade', () => {
    expect(sql).toMatch(/"jobs_user_id_users_id_fk".*ON DELETE cascade/);
    expect(sql).toMatch(/"tailored_resumes_job_id_jobs_id_fk".*ON DELETE cascade/);
  });
});

// --- Tier 3: real round-trip against PGlite (Test-plan item 3) -------------------
// PGlite is a real Postgres compiled to WASM; the migration is applied through
// drizzle's own migrator (the same code path production runs) and rows are inserted
// and read back through the typed query builder — this is what actually proves the
// bigint(epoch-ms) / numeric(mode:'number') / jsonb / pg-enum column choices work
// end-to-end, not just that they type-check.
describe('db/migrate — PGlite round-trip (Tier 3)', () => {
  it(
    'applies the migration and round-trips one row per user-scoped table',
    async () => {
      const client = new PGlite();
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: './db/migrations' });

      // Zod-valid nested fixtures (same construction style as lib/schemas/*.test.ts).
      const jd = { requirements: [], atsKeywords: ['k8s'], subtext: [] };
      const ledger = { bindings: [], gaps: [] };
      const subScore = { score: 80, bindings: [], gaps: [] };
      const fit = {
        hardRequirements: [{ label: 'visa', status: 'pass' as const }],
        subScores: {
          technical: subScore,
          experienceDepth: subScore,
          domain: subScore,
          evidenceStrength: subScore,
        },
        compositeScore: 78,
        tier: 'Strong' as const,
        advice: 'Lead with the realtime work.',
        topGaps: [],
      };
      const alignment = [{ keyword: 'k8s', status: 'present' as const }];
      const edit = {
        original: 'Worked on backend.',
        suggested: 'Led the streaming-ASR backend.',
        rationale: 'Adds a metric.',
        projectId: 'voice-agent',
      };
      const intel = {
        snapshot: 'Seed-stage devtools, ~30 people.',
        recent: [{ headline: 'Raised Series B', soWhat: 'Hiring.' }],
        engineeringSignals: ['monorepo'],
        talkingPoints: ['their latency work'],
      };
      const rehearse = {
        questions: Array.from({ length: 5 }, () => ({
          projectId: 'voice-agent',
          question: 'Why barge-in?',
          trap: 'And the echo-cancellation cost?',
        })),
        askThem: ['a', 'b', 'c'],
        positioning: 'A realtime-systems engineer.',
      };
      const profile = { name: 'Ada Lovelace' };
      const project = {
        id: 'voice-agent',
        name: 'Voice Agent',
        stage: 'shipped',
        role: 'Tech lead',
        stack: ['TypeScript'],
        summary: 'Streaming ASR + LLM orchestration.',
        metrics: ['12k MAU'],
        tags: ['llm'],
      };
      const T = 1_700_000_000_000;

      const userId = crypto.randomUUID();
      await db.insert(schema.users).values({ id: userId, email: 'ada@example.com' });

      await db.insert(schema.libraries).values({
        userId,
        profile,
        projects: [project],
        createdAt: T,
        updatedAt: T,
      });

      await db
        .insert(schema.resumes)
        .values({ userId, sourceMd: '# Ada', updatedAt: T });

      const jobId = crypto.randomUUID();
      await db.insert(schema.jobs).values({
        id: jobId,
        userId,
        company: 'Acme',
        role: 'Staff Engineer',
        status: 'screening',
        jdRaw: 'We are hiring...',
        jd,
        ledger,
        fit,
        createdAt: T,
        updatedAt: T,
      });

      await db.insert(schema.tailoredResumes).values({
        jobId,
        alignment,
        edits: [edit],
        fullDraftMd: '# Ada Lovelace',
        createdAt: T,
        updatedAt: T,
      });

      await db.insert(schema.briefs).values({
        jobId,
        intel,
        rehearse,
        createdAt: T,
        updatedAt: T,
      });

      await db.insert(schema.usageEvents).values({
        userId,
        op: 'cross',
        tokensIn: 1200,
        tokensOut: 800,
        searches: 0,
        costUsd: 0.042,
        durationMs: 3100,
        createdAt: T,
      });

      await db.insert(schema.evalRuns).values({
        suite: 'q1',
        op: 'read',
        passRate: 0.92,
        details: { failures: ['case-3'] },
        createdAt: T,
      });

      // Read every row back and assert the load-bearing type mappings survived.
      const [libRow] = await db.select().from(schema.libraries);
      const [jobRow] = await db.select().from(schema.jobs);
      const [trRow] = await db.select().from(schema.tailoredResumes);
      const [briefRow] = await db.select().from(schema.briefs);
      const [usageRow] = await db.select().from(schema.usageEvents);
      const [evalRow] = await db.select().from(schema.evalRuns);

      // bigint(epoch-ms) → JS number
      expect(jobRow.createdAt).toBe(T);
      expect(typeof jobRow.createdAt).toBe('number');
      // jsonb round-trips structurally
      expect(jobRow.jd).toEqual(jd);
      expect(jobRow.ledger).toEqual(ledger);
      expect(jobRow.fit).toEqual(fit);
      expect(libRow.profile).toEqual(profile);
      expect(libRow.projects).toEqual([project]);
      expect(trRow.alignment).toEqual(alignment);
      expect(briefRow.intel).toEqual(intel);
      expect(briefRow.rehearse).toEqual(rehearse);
      // numeric(mode:'number') → JS number
      expect(usageRow.costUsd).toBe(0.042);
      expect(typeof usageRow.costUsd).toBe('number');
      expect(evalRow.passRate).toBe(0.92);
      expect(typeof evalRow.passRate).toBe('number');
      // enum column round-trips its string value
      expect(jobRow.status).toBe('screening');
      expect(usageRow.op).toBe('cross');

      await client.close();
    },
    30_000,
  );

  // AMENDED by 04-fit/FIT-01 (docs/plans/FIT-01.md §0.1 resolution R-A). This test
  // previously proved that an insert WITHOUT `fit` is rejected. Migration 0003 makes
  // that insert legal on purpose — it is exactly what FIT-01's POST /api/jobs does —
  // so the test now pins BOTH halves of the new constraint set through the real
  // migration chain: a `jd`-only insert SUCCEEDS and reads back nulls, and an insert
  // missing `jd` is still rejected by the database.
  it('accepts a jd-only job insert (FIT-01) and still rejects one missing jd', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: './db/migrations' });

    const userId = crypto.randomUUID();
    await db.insert(schema.users).values({ id: userId, email: 'b@example.com' });

    // The FIT-01 shape: jd present, ledger/fit absent (FIT-02 fills them later).
    const [row] = await db
      .insert(schema.jobs)
      .values({
        userId,
        company: 'Acme',
        role: 'Engineer',
        status: 'screening',
        jdRaw: 'x',
        jd: { requirements: [], atsKeywords: [], subtext: [] },
      })
      .returning();
    expect(row.ledger).toBeNull();
    expect(row.fit).toBeNull();

    // `jd` is still NOT NULL. Bypass the compile-time type to prove the DB-level
    // constraint (not just Drizzle's typing) rejects a missing jd at runtime.
    await expect(
      db.insert(schema.jobs).values({
        userId,
        company: 'Acme',
        role: 'Engineer',
        status: 'screening',
        jdRaw: 'x',
        // jd intentionally omitted
      } as unknown as typeof schema.jobs.$inferInsert),
    ).rejects.toThrow();

    await client.close();
  }, 30_000);
});
