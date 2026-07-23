// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DraftConfirm from '@/app/(app)/library/_components/draft-confirm';
import {
  DRAFT_LIBRARY_FIXTURE,
  RESUME_MD_FIXTURE,
  THREE_PROJECT_FIXTURE,
} from '@/app/(app)/library/_fixtures/library-fixtures';
import { PROJECT_ID_PATTERN, type Library } from '@/lib/schemas/entities';

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Echo back exactly what was posted, the way LIB-02's route does. */
function echoingFetch() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const sent = JSON.parse(init.body as string);
    return jsonRes(200, { library: sent.library, resumeMd: sent.resumeMd });
  });
}

const bodyOf = (call: unknown[]): { library: Library; resumeMd: string } =>
  JSON.parse((call[1] as RequestInit).body as string);

const confirmButton = () => screen.getByRole('button', { name: /confirm and save/i });
const cards = () => screen.getAllByRole('article');
const nameInput = (card: HTMLElement) => within(card).getByLabelText(/^name$/i);

// Acceptance item 1: "draft-confirm.tsx renders one editable card per project in a
// mocked draftLibrary response, and the 'Confirm and save' action submits the
// (possibly user-edited) library object PLUS the unmodified resumeMd".

describe('DraftConfirm (LIB-03 Deliverable 2, PRD §4 S1 逐条确认/微调)', () => {
  it('[machine] renders exactly one editable card per project in the draft', () => {
    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={vi.fn()}
      />,
    );

    const rendered = cards();
    expect(rendered).toHaveLength(DRAFT_LIBRARY_FIXTURE.projects.length);
    DRAFT_LIBRARY_FIXTURE.projects.forEach((project, index) => {
      expect((nameInput(rendered[index]) as HTMLInputElement).value).toBe(project.name);
    });
  });

  it('[machine] submits the EDITED library plus the byte-for-byte unchanged resumeMd', async () => {
    const fetchMock = echoingFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.change(nameInput(cards()[0]), { target: { value: 'Trailmark (renamed)' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/library');
    expect(init.method).toBe('POST');

    const body = bodyOf(fetchMock.mock.calls[0] as unknown[]);
    // The user's edit is carried…
    expect(body.library.projects[0].name).toBe('Trailmark (renamed)');
    // …the untouched project is untouched…
    expect(body.library.projects[1]).toEqual(DRAFT_LIBRARY_FIXTURE.projects[1]);
    expect(body.library.profile).toEqual(DRAFT_LIBRARY_FIXTURE.profile);
    // …and resumeMd is IDENTICAL to the PARSE response. Strict toBe, byte for
    // byte — this is the ticket's centrepiece assertion.
    expect(body.resumeMd).toBe(RESUME_MD_FIXTURE);
  });

  it('[machine] a 200 hands the echoed library and resumeMd to onSaved', async () => {
    vi.stubGlobal('fetch', echoingFetch());
    const onSaved = vi.fn();

    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [library, resumeMd] = onSaved.mock.calls[0] as [Library, string];
    expect(library).toEqual(DRAFT_LIBRARY_FIXTURE);
    expect(resumeMd).toBe(RESUME_MD_FIXTURE);
  });

  it('[machine] a 400 shows the issue paths, does not call onSaved, and KEEPS the edits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes(400, {
          error: 'invalid_body',
          issues: ['library.projects.0.id: Project.id must be kebab-case'],
        }),
      ),
    );
    const onSaved = vi.fn();

    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(nameInput(cards()[0]), { target: { value: 'Kept edit' } });
    fireEvent.click(confirmButton());

    // Scoped by text, not by role: the empty-metrics banner is also role="alert"
    // (correctly — it IS an alert), so `getByRole('alert')` is ambiguous here.
    await screen.findByText(/library\.projects\.0\.id/);
    expect(onSaved).not.toHaveBeenCalled();
    // Losing the user's work on a failed save is the exact friction the ticket's
    // Feedback obligation #1 forbids papering over.
    expect((nameInput(cards()[0]) as HTMLInputElement).value).toBe('Kept edit');
  });

  it('[machine] "Add a project" appends a schema-valid, unique-id, metrics-less card', async () => {
    const fetchMock = echoingFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add a project/i }));

    expect(cards()).toHaveLength(DRAFT_LIBRARY_FIXTURE.projects.length + 1);

    fireEvent.click(confirmButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const { library } = bodyOf(fetchMock.mock.calls[0] as unknown[]);
    const added = library.projects[library.projects.length - 1];
    expect(added.id).toMatch(PROJECT_ID_PATTERN);
    expect(library.projects.filter((p) => p.id === added.id)).toHaveLength(1);
    expect(added.metrics).toEqual([]);
  });

  it('[machine] removing the MIDDLE card leaves the others with their own values', async () => {
    // The array-index-key bug: React reuses the DOM node and the surviving rows
    // inherit the removed row's input state (plan §4 E3).
    const fetchMock = echoingFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <DraftConfirm
        draftLibrary={THREE_PROJECT_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={vi.fn()}
      />,
    );
    expect(cards()).toHaveLength(3);

    fireEvent.click(within(cards()[1]).getByRole('button', { name: /remove/i }));

    const remaining = cards();
    expect(remaining).toHaveLength(2);
    expect((nameInput(remaining[0]) as HTMLInputElement).value).toBe(
      THREE_PROJECT_FIXTURE.projects[0].name,
    );
    expect((nameInput(remaining[1]) as HTMLInputElement).value).toBe(
      THREE_PROJECT_FIXTURE.projects[2].name,
    );

    fireEvent.click(confirmButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { library } = bodyOf(fetchMock.mock.calls[0] as unknown[]);
    expect(library.projects.map((p) => p.id)).toEqual([
      THREE_PROJECT_FIXTURE.projects[0].id,
      THREE_PROJECT_FIXTURE.projects[2].id,
    ]);
  });

  it('[machine] emptying the Metrics box submits [] — never [""] (plan §4 E1)', async () => {
    const fetchMock = echoingFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={vi.fn()}
      />,
    );

    const metrics = within(cards()[0]).getByLabelText(/metrics/i);
    expect((metrics as HTMLTextAreaElement).value).toContain('92% test coverage');
    fireEvent.change(metrics, { target: { value: '' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { library } = bodyOf(fetchMock.mock.calls[0] as unknown[]);
    expect(library.projects[0].metrics).toEqual([]);
    expect(library.projects[0].metrics).toHaveLength(0);
  });

  it('[machine] emptying a project\'s metrics immediately raises the banner tally', () => {
    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={vi.fn()}
      />,
    );
    // 1 of 2 to start (the fixture's pantry project has none).
    expect(screen.getByRole('alert').textContent).toContain('1 of 2');

    fireEvent.change(within(cards()[0]).getByLabelText(/metrics/i), { target: { value: '' } });
    expect(screen.getByRole('alert').textContent).toContain('2 of 2');
  });

  it('[machine] typed metrics are split per LINE, keeping commas inside a number', async () => {
    const fetchMock = echoingFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(within(cards()[1]).getByLabelText(/metrics/i), {
      target: { value: 'cut p95 from 1,200ms to 380ms\n\n  99.9% uptime  \n' },
    });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { library } = bodyOf(fetchMock.mock.calls[0] as unknown[]);
    expect(library.projects[1].metrics).toEqual([
      'cut p95 from 1,200ms to 380ms',
      '99.9% uptime',
    ]);
  });

  it('[machine] double-clicking "Confirm and save" issues exactly ONE fetch', async () => {
    // `libraries.userId` has NO UNIQUE constraint (LIB-02) — two concurrent
    // confirms are a duplicate-ROW risk, not merely a duplicate write.
    let resolveFetch: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);

    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);

    resolveFetch(
      jsonRes(200, { library: DRAFT_LIBRARY_FIXTURE, resumeMd: RESUME_MD_FIXTURE }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('[machine] an empty draft renders zero cards and can still be confirmed', async () => {
    // LIB-01: an empty `draftLibrary.projects` is a legal PARSE SUCCESS, not a
    // failure — it must not block confirmation (plan §4 E9).
    const fetchMock = echoingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const emptyDraft: Library = { profile: DRAFT_LIBRARY_FIXTURE.profile, projects: [] };

    render(
      <DraftConfirm draftLibrary={emptyDraft} resumeMd={RESUME_MD_FIXTURE} onSaved={vi.fn()} />,
    );

    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /add a project/i })).toBeTruthy();
    // No banner: nothing to tally.
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { library, resumeMd } = bodyOf(fetchMock.mock.calls[0] as unknown[]);
    expect(library.projects).toEqual([]);
    expect(resumeMd).toBe(RESUME_MD_FIXTURE);
  });

  it('[machine] never renders resumeMd anywhere on screen', () => {
    const { container } = render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={vi.fn()}
      />,
    );
    // v1 has no PRD-named action that edits it; putting it in a form field would
    // also normalise \r\n and break the byte-for-byte invariant.
    expect(container.textContent).not.toContain('Immersive Software Engineering Bootcamp');
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
  });

  it('a network failure shows an inline error and keeps every edit on screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const onSaved = vi.fn();

    render(
      <DraftConfirm
        draftLibrary={DRAFT_LIBRARY_FIXTURE}
        resumeMd={RESUME_MD_FIXTURE}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(nameInput(cards()[0]), { target: { value: 'Still here' } });
    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(screen.getByText(/your library was not changed/i)).toBeTruthy(),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect((nameInput(cards()[0]) as HTMLInputElement).value).toBe('Still here');
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
  });
});
