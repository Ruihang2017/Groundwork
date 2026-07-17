import { describe, expect, it } from 'vitest';

import {
  Alignment,
  AlignmentEntry,
  Binding,
  BindingStrength,
  Edit,
  FitReport,
  FitTier,
  Gap,
  HardRequirementCheck,
  Intel,
  IntelRecentItem,
  JdExtract,
  Ledger,
  Rehearse,
  RehearseQuestion,
  RequirementCategory,
  SubScore,
} from '@/lib/schemas/pipeline';

// Hand-built valid fixtures only — NOT the PRD §6 fixture corpus (02-evaluation's
// fixtures/** does not exist yet and must not be referenced here). Pure inline
// schema-parsing assertions.

// --- helpers ----------------------------------------------------------------

const makeRequirement = (i: number) => ({
  id: `r${i}`,
  text: `requirement ${i}`,
  weight: 2 as const,
  category: 'technical' as const,
});

const validJdExtract = {
  requirements: Array.from({ length: 11 }, (_, i) => makeRequirement(i)),
  atsKeywords: ['kubernetes', 'typescript'],
  subtext: ['fast-moving team', 'ambiguous scope'],
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

// --- RequirementCategory ----------------------------------------------------

describe('RequirementCategory', () => {
  it('accepts each of the four PRD categories', () => {
    for (const c of ['technical', 'experience', 'domain', 'logistics']) {
      expect(RequirementCategory.safeParse(c).success).toBe(true);
    }
  });

  it('rejects a value outside the enum', () => {
    expect(RequirementCategory.safeParse('behavioral').success).toBe(false);
  });
});

// --- JdExtract --------------------------------------------------------------

describe('JdExtract', () => {
  it('parses a valid object with exactly 11 requirements', () => {
    expect(() => JdExtract.parse(validJdExtract)).not.toThrow();
  });

  it('rejects a 12th requirement (array max 11)', () => {
    const twelve = {
      ...validJdExtract,
      requirements: Array.from({ length: 12 }, (_, i) => makeRequirement(i)),
    };
    expect(JdExtract.safeParse(twelve).success).toBe(false);
  });

  it.each([1, 2, 3])('accepts weight %i', (weight) => {
    const jd = {
      ...validJdExtract,
      requirements: [{ ...makeRequirement(0), weight }],
    };
    expect(JdExtract.safeParse(jd).success).toBe(true);
  });

  it('rejects weight 4', () => {
    const jd = {
      ...validJdExtract,
      requirements: [{ ...makeRequirement(0), weight: 4 }],
    };
    expect(JdExtract.safeParse(jd).success).toBe(false);
  });

  it('accepts all four category values and rejects a fifth', () => {
    for (const category of ['technical', 'experience', 'domain', 'logistics']) {
      const jd = {
        ...validJdExtract,
        requirements: [{ ...makeRequirement(0), category }],
      };
      expect(JdExtract.safeParse(jd).success).toBe(true);
    }
    const bad = {
      ...validJdExtract,
      requirements: [{ ...makeRequirement(0), category: 'behavioral' }],
    };
    expect(JdExtract.safeParse(bad).success).toBe(false);
  });

  it('rejects a 4th subtext entry (array max 3)', () => {
    const jd = { ...validJdExtract, subtext: ['a', 'b', 'c', 'd'] };
    expect(JdExtract.safeParse(jd).success).toBe(false);
  });

  it('accepts an empty requirements array', () => {
    expect(JdExtract.safeParse({ ...validJdExtract, requirements: [] }).success).toBe(true);
  });
});

// --- Ledger / Binding / Gap -------------------------------------------------

describe('BindingStrength', () => {
  it('accepts strong and partial', () => {
    expect(BindingStrength.safeParse('strong').success).toBe(true);
    expect(BindingStrength.safeParse('partial').success).toBe(true);
  });

  it("rejects 'gap' (a gap is never a binding strength — disjoint-union design)", () => {
    expect(BindingStrength.safeParse('gap').success).toBe(false);
  });

  it('rejects an arbitrary string outside the enum', () => {
    expect(BindingStrength.safeParse('weak').success).toBe(false);
  });
});

describe('Binding', () => {
  it('parses a valid binding', () => {
    expect(() => Binding.parse(validBinding)).not.toThrow();
  });

  it("rejects strength outside {'strong','partial'}", () => {
    expect(Binding.safeParse({ ...validBinding, strength: 'gap' }).success).toBe(false);
  });
});

describe('Gap', () => {
  it('parses a valid gap', () => {
    expect(() => Gap.parse(validGap)).not.toThrow();
  });
});

describe('Ledger', () => {
  it('parses a valid ledger with one binding and one gap', () => {
    expect(() =>
      Ledger.parse({ bindings: [validBinding], gaps: [validGap] }),
    ).not.toThrow();
  });

  it('accepts empty bindings and gaps arrays', () => {
    expect(Ledger.safeParse({ bindings: [], gaps: [] }).success).toBe(true);
  });
});

// --- FitReport --------------------------------------------------------------

describe('HardRequirementCheck', () => {
  it('accepts each of pass/fail/unknown', () => {
    for (const status of ['pass', 'fail', 'unknown']) {
      expect(HardRequirementCheck.safeParse({ label: 'visa', status }).success).toBe(true);
    }
  });

  it('rejects a status outside the enum', () => {
    expect(HardRequirementCheck.safeParse({ label: 'visa', status: 'maybe' }).success).toBe(
      false,
    );
  });
});

describe('SubScore', () => {
  it('parses a valid sub-score', () => {
    expect(() => SubScore.parse(validSubScore)).not.toThrow();
  });

  it('rejects a score below 0 or above 100', () => {
    expect(SubScore.safeParse({ ...validSubScore, score: -1 }).success).toBe(false);
    expect(SubScore.safeParse({ ...validSubScore, score: 101 }).success).toBe(false);
  });
});

describe('FitTier', () => {
  it('accepts each of the four literal PRD tier strings', () => {
    for (const tier of ['Strong', 'Competitive', 'Stretch', 'Long shot']) {
      expect(FitTier.safeParse(tier).success).toBe(true);
    }
  });

  it('rejects a fifth arbitrary tier string', () => {
    expect(FitTier.safeParse('Excellent').success).toBe(false);
  });
});

describe('FitReport', () => {
  it('parses a valid object with all four subScores keys', () => {
    expect(() => FitReport.parse(validFitReport)).not.toThrow();
  });

  it('rejects a compositeScore below 0 or above 100', () => {
    expect(FitReport.safeParse({ ...validFitReport, compositeScore: -1 }).success).toBe(false);
    expect(FitReport.safeParse({ ...validFitReport, compositeScore: 101 }).success).toBe(false);
  });

  it('accepts each of the four literal tier strings', () => {
    for (const tier of ['Strong', 'Competitive', 'Stretch', 'Long shot']) {
      expect(FitReport.safeParse({ ...validFitReport, tier }).success).toBe(true);
    }
  });

  it('rejects a fifth arbitrary tier string', () => {
    expect(FitReport.safeParse({ ...validFitReport, tier: 'Excellent' }).success).toBe(false);
  });

  it('rejects a missing subScores key', () => {
    const { evidenceStrength, ...partialSubScores } = validFitReport.subScores;
    void evidenceStrength;
    expect(
      FitReport.safeParse({ ...validFitReport, subScores: partialSubScores }).success,
    ).toBe(false);
  });
});

// --- Alignment / AlignmentEntry ---------------------------------------------

describe('AlignmentEntry', () => {
  it('accepts each of the four status values', () => {
    for (const status of [
      'present',
      'missing_in_resume',
      'missing_in_library',
      'synonym_mismatch',
    ]) {
      expect(AlignmentEntry.safeParse({ keyword: 'k8s', status }).success).toBe(true);
    }
  });

  it('rejects a status outside the four-item enum', () => {
    expect(AlignmentEntry.safeParse({ keyword: 'k8s', status: 'partial' }).success).toBe(false);
  });

  it('parses with note omitted (optional)', () => {
    expect(AlignmentEntry.safeParse({ keyword: 'k8s', status: 'present' }).success).toBe(true);
  });

  it('parses with note present', () => {
    expect(
      AlignmentEntry.safeParse({
        keyword: 'K8s',
        status: 'synonym_mismatch',
        note: "resume says 'Kubernetes'",
      }).success,
    ).toBe(true);
  });
});

describe('Alignment', () => {
  it('parses a bare array (not object-wrapped) covering all four statuses', () => {
    const alignment = [
      { keyword: 'a', status: 'present' as const },
      { keyword: 'b', status: 'missing_in_resume' as const },
      { keyword: 'c', status: 'missing_in_library' as const },
      { keyword: 'd', status: 'synonym_mismatch' as const },
    ];
    expect(() => Alignment.parse(alignment)).not.toThrow();
  });

  it('accepts an empty array', () => {
    expect(Alignment.safeParse([]).success).toBe(true);
  });
});

// --- Edit -------------------------------------------------------------------

describe('Edit', () => {
  it('parses a valid object with all four required string fields', () => {
    expect(() =>
      Edit.parse({
        original: 'Worked on backend.',
        suggested: 'Led the streaming-ASR backend serving 12k MAU.',
        rationale: 'Adds a real metric and ownership signal.',
        projectId: 'voice-agent',
      }),
    ).not.toThrow();
  });

  it('rejects a missing field', () => {
    expect(
      Edit.safeParse({
        original: 'x',
        suggested: 'y',
        rationale: 'z',
      }).success,
    ).toBe(false);
  });
});

// --- Intel ------------------------------------------------------------------

describe('IntelRecentItem', () => {
  it('parses a valid recent item', () => {
    expect(() =>
      IntelRecentItem.parse({ headline: 'Raised Series B', soWhat: 'Hiring aggressively.' }),
    ).not.toThrow();
  });
});

describe('Intel', () => {
  const validIntel = {
    snapshot: 'Seed-stage devtools company, ~30 people.',
    recent: [
      { headline: 'Launched v2 API', soWhat: 'Signals platform investment.' },
      { headline: 'Hired VP Eng', soWhat: 'Scaling the team.' },
      { headline: 'Open-sourced SDK', soWhat: 'Values community.' },
    ],
    engineeringSignals: ['monorepo', 'trunk-based', 'heavy CI'],
    talkingPoints: ['their latency work', 'their DX focus', 'their OSS'],
  };

  it('parses a valid object with three of each capped array', () => {
    expect(() => Intel.parse(validIntel)).not.toThrow();
  });

  it('accepts empty arrays for recent/engineeringSignals/talkingPoints (查无实据返回空数组)', () => {
    expect(
      Intel.safeParse({
        snapshot: 'Nothing found.',
        recent: [],
        engineeringSignals: [],
        talkingPoints: [],
      }).success,
    ).toBe(true);
  });

  it('rejects a 4th recent item', () => {
    expect(
      Intel.safeParse({
        ...validIntel,
        recent: [...validIntel.recent, { headline: 'x', soWhat: 'y' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a 4th engineeringSignals item', () => {
    expect(
      Intel.safeParse({
        ...validIntel,
        engineeringSignals: [...validIntel.engineeringSignals, 'extra'],
      }).success,
    ).toBe(false);
  });

  it('rejects a 4th talkingPoints item', () => {
    expect(
      Intel.safeParse({
        ...validIntel,
        talkingPoints: [...validIntel.talkingPoints, 'extra'],
      }).success,
    ).toBe(false);
  });
});

// --- Rehearse / RehearseQuestion --------------------------------------------

describe('RehearseQuestion', () => {
  it('parses a valid question', () => {
    expect(() => RehearseQuestion.parse(validRehearseQuestion)).not.toThrow();
  });

  it('rejects an empty trap string', () => {
    expect(RehearseQuestion.safeParse({ ...validRehearseQuestion, trap: '' }).success).toBe(
      false,
    );
  });
});

describe('Rehearse', () => {
  it('parses a valid object with exactly 5 questions and exactly 3 askThem', () => {
    expect(() => Rehearse.parse(validRehearse)).not.toThrow();
  });

  it('rejects questions arrays of length 4 and 6', () => {
    const four = {
      ...validRehearse,
      questions: Array.from({ length: 4 }, () => validRehearseQuestion),
    };
    const six = {
      ...validRehearse,
      questions: Array.from({ length: 6 }, () => validRehearseQuestion),
    };
    expect(Rehearse.safeParse(four).success).toBe(false);
    expect(Rehearse.safeParse(six).success).toBe(false);
  });

  it('rejects askThem arrays of length 2 and 4', () => {
    expect(Rehearse.safeParse({ ...validRehearse, askThem: ['a', 'b'] }).success).toBe(false);
    expect(
      Rehearse.safeParse({ ...validRehearse, askThem: ['a', 'b', 'c', 'd'] }).success,
    ).toBe(false);
  });
});
