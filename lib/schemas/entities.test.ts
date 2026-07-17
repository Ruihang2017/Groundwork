import { describe, expect, it } from 'vitest';

import {
  Library,
  Profile,
  Project,
  PROJECT_ID_PATTERN,
  Resume,
} from '@/lib/schemas/entities';

// Hand-built valid fixtures (NOT the PRD §6 fixture corpus — that lives in
// 02-evaluation's fixtures/**, which does not exist yet and must not be
// referenced here). Pure inline schema-parsing assertions.

const validProject = {
  id: 'voice-agent',
  name: 'Voice Agent',
  stage: 'shipped',
  role: 'Tech lead',
  stack: ['TypeScript', 'Next.js', 'Postgres'],
  summary:
    'Streaming ASR + LLM orchestration behind a single WebSocket; chose barge-in over half-duplex to cut perceived latency.',
  metrics: ['p95 turn latency 320ms', '12k MAU'],
  tags: ['llm', 'realtime'],
};

const validProfile = {
  name: 'Ada Lovelace',
  headline: 'Staff Engineer',
  targetRole: 'Principal Engineer',
  contact: {
    email: 'ada@example.com',
    links: ['https://github.com/ada'],
  },
};

describe('Profile', () => {
  it('parses an object with every optional field present', () => {
    expect(() => Profile.parse(validProfile)).not.toThrow();
  });

  it('parses an object with only the required name (all optionals omitted)', () => {
    expect(() => Profile.parse({ name: 'Ada Lovelace' })).not.toThrow();
  });

  it('defaults contact.links to [] when omitted', () => {
    const parsed = Profile.parse({ name: 'Ada', contact: { email: 'ada@example.com' } });
    expect(parsed.contact?.links).toEqual([]);
  });

  it('rejects a missing name', () => {
    expect(Profile.safeParse({ headline: 'no name' }).success).toBe(false);
  });

  it('rejects a malformed contact email', () => {
    expect(
      Profile.safeParse({ name: 'Ada', contact: { email: 'not-an-email' } }).success,
    ).toBe(false);
  });
});

describe('Project', () => {
  it('parses a valid object matching PRD §5.6 field list', () => {
    expect(() => Project.parse(validProject)).not.toThrow();
  });

  it('accepts an empty metrics array (explicitly a valid state)', () => {
    expect(() => Project.parse({ ...validProject, metrics: [] })).not.toThrow();
    expect(Project.safeParse({ ...validProject, metrics: [] }).success).toBe(true);
  });

  it('accepts a single-segment kebab id', () => {
    expect(Project.safeParse({ ...validProject, id: 'app' }).success).toBe(true);
  });

  it('accepts a multi-segment kebab id with digits', () => {
    expect(Project.safeParse({ ...validProject, id: 'a1-b2-c3' }).success).toBe(true);
  });

  it('rejects an id with uppercase and underscore (Voice_Agent)', () => {
    expect(Project.safeParse({ ...validProject, id: 'Voice_Agent' }).success).toBe(false);
  });

  it('rejects an id containing a space', () => {
    expect(Project.safeParse({ ...validProject, id: 'voice agent' }).success).toBe(false);
  });

  it('rejects an id containing an underscore', () => {
    expect(Project.safeParse({ ...validProject, id: 'voice_agent' }).success).toBe(false);
  });

  it('rejects an id with leading/trailing or doubled hyphens', () => {
    expect(Project.safeParse({ ...validProject, id: '-voice' }).success).toBe(false);
    expect(Project.safeParse({ ...validProject, id: 'voice-' }).success).toBe(false);
    expect(Project.safeParse({ ...validProject, id: 'voice--agent' }).success).toBe(false);
  });

  it('rejects a non-string member inside a string array field', () => {
    expect(
      Project.safeParse({ ...validProject, stack: ['ok', 42] }).success,
    ).toBe(false);
    expect(
      Project.safeParse({ ...validProject, metrics: [1] }).success,
    ).toBe(false);
  });
});

describe('PROJECT_ID_PATTERN', () => {
  it('matches the ticket example and rejects the ticket reject categories', () => {
    expect(PROJECT_ID_PATTERN.test('voice-agent')).toBe(true);
    expect(PROJECT_ID_PATTERN.test('Voice_Agent')).toBe(false);
    expect(PROJECT_ID_PATTERN.test('voice agent')).toBe(false);
    expect(PROJECT_ID_PATTERN.test('voice_agent')).toBe(false);
  });
});

describe('Library', () => {
  it('parses a valid library with one project', () => {
    expect(() =>
      Library.parse({ profile: validProfile, projects: [validProject] }),
    ).not.toThrow();
  });

  it('accepts an empty projects array', () => {
    expect(
      Library.safeParse({ profile: validProfile, projects: [] }).success,
    ).toBe(true);
  });

  it('rejects a project inside the library that fails the id constraint', () => {
    expect(
      Library.safeParse({
        profile: validProfile,
        projects: [{ ...validProject, id: 'Bad_Id' }],
      }).success,
    ).toBe(false);
  });
});

describe('Resume', () => {
  it('parses a valid resume', () => {
    expect(() =>
      Resume.parse({ sourceMd: '# Ada Lovelace\n\nStaff Engineer', updatedAt: Date.now() }),
    ).not.toThrow();
  });

  it('rejects a non-number updatedAt', () => {
    expect(
      Resume.safeParse({ sourceMd: '# x', updatedAt: '2026-07-18' }).success,
    ).toBe(false);
  });
});
