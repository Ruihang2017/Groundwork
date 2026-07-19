import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  assertQ1Coverage,
  assertQ1DroppedRate,
  assertQ1NumberIntegrity,
  assertQ1Questions,
  assertQ1Schema,
} from '@/eval/assertions/q1';
import type { JdExtract, Ledger, Rehearse } from '@/lib/schemas/pipeline';

// EVL-02 Test-plan items 1–5, mapping the acceptance checklist. Hand-built mock
// JdExtract/Ledger/Rehearse-shaped objects, one clean-passing + one violating per
// PRD-cited rule.

// --- mock builders -----------------------------------------------------------

const jdWith = (ids: string[]): JdExtract => ({
  requirements: ids.map((id) => ({ id, text: id, weight: 2 as const, category: 'technical' as const })),
  atsKeywords: [],
  subtext: [],
});

const binding = (requirementId: string) => ({
  requirementId,
  projectId: 'p1',
  strength: 'strong' as const,
  evidence: 'evidence',
});

const gap = (requirementId: string) => ({ requirementId, probe: 'probe', play: 'play' });

const rehearseWithTraps = (traps: string[]): Rehearse => ({
  questions: traps.map((trap, i) => ({ projectId: 'p1', question: `q${i}`, trap })),
  askThem: ['a', 'b', 'c'],
  positioning: 'positioning',
});

// --- assertQ1Schema (acceptance: passes valid, fails invalid) ----------------

describe('assertQ1Schema', () => {
  const schema = z.object({ id: z.string(), score: z.number() });

  it('passes a schema-valid output', () => {
    expect(assertQ1Schema({ id: 'x', score: 1 }, schema, false)).toMatchObject({ pass: true });
  });

  it('fails a schema-invalid output', () => {
    expect(assertQ1Schema({ id: 123 }, schema, false).pass).toBe(false);
  });

  it('distinguishes the two failure modes via detail wording (repairAttempted)', () => {
    expect(assertQ1Schema({ id: 123 }, schema, false).detail).toMatch(/no repair attempted/);
    expect(assertQ1Schema({ id: 123 }, schema, true).detail).toMatch(/even after 1 repair attempt/);
  });
});

// --- assertQ1Coverage (acceptance: two failure modes + clean pass) -----------

describe('assertQ1Coverage', () => {
  it('fails when a requirement id is absent from both bindings and gaps', () => {
    const result = assertQ1Coverage(jdWith(['r1', 'r2']), {
      bindings: [binding('r1')],
      gaps: [],
    });
    expect(result.pass).toBe(false);
    expect(result.uncoveredCount).toBe(1);
  });

  it('fails when a requirement id appears in BOTH bindings and gaps (恰好一次 double-check)', () => {
    const ledger: Ledger = { bindings: [binding('r1')], gaps: [gap('r1')] };
    const result = assertQ1Coverage(jdWith(['r1']), ledger);
    expect(result.pass).toBe(false);
    // uncoveredCount is 0 here — the failure is the duplicate, not an uncovered req.
    expect(result.uncoveredCount).toBe(0);
  });

  it('passes when every requirement is covered exactly once', () => {
    const ledger: Ledger = { bindings: [binding('r1')], gaps: [gap('r2')] };
    expect(assertQ1Coverage(jdWith(['r1', 'r2']), ledger).pass).toBe(true);
  });
});

// --- assertQ1Questions (acceptance: empty trap fails) ------------------------

describe('assertQ1Questions', () => {
  it('fails when any of the 5 traps is an empty string', () => {
    expect(assertQ1Questions(rehearseWithTraps(['t', 't', '', 't', 't'])).pass).toBe(false);
  });

  it('passes when all 5 traps are non-empty', () => {
    expect(assertQ1Questions(rehearseWithTraps(['t', 't', 't', 't', 't'])).pass).toBe(true);
  });

  it('fails when there are not exactly 5 questions (does not assume Zod already ran)', () => {
    expect(assertQ1Questions(rehearseWithTraps(['t', 't', 't'])).pass).toBe(false);
  });
});

// --- assertQ1NumberIntegrity (acceptance: >0 fails, ==0 passes) ---------------

describe('assertQ1NumberIntegrity', () => {
  const sourcePool = { resumeMd: 'Served 12,000 users, cut latency 40%.', libraryMetrics: [] };

  it('fails when a number is absent from both the resume and library metrics', () => {
    const result = assertQ1NumberIntegrity({ fullDraftMd: 'Served 999,999 users.' }, sourcePool);
    expect(result.pass).toBe(false);
    expect(result.violationCount).toBeGreaterThan(0);
  });

  it('passes at exactly 0 violations', () => {
    const result = assertQ1NumberIntegrity({ fullDraftMd: 'Served 12,000 users, 40% faster.' }, sourcePool);
    expect(result.pass).toBe(true);
    expect(result.violationCount).toBe(0);
  });
});

// --- assertQ1DroppedRate (acceptance: strict < boundary) ---------------------

describe('assertQ1DroppedRate', () => {
  it('fails at exactly rate = 0.15 (< is strict, not <=)', () => {
    const result = assertQ1DroppedRate(15, 100);
    expect(result.rate).toBe(0.15);
    expect(result.pass).toBe(false);
  });

  it('passes just under the boundary (14.99%)', () => {
    expect(assertQ1DroppedRate(14.99, 100).pass).toBe(true);
    expect(assertQ1DroppedRate(1499, 10000).pass).toBe(true);
  });

  it('degenerates totalCount 0 to rate 0 / pass, not NaN', () => {
    const result = assertQ1DroppedRate(0, 0);
    expect(result.rate).toBe(0);
    expect(result.pass).toBe(true);
  });
});
