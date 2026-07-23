// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import DroppedCountHeader, {
  PARTIAL_DROPPED_NOTE,
  type DroppedItem,
} from '@/app/(app)/jobs/[id]/_components/dropped-count-header';

// HONESTY NOTE: rendering and copy only. Whether the pipeline dropped the RIGHT
// things is FND-07's and `pnpm eval`'s concern.

afterEach(cleanup);

const ITEMS: DroppedItem[] = [
  { label: 'Production Kubernetes at scale', detail: 'Evidence from "ghost-project" was discarded' },
  { label: 'gRPC service design', detail: 'The analysis did not cover this requirement' },
  { label: 'Terraform', detail: 'The analysis did not cover this requirement' },
];

describe('DroppedCountHeader (FIT-03 acceptance item 5; PRD §5.7 "dropped > 0 表头计数")', () => {
  it('[machine] renders NOTHING AT ALL when droppedCount === 0', () => {
    // Asserting the WHOLE container is empty, not merely the absence of one string:
    // an empty wrapper or a stray <details> would still be a rendering defect on the
    // overwhelmingly common healthy path.
    const { container } = render(<DroppedCountHeader droppedCount={0} items={[]} />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('details')).toBeNull();
  });

  it('[machine] renders nothing at 0 even if items were passed anyway', () => {
    const { container } = render(<DroppedCountHeader droppedCount={0} items={ITEMS} />);
    expect(container.textContent).toBe('');
  });

  it('[machine] renders the count and an EXPANDABLE list when > 0', () => {
    const { container } = render(<DroppedCountHeader droppedCount={3} items={ITEMS} />);

    expect(screen.getByText('3 items were dropped')).toBeTruthy();

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    // E9: assert `open`, NOT visibility. jsdom applies no UA stylesheet, so Testing
    // Library still RETURNS content inside a closed <details> — an "is not visible"
    // assertion here would pass for the wrong reason.
    expect((details as HTMLDetailsElement).open).toBe(false);

    fireEvent.click(screen.getByText(/show the dropped entries/i));
    expect((details as HTMLDetailsElement).open).toBe(true);

    for (const item of ITEMS) {
      expect(screen.getByText(item.label)).toBeTruthy();
    }
  });

  it('[machine] uses SINGULAR wording for exactly one dropped item', () => {
    render(<DroppedCountHeader droppedCount={1} items={[ITEMS[0]]} />);
    expect(screen.getByText('1 item was dropped')).toBeTruthy();
    expect(screen.queryByText(/items were dropped/)).toBeNull();
  });

  it('[machine] D8: partial === true renders the "only available on that run" note', () => {
    render(<DroppedCountHeader droppedCount={1} items={[ITEMS[1]]} partial />);
    expect(screen.getByText(PARTIAL_DROPPED_NOTE)).toBeTruthy();
  });

  it('[machine] D8: partial defaults to false and the note is then absent', () => {
    render(<DroppedCountHeader droppedCount={2} items={ITEMS.slice(0, 2)} />);
    expect(screen.queryByText(PARTIAL_DROPPED_NOTE)).toBeNull();
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
  });
});
