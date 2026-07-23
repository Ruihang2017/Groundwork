// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LibraryWorkspace from '@/app/(app)/library/_components/library-workspace';
import {
  DRAFT_LIBRARY_FIXTURE,
  RESUME_MD_FIXTURE,
  THREE_PROJECT_FIXTURE,
} from '@/app/(app)/library/_fixtures/library-fixtures';
import type { Library } from '@/lib/schemas/entities';

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

/** LIB-02's route echoes exactly what it persisted. */
function echoingSave() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const sent = JSON.parse(init.body as string);
    return jsonRes(200, { library: sent.library, resumeMd: sent.resumeMd });
  });
}

const bodyOf = (call: unknown[]): { library: Library; resumeMd: string } =>
  JSON.parse((call[1] as RequestInit).body as string);

const libraryCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => call[0] === '/api/library');

const cardNamed = (name: string | RegExp) => screen.getByRole('article', { name });

describe('LibraryWorkspace — branch selection', () => {
  it('[machine] with no library, renders the import entry point and no cards', () => {
    render(<LibraryWorkspace initialLibrary={null} initialResumeMd={null} />);
    expect(screen.getByLabelText(/resume file/i)).toBeTruthy();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('[machine] with a library, renders the confirmed page and NO upload form', () => {
    render(
      <LibraryWorkspace initialLibrary={DRAFT_LIBRARY_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );
    expect(screen.queryByLabelText(/resume file/i)).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(
      DRAFT_LIBRARY_FIXTURE.projects.length,
    );
    // No re-import affordance exists by design (ticket Feedback obligation #3).
    expect(screen.queryByRole('button', { name: /import resume/i })).toBeNull();
  });
});

describe('LibraryWorkspace — the full import → confirm → library path', () => {
  it('[machine] upload → PARSE 200 → draft cards → confirm → confirmed Library page', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === '/api/parse') {
        return jsonRes(200, {
          resumeMd: RESUME_MD_FIXTURE,
          draftLibrary: DRAFT_LIBRARY_FIXTURE,
        });
      }
      const sent = JSON.parse(init.body as string);
      return jsonRes(200, { library: sent.library, resumeMd: sent.resumeMd });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LibraryWorkspace initialLibrary={null} initialResumeMd={null} />);

    const file = new File([new Uint8Array([1, 2, 3])], 'resume.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(screen.getByLabelText(/resume file/i), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /import resume/i }));

    // Draft confirm step.
    const confirm = await screen.findByRole('button', { name: /confirm and save/i });
    expect(screen.getAllByRole('article')).toHaveLength(
      DRAFT_LIBRARY_FIXTURE.projects.length,
    );
    fireEvent.click(confirm);

    // Confirmed Library page.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /confirm and save/i })).toBeNull(),
    );
    expect(screen.queryByLabelText(/resume file/i)).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(
      DRAFT_LIBRARY_FIXTURE.projects.length,
    );
    // The banner survived the transition (the fixture has one metrics-less project).
    expect(screen.getByText(/1 of 2 projects has no metrics/i)).toBeTruthy();

    // …and the save carried the resumeMd PARSE returned, unmodified.
    const save = libraryCalls(fetchMock)[0];
    expect(bodyOf(save).resumeMd).toBe(RESUME_MD_FIXTURE);
  });
});

