// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DRAFT_LIBRARY_FIXTURE,
  RESUME_MD_FIXTURE,
} from '@/app/(app)/library/_fixtures/library-fixtures';
import { requestParse, saveLibrary } from '@/app/(app)/library/_lib/api';

// jsdom, not node: these helpers use the browser `File`/`FormData` globals.
// NO test here makes a real network call — every `fetch` is stubbed, matching
// LIB-01's and LIB-02's posture.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type FetchInit = RequestInit | undefined;

const stubFetch = (impl: (url: string, init: FetchInit) => unknown) => {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
};

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('requestParse — file branch', () => {
  it('[machine] POSTs multipart with ONLY a `file` field and no Content-Type header', async () => {
    const mock = stubFetch(() =>
      jsonRes(200, { resumeMd: RESUME_MD_FIXTURE, draftLibrary: DRAFT_LIBRARY_FIXTURE }),
    );
    const file = new File([new Uint8Array([1, 2, 3])], 'resume.pdf', {
      type: 'application/pdf',
    });

    const result = await requestParse({ file });

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/parse');
    expect(init.method).toBe('POST');
    // The browser must generate the multipart boundary itself.
    expect(init.headers).toBeUndefined();
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBe(file);
    // LIB-01 makes `file` win when both are present and 422s with no fallback.
    expect(body.get('text')).toBeNull();

    expect(result).toEqual({
      ok: true,
      resumeMd: RESUME_MD_FIXTURE,
      draftLibrary: DRAFT_LIBRARY_FIXTURE,
    });
  });
});

describe('requestParse — text branch', () => {
  it('[machine] POSTs JSON { text } to /api/parse', async () => {
    const mock = stubFetch(() =>
      jsonRes(200, { resumeMd: 'md', draftLibrary: DRAFT_LIBRARY_FIXTURE }),
    );

    await requestParse({ text: 'pasted resume' });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/parse');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ text: 'pasted resume' });
  });

  it('never sends a userId (identity comes from the session only — PRD §8.3)', async () => {
    const mock = stubFetch(() =>
      jsonRes(200, { resumeMd: 'md', draftLibrary: DRAFT_LIBRARY_FIXTURE }),
    );
    await requestParse({ text: 'x' });
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).not.toContain('userId');
  });
});

describe('requestParse — status mapping (plan §2.4)', () => {
  it('[machine] 422 with suggestPaste:true → suggestPaste true + paste guidance', async () => {
    stubFetch(() => jsonRes(422, { error: 'parse_failed', suggestPaste: true }));
    const result = await requestParse({ text: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.suggestPaste).toBe(true);
    expect(result.message).toMatch(/paste the text/i);
  });

  it('422 WITHOUT suggestPaste does not claim pasting will help', async () => {
    stubFetch(() => jsonRes(422, { error: 'parse_failed' }));
    const result = await requestParse({ text: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.suggestPaste).toBe(false);
  });

  it('401 → session-expired message, no paste suggestion', async () => {
    stubFetch(() => jsonRes(401, { error: 'Unauthorized' }));
    const result = await requestParse({ text: 'x' });
    expect(result).toEqual({
      ok: false,
      suggestPaste: false,
      message: 'Your session has expired. Sign in again to continue.',
    });
  });

  it('503 → temporarily-unavailable message (global spend breaker)', async () => {
    stubFetch(() => jsonRes(503, { error: 'global_breaker_tripped' }));
    const result = await requestParse({ text: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/temporarily unavailable/i);
    expect(result.suggestPaste).toBe(false);
  });

  it('500 → generic message', async () => {
    stubFetch(() => jsonRes(500, { error: 'boom' }));
    const result = await requestParse({ text: 'x' });
    expect(result).toEqual({
      ok: false,
      suggestPaste: false,
      message: 'Something went wrong. Please try again.',
    });
  });

  it('a thrown fetch (offline) → generic message, never an unhandled rejection', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const result = await requestParse({ text: 'x' });
    expect(result.ok).toBe(false);
  });

  it('[machine] a 200 whose body fails ParseResult is treated as an error, not trusted', async () => {
    stubFetch(() => jsonRes(200, { resumeMd: 'md', draftLibrary: { nope: true } }));
    const result = await requestParse({ text: 'x' });
    expect(result.ok).toBe(false);
  });

  it('a 200 with unparseable JSON is an error, not a crash', async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    }));
    const result = await requestParse({ text: 'x' });
    expect(result.ok).toBe(false);
  });
});

describe('saveLibrary', () => {
  it('[machine] POSTs { library, resumeMd } as JSON to /api/library', async () => {
    const mock = stubFetch(() =>
      jsonRes(200, { library: DRAFT_LIBRARY_FIXTURE, resumeMd: RESUME_MD_FIXTURE }),
    );

    const result = await saveLibrary(DRAFT_LIBRARY_FIXTURE, RESUME_MD_FIXTURE);

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/library');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body.library).toEqual(DRAFT_LIBRARY_FIXTURE);
    expect(body.resumeMd).toBe(RESUME_MD_FIXTURE);
    expect(Object.keys(body).sort()).toEqual(['library', 'resumeMd']);

    expect(result).toEqual({
      ok: true,
      library: DRAFT_LIBRARY_FIXTURE,
      resumeMd: RESUME_MD_FIXTURE,
    });
  });

  it('[machine] 400 surfaces LIB-02 issue PATHS (never values) in the message', async () => {
    stubFetch(() =>
      jsonRes(400, {
        error: 'invalid_body',
        issues: ['library.projects.0.id: Project.id must be kebab-case, e.g. "voice-agent"'],
      }),
    );
    const result = await saveLibrary(DRAFT_LIBRARY_FIXTURE, RESUME_MD_FIXTURE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('library.projects.0.id');
  });

  it('400 with no usable issues still produces an actionable message', async () => {
    stubFetch(() => jsonRes(400, { error: 'invalid_body' }));
    const result = await saveLibrary(DRAFT_LIBRARY_FIXTURE, RESUME_MD_FIXTURE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/could not be saved/i);
  });

  it('401 → session-expired message', async () => {
    stubFetch(() => jsonRes(401, { error: 'Unauthorized' }));
    const result = await saveLibrary(DRAFT_LIBRARY_FIXTURE, '');
    expect(result).toEqual({
      ok: false,
      message: 'Your session has expired. Sign in again to continue.',
    });
  });

  it('500 → "your library was not changed"', async () => {
    stubFetch(() => jsonRes(500, { error: 'library_write_failed' }));
    const result = await saveLibrary(DRAFT_LIBRARY_FIXTURE, '');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/was not changed/i);
  });

  it('a thrown fetch → error result, never an unhandled rejection', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const result = await saveLibrary(DRAFT_LIBRARY_FIXTURE, '');
    expect(result.ok).toBe(false);
  });

  it('[machine] a committed write with a malformed echo is NOT reported as a failure', async () => {
    // The row is already persisted; claiming failure would be a lie that invites
    // the user to re-submit.
    stubFetch(() => jsonRes(200, { library: { garbage: true } }));
    const result = await saveLibrary(DRAFT_LIBRARY_FIXTURE, RESUME_MD_FIXTURE);
    expect(result).toEqual({
      ok: true,
      library: DRAFT_LIBRARY_FIXTURE,
      resumeMd: RESUME_MD_FIXTURE,
    });
  });
});
