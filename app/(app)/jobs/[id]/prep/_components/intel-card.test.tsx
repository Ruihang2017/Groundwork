// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import IntelCard, { INTEL_VERIFY_CAPTION } from '@/app/(app)/jobs/[id]/prep/_components/intel-card';
import {
  EMPTY_INTEL_FIXTURE,
  INTEL_FIXTURE,
} from '@/app/(app)/jobs/[id]/prep/_fixtures/brief-fixtures';

// PRP-04 Deliverable 2 — renders Intel when present; nothing when null (the banner covers
// that). Empty arrays are the valid 查无实据 state — no empty list is drawn.

afterEach(cleanup);

describe('IntelCard (PRP-04 Deliverable 2)', () => {
  it('[machine] renders NOTHING when intel === null (the banner covers that case)', () => {
    const { container } = render(<IntelCard intel={null} />);
    expect(container.textContent).toBe('');
  });

  it('[machine] renders snapshot, each recent headline + soWhat, signals, talking points, and the verify caption', () => {
    render(<IntelCard intel={INTEL_FIXTURE} />);

    expect(screen.getByText(INTEL_FIXTURE.snapshot)).toBeTruthy();
    for (const item of INTEL_FIXTURE.recent) {
      expect(screen.getByText(item.headline)).toBeTruthy();
      expect(screen.getByText(new RegExp(item.soWhat.replace(/[.()]/g, '\\$&')))).toBeTruthy();
    }
    for (const signal of INTEL_FIXTURE.engineeringSignals) {
      expect(screen.getByText(signal)).toBeTruthy();
    }
    for (const point of INTEL_FIXTURE.talkingPoints) {
      expect(screen.getByText(point)).toBeTruthy();
    }
    expect(screen.getByText(INTEL_VERIFY_CAPTION)).toBeTruthy();
  });

  it('[machine] renders the snapshot but NO empty lists for the 查无实据 state, and does not crash', () => {
    const { container } = render(<IntelCard intel={EMPTY_INTEL_FIXTURE} />);
    expect(screen.getByText(EMPTY_INTEL_FIXTURE.snapshot)).toBeTruthy();
    // No <ul> rendered when every array is empty (the caption is a <p>, not a list).
    expect(container.querySelector('ul')).toBeNull();
  });

  it('[machine] renders snapshot content as TEXT — web-sourced intel is never HTML', () => {
    render(
      <IntelCard
        intel={{
          ...EMPTY_INTEL_FIXTURE,
          snapshot: '<script>alert(1)</script> and <img src=x>',
        }}
      />,
    );
    expect(screen.getByText('<script>alert(1)</script> and <img src=x>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });
});
