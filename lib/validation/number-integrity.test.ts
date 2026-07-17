import { describe, expect, it } from 'vitest';

import {
  extractNumericTokens,
  filterNumberIntegrity,
} from '@/lib/validation/number-integrity';

describe('filterNumberIntegrity', () => {
  it('removes a numeric claim absent from both source-pool fields', () => {
    const { result, dropped } = filterNumberIntegrity('grew revenue 45%', {
      resumeMd: 'led backend team',
      libraryMetrics: [],
    });

    expect(result).not.toContain('45%');
    expect(dropped).toEqual([
      { token: '45%', reason: 'number not found in source resume or library metrics' },
    ]);
  });

  it('retains a numeric claim present in resumeMd', () => {
    const { result, dropped } = filterNumberIntegrity('grew revenue 45%', {
      resumeMd: 'Revenue grew 45% year over year',
      libraryMetrics: [],
    });

    expect(result).toContain('45%');
    expect(dropped).toEqual([]);
  });

  it('retains a numeric claim present only in libraryMetrics', () => {
    const { result, dropped } = filterNumberIntegrity('grew revenue 45%', {
      resumeMd: '',
      libraryMetrics: ['grew ARR 45%'],
    });

    expect(result).toContain('45%');
    expect(dropped).toEqual([]);
  });

  it('retains via case-insensitive / comma-normalized matching', () => {
    const { result, dropped } = filterNumberIntegrity('raised $1.2M across 12,000 users', {
      resumeMd: 'raised $1.2m from 12000 accounts',
      libraryMetrics: [],
    });

    expect(result).toContain('$1.2M');
    expect(result).toContain('12,000');
    expect(dropped).toEqual([]);
  });

  it('removes every occurrence of a repeated unsupported token', () => {
    const { result, dropped } = filterNumberIntegrity('99% here and 99% there', {
      resumeMd: 'no numbers',
      libraryMetrics: [],
    });

    expect(result).not.toContain('99%');
    expect(dropped).toHaveLength(2);
  });
});

describe('extractNumericTokens', () => {
  it('extracts integers, decimals, comma-grouped, percentages, currency, multipliers', () => {
    expect(extractNumericTokens('12')).toEqual(['12']);
    expect(extractNumericTokens('3.5')).toEqual(['3.5']);
    expect(extractNumericTokens('12,000')).toEqual(['12,000']);
    expect(extractNumericTokens('40%')).toEqual(['40%']);
    expect(extractNumericTokens('$1.2M')).toEqual(['$1.2M']);
    expect(extractNumericTokens('3x')).toEqual(['3x']);
  });

  it('truncates a unit-suffixed number to the numeric part', () => {
    expect(extractNumericTokens('300ms')).toEqual(['300']);
    expect(extractNumericTokens('45min')).toEqual(['45']);
  });

  it('does not extract digits embedded in an identifier', () => {
    expect(extractNumericTokens('K8s')).toEqual([]);
  });

  it('extracts multiple tokens in order', () => {
    expect(
      extractNumericTokens('reduced latency from 500ms to 300ms, a 40% improvement'),
    ).toEqual(['500', '300', '40%']);
  });
});
