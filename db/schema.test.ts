import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  briefs,
  evalRuns,
  evalSuiteEnum,
  jobs,
  jobStatusEnum,
  libraries,
  resumes,
  tailoredResumes,
  usageEvents,
  usageOpEnum,
  users,
} from '@/db/schema';

// Schema-shape tests (Deliverable 1 / Test-plan item 1). Pure Drizzle
// introspection — no db/index.ts import, no DATABASE_URL, no Postgres substitute
// needed. Structured so FND-08 can re-run this file BYTE-FOR-BYTE UNMODIFIED as
// its own regression check after appending accounts/sessions/verificationTokens:
// each of the original eight tables is asserted independently, and nothing here
// asserts the total count of tables exported by db/schema.ts.

// Expected JS-property column keys per table (Deliverable 1). `getTableColumns`
// keys by the property name, not the snake_case DB column name.
const expectedColumns: Record<string, string[]> = {
  users: ['id', 'name', 'email', 'emailVerified', 'image'],
  libraries: ['id', 'userId', 'profile', 'projects', 'createdAt', 'updatedAt', 'deletedAt'],
  resumes: ['id', 'userId', 'sourceMd', 'updatedAt'],
  jobs: [
    'id',
    'userId',
    'company',
    'role',
    'status',
    'jdRaw',
    'jd',
    'ledger',
    'fit',
    'createdAt',
    'updatedAt',
  ],
  tailored_resumes: [
    'id',
    'jobId',
    'alignment',
    'edits',
    'fullDraftMd',
    'createdAt',
    'updatedAt',
  ],
  briefs: ['id', 'jobId', 'intel', 'rehearse', 'createdAt', 'updatedAt'],
  usage_events: [
    'id',
    'userId',
    'op',
    'tokensIn',
    'tokensOut',
    'searches',
    'costUsd',
    'durationMs',
    'createdAt',
  ],
  eval_runs: ['id', 'suite', 'op', 'passRate', 'details', 'createdAt'],
};

const tables = {
  users,
  libraries,
  resumes,
  jobs,
  tailored_resumes: tailoredResumes,
  briefs,
  usage_events: usageEvents,
  eval_runs: evalRuns,
} as const;

describe('db/schema — table names', () => {
  for (const [expectedName, table] of Object.entries(tables)) {
    it(`${expectedName} maps to the '${expectedName}' Postgres table`, () => {
      expect(getTableName(table)).toBe(expectedName);
    });
  }
});

describe('db/schema — column sets (Deliverable 1)', () => {
  for (const [name, table] of Object.entries(tables)) {
    it(`${name} has exactly the expected columns (no more, no fewer)`, () => {
      const actual = Object.keys(getTableColumns(table)).sort();
      const expected = [...expectedColumns[name]].sort();
      expect(actual).toEqual(expected);
    });
  }
});

describe('db/schema — NOT NULL constraints', () => {
  it('jobs.jd / jobs.ledger / jobs.fit are all NOT NULL (FND-04 atomicity mirror)', () => {
    const cols = getTableColumns(jobs);
    expect(cols.jd.notNull).toBe(true);
    expect(cols.ledger.notNull).toBe(true);
    expect(cols.fit.notNull).toBe(true);
  });

  it('briefs.intel is nullable and briefs.rehearse is NOT NULL (P3 asymmetry)', () => {
    const cols = getTableColumns(briefs);
    expect(cols.intel.notNull).toBe(false);
    expect(cols.rehearse.notNull).toBe(true);
  });

  it('libraries.deletedAt is nullable (soft-delete column)', () => {
    expect(getTableColumns(libraries).deletedAt.notNull).toBe(false);
  });

  it('libraries.userId / resumes.userId / jobs.userId / usage_events.userId are NOT NULL', () => {
    expect(getTableColumns(libraries).userId.notNull).toBe(true);
    expect(getTableColumns(resumes).userId.notNull).toBe(true);
    expect(getTableColumns(jobs).userId.notNull).toBe(true);
    expect(getTableColumns(usageEvents).userId.notNull).toBe(true);
  });

  it('tailored_resumes.jobId / briefs.jobId are NOT NULL', () => {
    expect(getTableColumns(tailoredResumes).jobId.notNull).toBe(true);
    expect(getTableColumns(briefs).jobId.notNull).toBe(true);
  });

  it('users.email is NOT NULL while name/emailVerified/image are nullable', () => {
    const cols = getTableColumns(users);
    expect(cols.email.notNull).toBe(true);
    expect(cols.name.notNull).toBe(false);
    expect(cols.emailVerified.notNull).toBe(false);
    expect(cols.image.notNull).toBe(false);
  });
});

describe('db/schema — DB column names', () => {
  it('maps camelCase properties to snake_case columns', () => {
    expect(getTableColumns(jobs).jdRaw.name).toBe('jd_raw');
    expect(getTableColumns(jobs).userId.name).toBe('user_id');
    expect(getTableColumns(resumes).sourceMd.name).toBe('source_md');
    expect(getTableColumns(tailoredResumes).fullDraftMd.name).toBe('full_draft_md');
    expect(getTableColumns(usageEvents).tokensIn.name).toBe('tokens_in');
    expect(getTableColumns(usageEvents).costUsd.name).toBe('cost_usd');
    expect(getTableColumns(libraries).deletedAt.name).toBe('deleted_at');
    expect(getTableColumns(users).emailVerified.name).toBe('email_verified');
  });
});

describe('db/schema — pg enums', () => {
  it('jobStatusEnum matches JobStatus', () => {
    expect(jobStatusEnum.enumValues).toEqual([
      'screening',
      'applied',
      'interviewing',
      'closed',
    ]);
  });

  it("usageOpEnum matches UsageOp (six ops, 'score' excluded)", () => {
    expect(usageOpEnum.enumValues).toEqual([
      'parse',
      'read',
      'cross',
      'tailor',
      'research',
      'rehearse',
    ]);
    expect(usageOpEnum.enumValues).not.toContain('score');
  });

  it('evalSuiteEnum matches EvalSuite', () => {
    expect(evalSuiteEnum.enumValues).toEqual(['q1', 'q2', 'q3']);
  });

  it('jobs.status / usage_events.op / eval_runs.suite / eval_runs.op use the pg enum types', () => {
    expect(getTableColumns(jobs).status.enumValues).toEqual(jobStatusEnum.enumValues);
    expect(getTableColumns(usageEvents).op.enumValues).toEqual(usageOpEnum.enumValues);
    expect(getTableColumns(evalRuns).suite.enumValues).toEqual(evalSuiteEnum.enumValues);
    expect(getTableColumns(evalRuns).op.enumValues).toEqual(usageOpEnum.enumValues);
  });
});
