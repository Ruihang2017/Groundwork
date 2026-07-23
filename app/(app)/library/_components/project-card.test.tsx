// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProjectCard from '@/app/(app)/library/_components/project-card';
import { THREE_PROJECT_FIXTURE } from '@/app/(app)/library/_fixtures/library-fixtures';
import type { Project } from '@/lib/schemas/entities';

afterEach(cleanup);

const withMetrics = THREE_PROJECT_FIXTURE.projects.find((p) => p.metrics.length > 0);
const withoutMetrics = THREE_PROJECT_FIXTURE.projects.find((p) => p.metrics.length === 0);
if (!withMetrics || !withoutMetrics) {
  throw new Error('fixture must contain both a metrics-bearing and a metrics-less project');
}

// Acceptance item 3: "project-card.tsx renders its per-card warning exactly on
// cards whose metrics.length === 0, verified against a mixed-metrics fixture
// library" — PRD §5.7's 卡片级警告, PRD §2 P2's literal "no metrics" wording.

describe('ProjectCard (LIB-03 Deliverable 4, PRD §5.7 卡片级警告)', () => {
  it('[machine] a project WITH metrics shows them and carries no warning', () => {
    render(<ProjectCard project={withMetrics} />);
    expect(screen.queryByText(/no metrics/i)).toBeNull();
    for (const metric of withMetrics.metrics) {
      expect(screen.getByText(metric)).toBeTruthy();
    }
  });

  it('[machine] a project with metrics: [] carries the per-card warning', () => {
    render(<ProjectCard project={withoutMetrics} />);
    expect(screen.getByText(/no metrics/i)).toBeTruthy();
  });

  it('[machine] the warning is rendered on EXACTLY the metrics-less subset', () => {
    // Expected set is derived from the fixture, never hardcoded — a test that
    // named the projects would keep passing if the rule inverted.
    render(
      <div>
        {THREE_PROJECT_FIXTURE.projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>,
    );

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(THREE_PROJECT_FIXTURE.projects.length);

    THREE_PROJECT_FIXTURE.projects.forEach((project, index) => {
      const warning = within(cards[index]).queryByText(/no metrics/i);
      expect(Boolean(warning)).toBe(project.metrics.length === 0);
    });
  });

  it('[machine] one non-empty metric is enough to suppress the warning (plan §4 E1)', () => {
    const project: Project = { ...withoutMetrics, metrics: ['99.95% uptime over 6 months'] };
    render(<ProjectCard project={project} />);
    expect(screen.queryByText(/no metrics/i)).toBeNull();
  });

  it('a project with an empty name is still an addressable card', () => {
    // FND-02 puts `.min(1)` on nothing, so '' is schema-valid. Without a fallback
    // the card's accessible name would be empty and unaddressable.
    const project: Project = { ...withoutMetrics, name: '' };
    render(<ProjectCard project={project} />);
    expect(screen.getByRole('article', { name: /untitled project/i })).toBeTruthy();
  });

  it('renders role, stage and stack as plain text', () => {
    render(<ProjectCard project={withMetrics} />);
    expect(screen.getByText(new RegExp(withMetrics.role, 'i'))).toBeTruthy();
    expect(screen.getByText(new RegExp(withMetrics.stack[0], 'i'))).toBeTruthy();
  });

  it('wires Edit and Remove only when handlers are supplied, and honours `disabled`', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();

    const { rerender } = render(<ProjectCard project={withMetrics} />);
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();

    rerender(<ProjectCard project={withMetrics} onEdit={onEdit} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);

    rerender(
      <ProjectCard project={withMetrics} onEdit={onEdit} onRemove={onRemove} disabled />,
    );
    expect((screen.getByRole('button', { name: /edit/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
