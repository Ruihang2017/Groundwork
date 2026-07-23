// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import QuestionList from '@/app/(app)/jobs/[id]/prep/_components/question-list';
import {
  LIBRARY_FIXTURE,
  REHEARSE_FIXTURE,
} from '@/app/(app)/jobs/[id]/prep/_fixtures/brief-fixtures';
import { projectNameMap } from '@/app/(app)/jobs/[id]/prep/_lib/project-names';

// PRP-04 Deliverable 3 / acceptance item 4 (D10) — the 5 questions GROUPED by projectId
// ("angle"), one header per distinct project, raw-id fallback for an unknown id.

afterEach(cleanup);

describe('QuestionList (PRP-04 acceptance item 4)', () => {
  it('[machine] groups 5 questions spanning 3 projects under exactly 3 project headers, with all questions + traps', () => {
    const projectNames = projectNameMap(LIBRARY_FIXTURE);
    render(<QuestionList questions={REHEARSE_FIXTURE.questions} projectNames={projectNames} />);

    const groupHeaders = screen.getAllByRole('heading', { level: 3 });
    expect(groupHeaders).toHaveLength(3);
    const headerText = groupHeaders.map((h) => h.textContent);
    expect(headerText).toEqual(['Voice Agent', 'Billing Migration', 'Search Ranking']);

    for (const q of REHEARSE_FIXTURE.questions) {
      expect(screen.getByText(q.question)).toBeTruthy();
      expect(screen.getByText(new RegExp(q.trap.replace(/[.()?]/g, '\\$&')))).toBeTruthy();
    }
  });

  it('[machine] falls back to the raw projectId for an id absent from the map', () => {
    render(
      <QuestionList
        questions={[{ projectId: 'ghost-project', question: 'A ghost question', trap: 'A ghost trap' }]}
        projectNames={{}}
      />,
    );
    const groupHeaders = screen.getAllByRole('heading', { level: 3 });
    expect(groupHeaders).toHaveLength(1);
    expect(groupHeaders[0].textContent).toBe('ghost-project');
  });

  it('[machine] renders a neutral line and no crash for an empty question set', () => {
    render(<QuestionList questions={[]} projectNames={{}} />);
    expect(screen.getByText(/no rehearsal questions were generated/i)).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });
});
