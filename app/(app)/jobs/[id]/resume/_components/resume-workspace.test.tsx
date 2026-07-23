// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ResumeWorkspace, {
  REDERIVE_NOTE,
} from '@/app/(app)/jobs/[id]/resume/_components/resume-workspace';
import {
  LIBRARY_FIXTURE,
  TAILORED_FIXTURE,
} from '@/app/(app)/jobs/[id]/resume/_fixtures/tailored-fixtures';
import { projectNameMap } from '@/app/(app)/jobs/[id]/resume/_lib/project-names';

// TLR-02 integration (plan §4 "additional tests"): the stateful hub composing D1–D5, the
// editor, and export. Not an acceptance item on its own, but required for a green delivery.

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const PROJECT_NAMES = projectNameMap(LIBRARY_FIXTURE);

function renderWorkspace() {
  return render(
    <ResumeWorkspace
      jobId="job-1"
      tailored={TAILORED_FIXTURE}
      projectNames={PROJECT_NAMES}
      droppedItems={[]}
      droppedCount={0}
    />,
  );
}

const draftTextarea = () => screen.getByLabelText(/full draft \(markdown\)/i) as HTMLTextAreaElement;

describe('ResumeWorkspace — composition', () => {
  it('[machine] seeds the editor with fullDraftMd (no edits accepted initially)', () => {
    renderWorkspace();
    expect(draftTextarea().value).toBe(TAILORED_FIXTURE.fullDraftMd);
    // Every edit checkbox starts unchecked (opt-in).
    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(false);
    }
  });

  it('[machine] shows the D6 re-derive warning note', () => {
    renderWorkspace();
    expect(screen.getByText(REDERIVE_NOTE)).toBeTruthy();
  });

  it('[machine] resolves each edit project name from the library (raw id fallback for the absent one)', () => {
    renderWorkspace();
    expect(screen.getByText(/Voice Agent/)).toBeTruthy();
    expect(screen.getByText(/Billing Migration/)).toBeTruthy();
    // The third edit references a project id absent from the library → raw id shown.
    expect(screen.getByText(/ghost-project/)).toBeTruthy();
  });
});

describe('ResumeWorkspace — toggling re-derives the draft (D6)', () => {
  it('[machine] accepting an edit substitutes its original→suggested in the textarea', () => {
    renderWorkspace();
    // Edit 0: "Ran a cluster serving many calls." → "Ran a 40-node EKS cluster serving 2.1M calls/day."
    fireEvent.click(screen.getAllByRole('checkbox')[0]);

    expect(draftTextarea().value).toContain('Ran a 40-node EKS cluster serving 2.1M calls/day.');
    expect(draftTextarea().value).not.toContain('Ran a cluster serving many calls.');
    // A non-accepted edit's original stays verbatim.
    expect(draftTextarea().value).toContain('Worked on billing.');
  });

  it('[machine] un-accepting an edit restores the original (re-derives from scratch)', () => {
    renderWorkspace();
    const box = screen.getAllByRole('checkbox')[0];
    fireEvent.click(box); // accept
    fireEvent.click(box); // un-accept
    expect(draftTextarea().value).toBe(TAILORED_FIXTURE.fullDraftMd);
  });
});

describe('ResumeWorkspace — export (D1)', () => {
  it('[machine] renders exactly ONE #print-root whose content reflects the CURRENT draft', () => {
    const { container } = renderWorkspace();
    expect(container.querySelectorAll('#print-root')).toHaveLength(1);

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    const printRoot = container.querySelector('#print-root') as HTMLElement;
    // The formatted print view reflects the edited draft, not the original.
    expect(printRoot.textContent).toContain('Ran a 40-node EKS cluster serving 2.1M calls/day.');
  });

  it('[machine] "Print / Save as PDF" calls window.print()', () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /print \/ save as pdf/i }));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('[machine] links to the standalone clean print view', () => {
    renderWorkspace();
    const link = screen.getByRole('link', { name: /clean print view of the generated draft/i });
    expect(link.getAttribute('href')).toBe('/jobs/job-1/resume/print');
  });
});

describe('ResumeWorkspace — the gap has no action inside the composed tree', () => {
  it('[machine] missing_in_library exposes no button/checkbox/link (绝不写入简历)', () => {
    const { container } = renderWorkspace();
    const gapRow = container.querySelector('[data-status="missing_in_library"]') as HTMLElement;
    expect(gapRow).not.toBeNull();
    const scoped = within(gapRow);
    expect(scoped.queryByRole('button')).toBeNull();
    expect(scoped.queryByRole('checkbox')).toBeNull();
    expect(scoped.queryByRole('link')).toBeNull();
  });
});
