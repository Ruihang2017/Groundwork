// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import DroppedCountHeader, {
  type DroppedItem,
} from '@/app/(app)/jobs/[id]/prep/_components/dropped-count-header';

// PRP-04 Deliverable 6 (D7) — this module's OWN copy: nothing at 0; count + expandable list at
// > 0. Same pattern as 05-tailor/TLR-02's copy, WITHOUT the `partial` flag.

afterEach(cleanup);

const ITEMS: DroppedItem[] = [
  { label: 'Tell me about the ghost project.', detail: 'Cites "ghost-project", which isn\'t in your library (projectId not in library).' },
  { label: 'nonsense-id', detail: 'Cites "nonsense-id", which isn\'t in your library (dropped).' },
];

describe('DroppedCountHeader (PRP-04 Deliverable 6)', () => {
  it('[machine] renders NOTHING AT ALL when droppedCount === 0', () => {
    const { container } = render(<DroppedCountHeader droppedCount={0} items={[]} />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('details')).toBeNull();
  });

  it('[machine] renders nothing at 0 even if items were passed anyway', () => {
    const { container } = render(<DroppedCountHeader droppedCount={0} items={ITEMS} />);
    expect(container.textContent).toBe('');
  });

  it('[machine] renders the count and an EXPANDABLE list when > 0', () => {
    const { container } = render(<DroppedCountHeader droppedCount={2} items={ITEMS} />);
    expect(screen.getByText('2 items were dropped')).toBeTruthy();

    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    // E9: assert `open`, not visibility — jsdom returns content inside a closed <details>.
    expect(details.open).toBe(false);

    fireEvent.click(screen.getByText(/show the dropped entries/i));
    expect(details.open).toBe(true);

    expect(screen.getByText('Tell me about the ghost project.')).toBeTruthy();
    expect(screen.getByText('nonsense-id')).toBeTruthy();
  });

  it('[machine] uses SINGULAR wording for exactly one dropped item', () => {
    render(<DroppedCountHeader droppedCount={1} items={[ITEMS[0]]} />);
    expect(screen.getByText('1 item was dropped')).toBeTruthy();
    expect(screen.queryByText(/items were dropped/)).toBeNull();
  });

  it('[machine] renders item text as TEXT — model-derived content is never HTML', () => {
    render(
      <DroppedCountHeader
        droppedCount={1}
        items={[{ label: '<script>x</script>', detail: '<img src=x onerror="alert(1)">' }]}
      />,
    );
    expect(screen.getByText('<script>x</script>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});
