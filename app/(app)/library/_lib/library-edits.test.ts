import { describe, expect, it } from 'vitest';

import {
  DRAFT_LIBRARY_FIXTURE,
  RESUME_MD_FIXTURE,
  THREE_PROJECT_FIXTURE,
} from '@/app/(app)/library/_fixtures/library-fixtures';
import { loadFixtures } from '@/eval/fixtures';
import {
  blankProject,
  countMissingMetrics,
  joinList,
  makeProjectId,
  newUid,
  splitList,
} from '@/app/(app)/library/_lib/library-edits';
import { Library, PROJECT_ID_PATTERN, Project } from '@/lib/schemas/entities';

// Node environment on purpose — nothing here touches the DOM.

describe('splitList (plan §4 E1 — the highest-consequence bug in this ticket)', () => {
  it('[machine] returns an empty array for an empty field, never a single empty string', () => {
    // `['']` has length 1, which would make `metrics.length === 0` false and
    // silently delete both empty-metrics UI elements.
    expect(splitList('', 'line')).toEqual([]);
    expect(splitList('', 'comma')).toEqual([]);
    expect(splitList('   \n  \n ', 'line')).toEqual([]);
    expect(splitList(' , , ', 'comma')).toEqual([]);
  });

  it('trims entries and drops empty ones', () => {
    expect(splitList(' a , ,b ', 'comma')).toEqual(['a', 'b']);
    expect(splitList('  one  \n\n  two  ', 'line')).toEqual(['one', 'two']);
  });

  it('handles CRLF line endings (resume pasted from Windows Word)', () => {
    expect(splitList('92% coverage\r\nunder 1.5s\r\n', 'line')).toEqual([
      '92% coverage',
      'under 1.5s',
    ]);
  });

  it('does not split a comma-containing metric when the separator is line', () => {
    expect(splitList('cut p95 from 1,200ms to 380ms', 'line')).toEqual([
      'cut p95 from 1,200ms to 380ms',
    ]);
  });

  it('round-trips with joinList', () => {
    const values = ['TypeScript', 'React', 'PostgreSQL'];
    expect(splitList(joinList(values, 'comma'), 'comma')).toEqual(values);
    expect(splitList(joinList(values, 'line'), 'line')).toEqual(values);
  });

  it('joinList produces empty text for an empty array (and back again)', () => {
    expect(joinList([], 'line')).toBe('');
    expect(splitList(joinList([], 'line'), 'line')).toEqual([]);
  });
});

describe('makeProjectId', () => {
  const cases: Array<[label: string, name: string]> = [
    ['a normal name', 'Trailmark — hiking route tracker'],
    ['a CJK-only name (plan §4 E8)', '语音助手'],
    ['an empty name', ''],
    ['punctuation only', '!!! ??? ...'],
    ['leading/trailing junk', '  --Voice Agent--  '],
    ['a 200-char name', 'a'.repeat(200)],
    ['mixed case with underscores', 'My_Cool_Project V2'],
  ];

  for (const [label, name] of cases) {
    it(`[machine] always yields an id matching PROJECT_ID_PATTERN — ${label}`, () => {
      const id = makeProjectId(name, new Set());
      expect(id).toMatch(PROJECT_ID_PATTERN);
      // And it is accepted by the real schema, not just the regex.
      expect(Project.safeParse({ ...blankProject(new Set()), id }).success).toBe(true);
    });
  }

  it('kebab-cases a normal name', () => {
    expect(makeProjectId('Voice Agent', new Set())).toBe('voice-agent');
  });

  it('falls back to "project" when the name has no [a-z0-9] at all', () => {
    expect(makeProjectId('语音助手', new Set())).toBe('project');
    expect(makeProjectId('', new Set())).toBe('project');
  });

  it('de-duplicates against ids already taken', () => {
    expect(makeProjectId('Voice Agent', new Set(['voice-agent']))).toBe('voice-agent-2');
    expect(makeProjectId('Voice Agent', new Set(['voice-agent', 'voice-agent-2']))).toBe(
      'voice-agent-3',
    );
    expect(makeProjectId('', new Set(['project']))).toBe('project-2');
  });

  it('caps length without leaving a trailing hyphen', () => {
    const id = makeProjectId(`${'x'.repeat(59)} tail`, new Set());
    expect(id.length).toBeLessThanOrEqual(60);
    expect(id.endsWith('-')).toBe(false);
    expect(id).toMatch(PROJECT_ID_PATTERN);
  });
});

describe('blankProject', () => {
  it('[machine] is schema-valid and has empty metrics (so it trips both warnings)', () => {
    const project = blankProject(new Set());
    expect(Project.safeParse(project).success).toBe(true);
    expect(project.metrics).toEqual([]);
    expect(project.stack).toEqual([]);
    expect(project.tags).toEqual([]);
  });

  it('uses LIB-01\'s "unknown" sentinel for unstated stage/role (closes LIB-01 §5 Q4)', () => {
    const project = blankProject(new Set());
    expect(project.stage).toBe('unknown');
    expect(project.role).toBe('unknown');
  });

  it('never collides with an id already in the library', () => {
    const project = blankProject(new Set(['project', 'project-2']));
    expect(project.id).toBe('project-3');
  });
});

describe('countMissingMetrics', () => {
  it('counts only projects whose metrics array is empty', () => {
    expect(countMissingMetrics(THREE_PROJECT_FIXTURE.projects)).toBe(2);
    expect(countMissingMetrics(DRAFT_LIBRARY_FIXTURE.projects)).toBe(1);
    expect(countMissingMetrics([])).toBe(0);
  });
});

describe('newUid', () => {
  it('returns distinct ids (React keys must not collide across rows)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newUid()));
    expect(ids.size).toBe(50);
  });
});

describe('fixtures self-check', () => {
  it('[machine] DRAFT_LIBRARY_FIXTURE satisfies FND-02\'s Library schema', () => {
    // A fixture that silently drifts from the schema would make several tests in
    // this ticket pass for the wrong reason.
    expect(Library.safeParse(DRAFT_LIBRARY_FIXTURE).success).toBe(true);
    expect(Library.safeParse(THREE_PROJECT_FIXTURE).success).toBe(true);
  });

  it('[machine] RESUME_MD_FIXTURE is byte-identical to EVL-01/EVL-02 corpus text', () => {
    // This file runs in the NODE environment, where `@/eval/fixtures` works. The
    // fixture module reads the same corpus file directly (it must also import
    // cleanly under jsdom, where that loader throws) — this assertion is what
    // stops the two paths drifting apart.
    const fromLoader = loadFixtures().resumes.find((r) => r.id === 'synthetic-junior');
    expect(fromLoader).toBeDefined();
    expect(RESUME_MD_FIXTURE).toBe(fromLoader?.text);
  });

  it('[machine] the fixture has MIXED metrics — some projects with, some without', () => {
    const withMetrics = DRAFT_LIBRARY_FIXTURE.projects.filter((p) => p.metrics.length > 0);
    const without = DRAFT_LIBRARY_FIXTURE.projects.filter((p) => p.metrics.length === 0);
    expect(withMetrics.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
  });
});
