import { describe, expect, it } from 'vitest';

import {
  Brief,
  EvalRun,
  EvalSuite,
  Job,
  JobStatus,
  TailoredResume,
  UsageEvent,
  UsageOp,
} from '@/lib/schemas/persisted';

// Hand-built valid fixtures only — NOT the PRD §6 fixture corpus (02-evaluation's
// fixtures/** does not exist yet and must not be referenced here). Nested pipeline
// sub-objects are constructed inline (self-contained; test files do not import
// from each other) using the same minimal-valid shapes pipeline.test.ts already
// validated against FND-03's merged schemas.

// --- pipeline sub-fixtures (known-valid against FND-03) ----------------------

const validJdExtract = {
  requirements: [
    { id: 'r0', text: 'requirement 0', weight: 2 as const, category: 'technical' as const },
    { id: 'r1', text: 'requirement 1', weight: 3 as const, category: 'experience' as const },
  ],
  atsKeywords: ['kubernetes', 'typescript'],
  subtext: ['fast-moving team'],
};

const validBinding = {
  requirementId: 'r0',
  projectId: 'voice-agent',
  strength: 'strong' as const,
  evidence: 'Built streaming ASR + LLM orchestration behind a single WebSocket.',
};

const validGap = {
  requirementId: 'r1',
  probe: 'How would you scale this to 1M concurrent sessions?',
  play: 'Bridge from the 12k-MAU realtime system to horizontal sharding.',
};

const validLedger = {
  bindings: [validBinding],
  gaps: [validGap],
};

const validSubScore = {
  score: 80,
  bindings: ['r0'],
  gaps: ['r1'],
};

const validFitReport = {
  hardRequirements: [
    { label: 'visa', status: 'pass' as const },
    { label: 'location', status: 'unknown' as const },
  ],
  subScores: {
    technical: validSubScore,
    experienceDepth: validSubScore,
    domain: validSubScore,
    evidenceStrength: validSubScore,
  },
  compositeScore: 78,
  tier: 'Strong' as const,
  advice: 'Lead with the realtime orchestration work.',
  topGaps: [validGap],
};

const validAlignment = [
  { keyword: 'k8s', status: 'present' as const },
  { keyword: 'terraform', status: 'missing_in_resume' as const },
];

const validEdit = {
  original: 'Worked on backend.',
  suggested: 'Led the streaming-ASR backend serving 12k MAU.',
  rationale: 'Adds a real metric and ownership signal.',
  projectId: 'voice-agent',
};

const validIntel = {
  snapshot: 'Seed-stage devtools company, ~30 people.',
  recent: [{ headline: 'Raised Series B', soWhat: 'Hiring aggressively.' }],
  engineeringSignals: ['monorepo', 'trunk-based'],
  talkingPoints: ['their latency work'],
};

const validRehearseQuestion = {
  projectId: 'voice-agent',
  question: 'Why barge-in over half-duplex?',
  trap: 'And what did that cost you in echo cancellation?',
};

const validRehearse = {
  questions: Array.from({ length: 5 }, () => validRehearseQuestion),
  askThem: ['a', 'b', 'c'],
  positioning: 'A realtime-systems engineer who ships.',
};

// --- persisted-entity fixtures ----------------------------------------------

