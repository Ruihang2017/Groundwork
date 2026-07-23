// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import BriefView from '@/app/(app)/jobs/[id]/prep/_components/brief-view';
import { RESEARCH_FAIL_COPY } from '@/app/(app)/jobs/[id]/prep/_components/research-fail-banner';
import {
  INTEL_FIXTURE,
  LEDGER_FIXTURE,
  LIBRARY_FIXTURE,
  REHEARSE_FIXTURE,
} from '@/app/(app)/jobs/[id]/prep/_fixtures/brief-fixtures';
import { projectNameMap } from '@/app/(app)/jobs/[id]/prep/_lib/project-names';

// PRP-04 (D8/D9/D11) — the single composition point. Acceptance item 3: the research-fail
// banner renders ALONGSIDE the rest of the brief, never instead of it.

afterEach(cleanup);

const PROJECT_NAMES = projectNameMap(LIBRARY_FIXTURE);

function renderBrief(overrides: Partial<Parameters<typeof BriefView>[0]> = {}) {
  return render(
    <BriefView
      intel={INTEL_FIXTURE}
      rehearse={REHEARSE_FIXTURE}
      ledger={LEDGER_FIXTURE}
      projectNames={PROJECT_NAMES}
      droppedCount={0}
      droppedItems={[]}
      {...overrides}
    />,
  );
}

describe('BriefView (PRP-04)', () => {
  it('[machine] acceptance item 3: when intel === null, the fail banner renders ALONGSIDE the questions, askThem and positioning', () => {
    renderBrief({ intel: null });

    // The banner is present…
    expect(screen.getByText(RESEARCH_FAIL_COPY)).toBeTruthy();
    // …AND the rest of the brief renders too, not instead of it.
    expect(screen.getByText(REHEARSE_FIXTURE.questions[0].question)).toBeTruthy();
    expect(screen.getByText(REHEARSE_FIXTURE.askThem[0])).toBeTruthy();
    expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy();
  });

  it('[machine] renders the intel snapshot and NO fail banner when intel is present', () => {
    renderBrief();
    expect(screen.getByText(INTEL_FIXTURE.snapshot)).toBeTruthy();
    expect(screen.queryByText(RESEARCH_FAIL_COPY)).toBeNull();
  });

  it('[machine] renders the seven sections in PRD-fixed order (dropped → intel → questions → positioning)', () => {
    const { container } = renderBrief({
      droppedCount: 1,
      droppedItems: [{ label: 'Dropped question', detail: 'Cites a missing project.' }],
    });
    const text = container.textContent ?? '';

    const droppedIdx = text.indexOf('1 item was dropped');
    const intelIdx = text.indexOf(INTEL_FIXTURE.snapshot);
    const questionIdx = text.indexOf(REHEARSE_FIXTURE.questions[0].question);
    const positioningIdx = text.indexOf(REHEARSE_FIXTURE.positioning);

    expect(droppedIdx).toBeGreaterThanOrEqual(0);
    expect(droppedIdx).toBeLessThan(intelIdx);
    expect(intelIdx).toBeLessThan(questionIdx);
    expect(questionIdx).toBeLessThan(positioningIdx);
  });

  it('[machine] D11: renders each gap probe/play when a ledger is present', () => {
    renderBrief();
    for (const gap of LEDGER_FIXTURE.gaps) {
      expect(screen.getByText(new RegExp(gap.probe.replace(/[.()?]/g, '\\$&')))).toBeTruthy();
      expect(screen.getByText(new RegExp(gap.play.replace(/[.()?]/g, '\\$&')))).toBeTruthy();
    }
  });

  it('[machine] D11: renders NO ledger-recap section (and no crash) when ledger === null', () => {
    renderBrief({ ledger: null });
    expect(screen.queryByText(/where this interview will be decided/i)).toBeNull();
    // The rest of the brief still renders.
    expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy();
  });

  it('[machine] renders no dropped-count header on the reload-path shape (droppedCount === 0)', () => {
    renderBrief();
    expect(screen.queryByText(/was dropped/)).toBeNull();
    expect(screen.queryByText(/were dropped/)).toBeNull();
  });
});
