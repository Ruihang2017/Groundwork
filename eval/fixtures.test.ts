import { describe, expect, it } from 'vitest';

import { loadFixtures } from '@/eval/fixtures';

// EVL-02 Test-plan — loadFixtures reads EVL-01's manifest + referenced files and
// derives id (basename) + text (file content). Run through the `@/eval` alias
// (Vitest resolves it) — the plain-Node `.ts`-extension constraint is only for
// the self-check subprocess path, not for Vitest.

describe('loadFixtures', () => {
  it('loads exactly 10 JDs and 3 resumes with derived id + text', () => {
    const { jds, resumes } = loadFixtures();
    expect(jds).toHaveLength(10);
    expect(resumes).toHaveLength(3);
  });

  it('derives id from the file basename (no .md extension)', () => {
    const { jds, resumes } = loadFixtures();
    expect(jds.map((jd) => jd.id)).toContain('ai-ml-engineer-01');
    expect(jds.map((jd) => jd.id)).toContain('adversarial-thin');
    expect(resumes.map((resume) => resume.id)).toContain('synthetic-junior');
    // no id retains the ".md" suffix
    expect([...jds, ...resumes].every((f) => !f.id.endsWith('.md'))).toBe(true);
  });

  it('reads the actual file content into text and carries category/seniority', () => {
    const { jds, resumes } = loadFixtures();
    for (const jd of jds) {
      expect(jd.text.length).toBeGreaterThan(0);
      expect(typeof jd.category).toBe('string');
      expect(jd.category.length).toBeGreaterThan(0);
    }
    for (const resume of resumes) {
      expect(resume.text.length).toBeGreaterThan(0);
      expect(['junior', 'mid', 'senior']).toContain(resume.seniority);
    }
  });
});