const validJob = {
  id: 'job-1',
  userId: 'user-1',
  company: 'Acme',
  role: 'Staff Engineer',
  status: 'screening' as const,
  jdRaw: 'We are hiring a Staff Engineer...',
  jd: validJdExtract,
  ledger: validLedger,
  fit: validFitReport,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const validTailoredResume = {
  jobId: 'job-1',
  alignment: validAlignment,
  edits: [validEdit],
  fullDraftMd: '# Jane Doe\n\nStaff Engineer...',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const validBrief = {
  jobId: 'job-1',
  intel: validIntel,
  rehearse: validRehearse,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const validUsageEvent = {
  userId: 'user-1',
  op: 'cross' as const,
  tokensIn: 1200,
  tokensOut: 800,
  searches: 0,
  costUsd: 0.042,
  durationMs: 3100,
  createdAt: 1_700_000_000_000,
};

const validEvalRun = {
  id: 'eval-1',
  suite: 'q1' as const,
  op: 'read' as const,
  passRate: 0.92,
  details: { failures: ['case-3'] },
  createdAt: 1_700_000_000_000,
};

// --- JobStatus --------------------------------------------------------------

describe('JobStatus', () => {
  it('accepts each of the four PRD status values', () => {
    for (const s of ['screening', 'applied', 'interviewing', 'closed']) {
      expect(JobStatus.safeParse(s).success).toBe(true);
    }
  });

  it('rejects a fifth arbitrary string', () => {
    expect(JobStatus.safeParse('archived').success).toBe(false);
  });
});

// --- Job (load-bearing atomicity guarantee) ---------------------------------

describe('Job', () => {
  it('parses a fully valid Job with jd/ledger/fit all present', () => {
    expect(() => Job.parse(validJob)).not.toThrow();
  });

  // Acceptance item 1: jd/ledger/fit are each REQUIRED — proved independently,
  // one it() per field, using the destructured-omit pattern (a truly absent key,
  // not an explicit `undefined` value).
  it('rejects a Job missing jd', () => {
    const { jd, ...rest } = validJob;
    void jd;
    expect(Job.safeParse(rest).success).toBe(false);
  });

  it('rejects a Job missing ledger', () => {
    const { ledger, ...rest } = validJob;
    void ledger;
    expect(Job.safeParse(rest).success).toBe(false);
  });

  it('rejects a Job missing fit', () => {
    const { fit, ...rest } = validJob;
    void fit;
    expect(Job.safeParse(rest).success).toBe(false);
  });

  it('accepts each JobStatus value on a Job', () => {
    for (const status of ['screening', 'applied', 'interviewing', 'closed']) {
      expect(Job.safeParse({ ...validJob, status }).success).toBe(true);
    }
  });

  it('rejects an invalid status on a Job', () => {
    expect(Job.safeParse({ ...validJob, status: 'archived' }).success).toBe(false);
  });
});

// --- TailoredResume ---------------------------------------------------------

describe('TailoredResume', () => {
  it('parses a valid TailoredResume', () => {
    expect(() => TailoredResume.parse(validTailoredResume)).not.toThrow();
  });

  it('accepts empty alignment and edits arrays (no .min(1) in the §5.6 shape)', () => {
    expect(
      TailoredResume.safeParse({ ...validTailoredResume, alignment: [], edits: [] }).success,
    ).toBe(true);
  });

  it('rejects a missing fullDraftMd', () => {
    const { fullDraftMd, ...rest } = validTailoredResume;
    void fullDraftMd;
    expect(TailoredResume.safeParse(rest).success).toBe(false);
  });
});

// --- Brief (intel nullable / rehearse required asymmetry) -------------------

describe('Brief', () => {
  // Acceptance item 2: intel nullable, rehearse required.
  it('parses a Brief with intel: null and a valid rehearse (P3 degrade-not-block)', () => {
    expect(() =>
      Brief.parse({
        jobId: 'job-1',
        intel: null,
        rehearse: validRehearse,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      }),
    ).not.toThrow();
  });

  it('parses a Brief with a non-null intel (non-degraded path)', () => {
    expect(() => Brief.parse(validBrief)).not.toThrow();
  });

  // Acceptance item 3: rehearse is required — omitting it fails, even with a
  // valid intel present.
  it('rejects a Brief with rehearse omitted (REHEARSE failure is not degraded)', () => {
    expect(
      Brief.safeParse({
        jobId: 'job-1',
        intel: validIntel,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      }).success,
    ).toBe(false);
  });

  it('rejects a Brief with rehearse: null (rehearse is not nullable)', () => {
    expect(Brief.safeParse({ ...validBrief, rehearse: null }).success).toBe(false);
  });
});

// --- UsageOp / UsageEvent (score exclusion) ---------------------------------

describe('UsageOp', () => {
  it('accepts each of the six model-calling pipeline stages', () => {
    for (const op of ['parse', 'read', 'cross', 'tailor', 'research', 'rehearse']) {
      expect(UsageOp.safeParse(op).success).toBe(true);
    }
  });

  // Acceptance item 4 (enum level): SCORE is pure code, never its own usage op.
  it("rejects 'score' (SCORE never produces its own UsageEvent)", () => {
    expect(UsageOp.safeParse('score').success).toBe(false);
  });
});

describe('UsageEvent', () => {
  it('parses a valid UsageEvent with all fields present', () => {
    expect(() => UsageEvent.parse(validUsageEvent)).not.toThrow();
  });

  // Acceptance item 4 (object level): the field is actually wired to reject it.
  it("rejects op: 'score' at the UsageEvent object level", () => {
    expect(UsageEvent.safeParse({ ...validUsageEvent, op: 'score' }).success).toBe(false);
  });

  it('rejects a missing costUsd', () => {
    const { costUsd, ...rest } = validUsageEvent;
    void costUsd;
    expect(UsageEvent.safeParse(rest).success).toBe(false);
  });
});

// --- EvalSuite / EvalRun ----------------------------------------------------

describe('EvalSuite', () => {
  it('accepts q1/q2/q3', () => {
    for (const s of ['q1', 'q2', 'q3']) {
      expect(EvalSuite.safeParse(s).success).toBe(true);
    }
  });

  it('rejects a fourth suite string', () => {
    expect(EvalSuite.safeParse('q4').success).toBe(false);
  });
});

describe('EvalRun', () => {
  it('parses a valid EvalRun with a fractional passRate and a details record', () => {
    expect(() => EvalRun.parse(validEvalRun)).not.toThrow();
  });

  it('rejects a passRate below 0 or above 1 (0–1 fraction, not a percentage)', () => {
    expect(EvalRun.safeParse({ ...validEvalRun, passRate: -0.1 }).success).toBe(false);
    expect(EvalRun.safeParse({ ...validEvalRun, passRate: 1.1 }).success).toBe(false);
  });

  it('accepts passRate at the 0 and 1 bounds', () => {
    expect(EvalRun.safeParse({ ...validEvalRun, passRate: 0 }).success).toBe(true);
    expect(EvalRun.safeParse({ ...validEvalRun, passRate: 1 }).success).toBe(true);
  });

  it("rejects op: 'score' (EvalRun.op reuses UsageOp's score exclusion)", () => {
    expect(EvalRun.safeParse({ ...validEvalRun, op: 'score' }).success).toBe(false);
  });
});