describe('LibraryWorkspace — ongoing edit/remove/add (PRD §5 S5 复利)', () => {
  it('[machine] editing a project posts the FULL library plus the unchanged resumeMd', async () => {
    const fetchMock = echoingSave();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LibraryWorkspace initialLibrary={DRAFT_LIBRARY_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );

    fireEvent.click(within(cardNamed(/trailmark/i)).getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/summary/i), {
      target: { value: 'Rewrote the summary by hand.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(libraryCalls(fetchMock)).toHaveLength(1));
    const body = bodyOf(libraryCalls(fetchMock)[0]);
    expect(body.library.projects).toHaveLength(DRAFT_LIBRARY_FIXTURE.projects.length);
    expect(body.library.projects[0].summary).toBe('Rewrote the summary by hand.');
    expect(body.library.projects[1]).toEqual(DRAFT_LIBRARY_FIXTURE.projects[1]);
    expect(body.resumeMd).toBe(RESUME_MD_FIXTURE);

    // Back to read-only, showing the saved value.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull(),
    );
    expect(screen.getByText('Rewrote the summary by hand.')).toBeTruthy();
  });

  it('[machine] removing a project posts a library omitting exactly that project', async () => {
    const fetchMock = echoingSave();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LibraryWorkspace initialLibrary={THREE_PROJECT_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );
    fireEvent.click(within(cardNamed(/pantry/i)).getByRole('button', { name: /remove/i }));

    await waitFor(() => expect(libraryCalls(fetchMock)).toHaveLength(1));
    const { library } = bodyOf(libraryCalls(fetchMock)[0]);
    expect(library.projects.map((p) => p.id)).toEqual(
      THREE_PROJECT_FIXTURE.projects.filter((p) => p.id !== 'pantry').map((p) => p.id),
    );
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
  });

  it('[machine] removing the LAST project leaves the empty state, no banner, add affordance', async () => {
    const fetchMock = echoingSave();
    vi.stubGlobal('fetch', fetchMock);
    const oneProject: Library = {
      profile: DRAFT_LIBRARY_FIXTURE.profile,
      projects: [DRAFT_LIBRARY_FIXTURE.projects[1]], // the metrics-less one
    };

    render(<LibraryWorkspace initialLibrary={oneProject} initialResumeMd={RESUME_MD_FIXTURE} />);
    expect(screen.getByText(/1 of 1 project has no metrics/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(0));
    expect(screen.getByText(/your library has no projects yet/i)).toBeTruthy();
    // PRD §5.7's 无库时禁止新建 job — hasLibrary() is false for an empty projects array.
    expect(screen.getByText(/cannot create a job/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /add a project/i })).toBeTruthy();
  });

  it('[machine] "Add a project" opens an editor and only persists on Save', async () => {
    const fetchMock = echoingSave();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LibraryWorkspace initialLibrary={DRAFT_LIBRARY_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add a project/i }));

    // Nothing posted yet.
    expect(libraryCalls(fetchMock)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Voice Agent' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(libraryCalls(fetchMock)).toHaveLength(1));
    const { library } = bodyOf(libraryCalls(fetchMock)[0]);
    expect(library.projects).toHaveLength(DRAFT_LIBRARY_FIXTURE.projects.length + 1);
    expect(library.projects[library.projects.length - 1].name).toBe('Voice Agent');
    expect(library.projects[library.projects.length - 1].metrics).toEqual([]);
  });

  it('cancelling a newly added project drops it and posts nothing', () => {
    const fetchMock = echoingSave();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LibraryWorkspace initialLibrary={DRAFT_LIBRARY_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add a project/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.getAllByRole('article')).toHaveLength(
      DRAFT_LIBRARY_FIXTURE.projects.length,
    );
    expect(libraryCalls(fetchMock)).toHaveLength(0);
  });

  it('cancelling an edit restores the pre-edit value without posting', () => {
    const fetchMock = echoingSave();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LibraryWorkspace initialLibrary={DRAFT_LIBRARY_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );
    fireEvent.click(within(cardNamed(/trailmark/i)).getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Scrapped' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByText('Scrapped')).toBeNull();
    expect(cardNamed(/trailmark/i)).toBeTruthy();
    expect(libraryCalls(fetchMock)).toHaveLength(0);
  });
});

describe('LibraryWorkspace — failure and edge behaviour', () => {
  it('[machine] a failed save shows the error and leaves the edit on screen (no rollback)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes(500, { error: 'library_write_failed' })),
    );

    render(
      <LibraryWorkspace initialLibrary={DRAFT_LIBRARY_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );
    fireEvent.click(within(cardNamed(/trailmark/i)).getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Unsaved but kept' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await screen.findByText(/your library was not changed/i);
    // Still in the editor, still holding the user's text.
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe(
      'Unsaved but kept',
    );
  });

  it('[machine] a null resumeMd alongside a library saves as "" — never null/undefined', async () => {
    const fetchMock = echoingSave();
    vi.stubGlobal('fetch', fetchMock);

    render(<LibraryWorkspace initialLibrary={DRAFT_LIBRARY_FIXTURE} initialResumeMd={null} />);
    fireEvent.click(within(cardNamed(/pantry/i)).getByRole('button', { name: /remove/i }));

    await waitFor(() => expect(libraryCalls(fetchMock)).toHaveLength(1));
    const body = bodyOf(libraryCalls(fetchMock)[0]);
    expect(body.resumeMd).toBe('');
    expect(Object.keys(body).sort()).toEqual(['library', 'resumeMd']);
  });

  it('[machine] the per-card warning appears on EXACTLY the metrics-less subset', () => {
    render(
      <LibraryWorkspace initialLibrary={THREE_PROJECT_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(THREE_PROJECT_FIXTURE.projects.length);
    // Expected set derived from the fixture, not hardcoded.
    THREE_PROJECT_FIXTURE.projects.forEach((project, index) => {
      const warning = within(cards[index]).queryByText(/no metrics/i);
      expect(Boolean(warning)).toBe(project.metrics.length === 0);
    });
    // And BOTH §5.7 elements are present at once — banner AND card warnings.
    expect(screen.getByText(/2 of 3 projects have no metrics/i)).toBeTruthy();
  });

  it('[machine] mutating controls are disabled while a save is in flight', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LibraryWorkspace initialLibrary={THREE_PROJECT_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );
    fireEvent.click(within(cardNamed(/pantry/i)).getByRole('button', { name: /remove/i }));

    expect(screen.getByRole('status').textContent).toMatch(/saving/i);
    expect(
      (screen.getByRole('button', { name: /add a project/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    for (const button of screen.getAllByRole('button', { name: /remove/i })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    // A second remove during the first is impossible, so exactly one call.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonRes(500, { error: 'library_write_failed' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('never logs library content or resumeMd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = echoingSave();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LibraryWorkspace initialLibrary={DRAFT_LIBRARY_FIXTURE} initialResumeMd={RESUME_MD_FIXTURE} />,
    );
    fireEvent.click(within(cardNamed(/pantry/i)).getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(libraryCalls(fetchMock)).toHaveLength(1));

    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('[machine] persists nothing to browser storage (PRD §8.1)', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/parse'
        ? jsonRes(200, { resumeMd: RESUME_MD_FIXTURE, draftLibrary: DRAFT_LIBRARY_FIXTURE })
        : jsonRes(200, { library: DRAFT_LIBRARY_FIXTURE, resumeMd: RESUME_MD_FIXTURE }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<LibraryWorkspace initialLibrary={null} initialResumeMd={null} />);
    fireEvent.change(screen.getByLabelText(/resume file/i), {
      target: { files: [new File([new Uint8Array([1])], 'r.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: /import resume/i }));
    await screen.findByRole('button', { name: /confirm and save/i });

    // A draft cached in localStorage would make the live /privacy page false.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});
