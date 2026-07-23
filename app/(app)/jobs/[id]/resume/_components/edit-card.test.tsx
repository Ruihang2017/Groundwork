// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import EditCard from '@/app/(app)/jobs/[id]/resume/_components/edit-card';
import type { Edit } from '@/lib/schemas/pipeline';

// TLR-02 acceptance item 2 — edit-card defaults to NOT accepted (PRD "用户逐条采纳" = opt-in),
// and toggling calls the parent callback with (index, checked).

afterEach(cleanup);

const EDIT: Edit = {
  original: 'Worked on billing.',
  suggested: 'Migrated a card-billing ledger with zero downtime.',
  rationale: 'Name the concrete outcome.',
  projectId: 'billing-migration',
};

const checkbox = () => screen.getByRole('checkbox', { name: /adopt this edit/i });

describe('EditCard (TLR-02 acceptance item 2)', () => {
  it('[machine] renders original, suggested, rationale and the resolved project name', () => {
    render(
      <EditCard edit={EDIT} index={0} accepted={false} projectName="Billing Migration" onToggle={() => {}} />,
    );
    expect(screen.getByText(/Worked on billing\./)).toBeTruthy();
    expect(screen.getByText(/Migrated a card-billing ledger with zero downtime\./)).toBeTruthy();
    expect(screen.getByText(/Name the concrete outcome\./)).toBeTruthy();
    expect(screen.getByText(/Billing Migration/)).toBeTruthy();
  });

  it('[machine] the checkbox is UNCHECKED when accepted={false} (opt-in default)', () => {
    render(
      <EditCard edit={EDIT} index={0} accepted={false} projectName="Billing Migration" onToggle={() => {}} />,
    );
    expect((checkbox() as HTMLInputElement).checked).toBe(false);
  });

  it('[machine] the checkbox is CHECKED when accepted={true}', () => {
    render(
      <EditCard edit={EDIT} index={2} accepted projectName="Billing Migration" onToggle={() => {}} />,
    );
    expect((checkbox() as HTMLInputElement).checked).toBe(true);
  });

  it('[machine] toggling calls onToggle exactly once with (index, true)', () => {
    const onToggle = vi.fn();
    render(
      <EditCard edit={EDIT} index={3} accepted={false} projectName="Billing Migration" onToggle={onToggle} />,
    );
    fireEvent.click(checkbox());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(3, true);
  });

  it('[machine] un-toggling an accepted edit calls onToggle with (index, false)', () => {
    const onToggle = vi.fn();
    render(
      <EditCard edit={EDIT} index={1} accepted projectName="Billing Migration" onToggle={onToggle} />,
    );
    fireEvent.click(checkbox());
    expect(onToggle).toHaveBeenCalledWith(1, false);
  });

  it('[machine] falls back to the raw projectId string when that is what the parent passes', () => {
    render(
      <EditCard edit={EDIT} index={0} accepted={false} projectName="ghost-project" onToggle={() => {}} />,
    );
    expect(screen.getByText(/ghost-project/)).toBeTruthy();
  });
});
