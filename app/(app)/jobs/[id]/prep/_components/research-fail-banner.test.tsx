// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import ResearchFailBanner, {
  RESEARCH_FAIL_COPY,
} from '@/app/(app)/jobs/[id]/prep/_components/research-fail-banner';
import { INTEL_FIXTURE } from '@/app/(app)/jobs/[id]/prep/_fixtures/brief-fixtures';

// PRP-04 Deliverable 1 (D9) — the "research fail 标红" banner self-guards: shown ONLY when
// intel === null, and returns null otherwise (the intel card owns the non-null case).

afterEach(cleanup);

describe('ResearchFailBanner (PRP-04 Deliverable 1)', () => {
  it('[machine] renders the exported copy when intel === null', () => {
    render(<ResearchFailBanner intel={null} />);
    expect(screen.getByText(RESEARCH_FAIL_COPY)).toBeTruthy();
  });

  it('[machine] renders NOTHING when intel is present', () => {
    const { container } = render(<ResearchFailBanner intel={INTEL_FIXTURE} />);
    expect(container.textContent).toBe('');
  });
});
