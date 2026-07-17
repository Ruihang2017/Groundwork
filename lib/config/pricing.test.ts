import { describe, expect, it } from 'vitest';

import { estimateCostUsd, PRICING } from '@/lib/config/pricing';

// Pure-function unit tests — no DB, no env. Every arithmetic result below is
// hand-verified against PRD §9's raw per-token / per-search rates (NOT the
// rough per-operation estimates in §9's illustrative table).

describe('PRICING (raw rate table)', () => {
  // Direct transcription check — catches a typo independently of
  // estimateCostUsd's arithmetic being separately correct.
  it('transcribes PRD §9 raw unit prices exactly', () => {
    expect(PRICING).toEqual({
      sonnet5: { inPerMTok: 2, outPerMTok: 10 },
      sonnet5PostIntro: { inPerMTok: 3, outPerMTok: 15 },
      haiku45: { inPerMTok: 1, outPerMTok: 5 },
      webSearchPer1000: 10,
    });
  });
});

describe('estimateCostUsd', () => {
  // [acceptance item 1] the ticket's own literal example.
  // 100,000/1,000,000 * $2 = $0.20 (input) + 20,000/1,000,000 * $10 = $0.20
  // (output) = $0.40.
  it('computes the hand-verified sonnet5 example (100k in, 20k out, 0 searches) = 0.4', () => {
    expect(
      estimateCostUsd({
        model: 'sonnet5',
        tokensIn: 100_000,
        tokensOut: 20_000,
        searches: 0,
      }),
    ).toBe(0.4);
  });

  // Search cost is additive: + (3/1000 * $10) = +$0.03 on top of the $0.40 above.
  it('adds web-search cost additively (3 searches → +0.03)', () => {
    expect(
      estimateCostUsd({
        model: 'sonnet5',
        tokensIn: 100_000,
        tokensOut: 20_000,
        searches: 3,
      }),
    ).toBeCloseTo(0.43, 10);
  });

  // sonnet5PostIntro must produce a DIFFERENT (higher) result than sonnet5 with
  // identical token counts — proves the two Sonnet rate sets are genuinely
  // distinct, not aliased by a copy-paste error.
  // 100,000/1,000,000 * $3 = $0.30 + 20,000/1,000,000 * $15 = $0.30 = $0.60.
  it('uses the higher post-intro Sonnet rates, distinct from sonnet5', () => {
    const intro = estimateCostUsd({
      model: 'sonnet5',
      tokensIn: 100_000,
      tokensOut: 20_000,
      searches: 0,
    });
    const post = estimateCostUsd({
      model: 'sonnet5PostIntro',
      tokensIn: 100_000,
      tokensOut: 20_000,
      searches: 0,
    });
    // toBeCloseTo, not toBe: estimateCostUsd applies no rounding (plan §4), so
    // 0.1*3 + 0.02*15 lands on 0.6000000000000001, not an exact 0.6. The
    // load-bearing assertion is that the post-intro rates are genuinely higher.
    expect(post).toBeCloseTo(0.6, 10);
    expect(post).toBeGreaterThan(intro);
  });

  // Haiku rates ($1 in / $5 out): 100,000/1,000,000 * $1 = $0.10 +
  // 20,000/1,000,000 * $5 = $0.10 = $0.20.
  it('computes the hand-verified haiku45 example (100k in, 20k out) = 0.2', () => {
    expect(
      estimateCostUsd({
        model: 'haiku45',
        tokensIn: 100_000,
        tokensOut: 20_000,
        searches: 0,
      }),
    ).toBe(0.2);
  });

  // Zero-input boundary.
  it('returns 0 for all-zero inputs', () => {
    expect(
      estimateCostUsd({ model: 'sonnet5', tokensIn: 0, tokensOut: 0, searches: 0 }),
    ).toBe(0);
  });
});
