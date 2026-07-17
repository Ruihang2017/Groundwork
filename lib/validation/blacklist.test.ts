import { describe, expect, it } from 'vitest';

import {
  BLACKLIST_PATTERNS,
  flagBlacklistedPhrases,
} from '@/lib/validation/blacklist';

describe('flagBlacklistedPhrases', () => {
  it('matches "be honest" case-insensitively without altering the input text', () => {
    const input = 'To be honest, I think this is fine.';
    const { flagged } = flagBlacklistedPhrases(input);

    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.some((f) => f.match.toLowerCase() === 'be honest')).toBe(true);
    // input unchanged (non-mutating, per PRD "记录不阻断")
    expect(input).toBe('To be honest, I think this is fine.');
  });

  it('is case-insensitive across variants', () => {
    expect(flagBlacklistedPhrases('BE HONEST').flagged).toHaveLength(1);
    expect(flagBlacklistedPhrases('Be Honest').flagged).toHaveLength(1);
  });

  it('flags each of the other three starter phrases', () => {
    expect(flagBlacklistedPhrases('please stay calm now').flagged).toHaveLength(1);
    expect(flagBlacklistedPhrases('at the end of the day it works').flagged).toHaveLength(1);
    expect(flagBlacklistedPhrases("it's important to note this").flagged).toHaveLength(1);
  });

  it('flags the curly-apostrophe variant of "it’s important to note"', () => {
    expect(flagBlacklistedPhrases('it’s important to note this').flagged).toHaveLength(1);
  });

  it('returns an empty flagged array for clean text', () => {
    expect(flagBlacklistedPhrases('This is a direct, specific sentence.').flagged).toEqual([]);
  });

  it('returns multiple entries for multiple distinct phrases, non-deduplicated', () => {
    const { flagged } = flagBlacklistedPhrases(
      'Be honest: at the end of the day, be honest again.',
    );
    expect(flagged).toHaveLength(3);
    expect(flagged.map((f) => f.match.toLowerCase())).toEqual([
      'be honest',
      'be honest',
      'at the end of the day',
    ]);
  });

  it('reports the originating pattern source for each match', () => {
    const { flagged } = flagBlacklistedPhrases('stay calm');
    expect(flagged[0].pattern).toBe(BLACKLIST_PATTERNS[1].source);
  });
});
