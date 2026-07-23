// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import UploadForm from '@/app/(app)/library/_components/upload-form';
import {
  DRAFT_LIBRARY_FIXTURE,
  RESUME_MD_FIXTURE,
} from '@/app/(app)/library/_fixtures/library-fixtures';

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

const okBody = { resumeMd: RESUME_MD_FIXTURE, draftLibrary: DRAFT_LIBRARY_FIXTURE };

const submit = () => screen.getByRole('button', { name: /import resume/i });
const fileInput = () => screen.getByLabelText(/resume file/i) as HTMLInputElement;

function selectFile(bytes = 3, name = 'resume.pdf') {
  const file = new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
  // `fireEvent.change` with `target.files` reaches the React onChange handler and
  // e.target.files[0] is the real File (@testing-library/dom defines `files` on the
  // node). Note this does NOT make the file visible to `new FormData(form)` —
  // which is exactly why _lib/api.ts builds the multipart body by hand.
  fireEvent.change(fileInput(), { target: { files: [file] } });
  return file;
}

// Acceptance item 4: "Submitting the plain-text-paste fallback after a mocked
// suggestPaste: true response from /api/parse shows the paste UI (not a generic
// error page)" — PRD §5.1's 解析失败 → 引导粘贴纯文本.

describe('UploadForm (LIB-03 Deliverable 1)', () => {
  it('[machine] a 422 with suggestPaste:true switches to the paste UI, not an error page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes(422, { error: 'parse_failed', suggestPaste: true })),
    );

    render(<UploadForm onParsed={vi.fn()} />);
    selectFile();
    fireEvent.click(submit());

    // The paste UI is now on screen…
    const textarea = await screen.findByLabelText(/resume text/i);
    expect(textarea).toBeTruthy();
    // …with guidance that names pasting…
    expect(screen.getByText(/paste the plain text of your resume/i)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/paste the text instead/i);
    // …and the form is still usable (this is a fallback, not a dead end).
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByLabelText(/resume file/i)).toBeNull();
  });

  it('[machine] the paste fallback then submits JSON { text } and reports success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(422, { error: 'parse_failed', suggestPaste: true }))
      .mockResolvedValueOnce(jsonRes(200, okBody));
    vi.stubGlobal('fetch', fetchMock);
    const onParsed = vi.fn();

    render(<UploadForm onParsed={onParsed} />);
    selectFile();
    fireEvent.click(submit());

    const textarea = await screen.findByLabelText(/resume text/i);
    fireEvent.change(textarea, { target: { value: 'Jordan Avery\nJunior Software Engineer' } });
    fireEvent.click(submit());

    await waitFor(() => expect(onParsed).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/parse');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Jordan Avery\nJunior Software Engineer',
    });
    expect(onParsed).toHaveBeenCalledWith({
      ok: true,
      resumeMd: RESUME_MD_FIXTURE,
      draftLibrary: DRAFT_LIBRARY_FIXTURE,
    });
  });

  it('[machine] the file submit sends multipart with only `file` and no Content-Type', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, okBody));
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadForm onParsed={vi.fn()} />);
    const file = selectFile();
    fireEvent.click(submit());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/parse');
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBe(file);
    // LIB-01 makes `file` win over `text` and 422s with no fallback, so sending
    // both would turn a recoverable paste into a hard failure.
    expect(body.get('text')).toBeNull();
    expect(init.headers).toBeUndefined();
  });

  it('[machine] a file over 10 MB is rejected client-side with ZERO fetch calls', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, okBody));
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadForm onParsed={vi.fn()} />);
    selectFile(10 * 1024 * 1024 + 1, 'huge.pdf');
    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/larger than 10 MB/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submitting with nothing selected makes ZERO fetch calls', () => {
    const fetchMock = vi.fn(async () => jsonRes(200, okBody));
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadForm onParsed={vi.fn()} />);
    fireEvent.click(submit());

    expect(screen.getByRole('alert').textContent).toMatch(/choose a pdf or docx file first/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an empty/whitespace-only paste makes ZERO fetch calls', () => {
    const fetchMock = vi.fn(async () => jsonRes(200, okBody));
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadForm onParsed={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /paste text instead/i }));
    fireEvent.change(screen.getByLabelText(/resume text/i), { target: { value: '   \n  ' } });
    fireEvent.click(submit());

    expect(screen.getByRole('alert').textContent).toMatch(/paste the text of your resume first/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('[machine] 503 and 401 show their own messages and keep the form usable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(503, { error: 'global_breaker_tripped' }))
      .mockResolvedValueOnce(jsonRes(401, { error: 'Unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadForm onParsed={vi.fn()} />);
    selectFile();
    fireEvent.click(submit());
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/temporarily unavailable/i),
    );
    // Neither is a paste problem, so the file UI must stay put.
    expect(screen.getByLabelText(/resume file/i)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submit());
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/session has expired/i),
    );
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it('[machine] double-clicking submit issues exactly ONE fetch (double spend guard)', async () => {
    // PARSE has no per-user quota bucket — a second click is a second ~$0.03
    // Anthropic charge, not just a duplicate request.
    let resolveFetch: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadForm onParsed={vi.fn()} />);
    selectFile();
    fireEvent.click(submit());
    fireEvent.click(submit());
    fireEvent.click(submit());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(jsonRes(200, okBody));
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(false));
  });

  it('[machine] shows a loading status and disables submit while in flight', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(() => pending));

    render(<UploadForm onParsed={vi.fn()} />);
    selectFile();
    fireEvent.click(submit());

    expect(screen.getByRole('status').textContent).toMatch(/about 30 seconds/i);
    expect((submit() as HTMLButtonElement).disabled).toBe(true);

    resolveFetch(jsonRes(200, okBody));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('[machine] a second suggestPaste while ALREADY pasting shows an error, not a no-op', async () => {
    // Otherwise the user clicks, nothing visibly changes, and the button reads as
    // broken (plan §4 E10).
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRes(422, { error: 'parse_failed', suggestPaste: true }));
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadForm onParsed={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /paste text instead/i }));
    fireEvent.change(screen.getByLabelText(/resume text/i), { target: { value: 'some resume' } });
    fireEvent.click(submit());

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/couldn't read that text either/i),
    );
    expect(screen.getByLabelText(/resume text/i)).toBeTruthy();
  });

  it('never logs the file, the response, or any resume content', () => {
    // PRD §8.1 — the privacy promise on the live /privacy page.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, okBody)));

    render(<UploadForm onParsed={vi.fn()} />);
    selectFile();
    fireEvent.click(submit());

    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });
});
