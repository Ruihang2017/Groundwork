import { ParseResult } from '@/lib/parse/schema';
import { Library } from '@/lib/schemas/entities';

// LIB-03 — the ONLY two `fetch` call sites in this ticket (plan §2.4).
//
// Every component reaches the network through here, so status→message mapping is
// unit-testable and no component contains a URL. This ticket adds NO route: it
// calls LIB-01's `POST /api/parse` and LIB-02's `POST /api/library`, both already
// merged, against the wire contracts transcribed in their route headers.
//
// PRIVACY (PRD §8.1, and it is a control rather than hygiene): NOTHING in this
// file — or anywhere else in this ticket — logs the request body, the response
// body, `resumeMd`, or any `Library` content. That is a real person's resume, and
// app/(legal)/privacy/page.tsx is live and promises there is no file store. There
// is also no localStorage/sessionStorage/IndexedDB/cookie persistence of any of
// it, and no resume text ever goes in a URL or query string.
//
// SECURITY: relative, same-origin URLs only. No configurable base URL, no
// `credentials: 'include'` (same-origin is the default and the Auth.js session
// cookie is httpOnly + sameSite=lax, which is also what makes a cross-site POST
// here fail closed with a 401). `userId` is NEVER sent — both routes derive it
// from the session (PRD §8.3).

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const SESSION_EXPIRED = 'Your session has expired. Sign in again to continue.';

export type ParseOk = { ok: true; resumeMd: string; draftLibrary: Library };
export type ParseErr = { ok: false; suggestPaste: boolean; message: string };
export type ParseOutcome = ParseOk | ParseErr;

/**
 * `POST /api/parse` (LIB-01). Returns a discriminated result rather than throwing,
 * so callers cannot forget an error path.
 *
 * NO client-side `AbortSignal.timeout`. The route's `maxDuration` is 60s and a
 * real PARSE takes 10–40s (PRD §9), so any client timeout short enough to feel
 * responsive would kill legitimate parses. The server owns the deadline.
 */
export async function requestParse(
  input: { file: File } | { text: string },
): Promise<ParseOutcome> {
  let res: Response;
  try {
    if ('file' in input) {
      // The FormData is built BY HAND from a File held in component state, and
      // never with `new FormData(formElement)`. Two reasons, both real:
      //   1. jsdom serialises a form's file input from its internal file list, so
      //      a test-injected File comes back as a zero-byte File — a component
      //      that reads the form element passes in a browser and silently fails
      //      every test (plan §0 fact 3 / §4 E11).
      //   2. Only `file` is appended. LIB-01's route makes `file` WIN when both
      //      fields are present and 422s a failed file path with no fallback to
      //      `text`, so sending both would turn a recoverable paste into an error.
      const fd = new FormData();
      fd.append('file', input.file);
      // Deliberately NO 'Content-Type' header: the browser must generate the
      // multipart boundary. Setting it by hand produces a body the server cannot
      // parse.
      res = await fetch('/api/parse', { method: 'POST', body: fd });
    } else {
      res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input.text }),
      });
    }
  } catch {
    // Offline, DNS, aborted connection. No status to map.
    return { ok: false, suggestPaste: false, message: GENERIC_ERROR };
  }

  const body: unknown = await res.json().catch(() => null);

  if (res.ok) {
    // Defence in depth against a proxy mangling the body — the server already
    // validated this against the same schema (PRD §5.5's trust boundary is
    // server-side; this is belt-and-braces, not the boundary).
    const parsed = ParseResult.safeParse(body);
    if (!parsed.success) {
      return { ok: false, suggestPaste: false, message: GENERIC_ERROR };
    }
    return {
      ok: true,
      resumeMd: parsed.data.resumeMd,
      draftLibrary: parsed.data.draftLibrary,
    };
  }

  switch (res.status) {
    case 401:
      return { ok: false, suggestPaste: false, message: SESSION_EXPIRED };
    case 422:
      // PRD §5.1's failure policy: 解析失败 → 引导粘贴纯文本. `suggestPaste` is read
      // off the body rather than inferred from the status, so the route stays the
      // single source of truth for whether pasting is worth offering.
      return {
        ok: false,
        suggestPaste: (body as { suggestPaste?: unknown } | null)?.suggestPaste === true,
        message: "We couldn't read that resume. Paste the text instead.",
      };
    case 503:
      // LIB-01's global spend breaker. Not the user's fault and not fixable by
      // pasting, so no paste suggestion.
      return {
        ok: false,
        suggestPaste: false,
        message: 'Resume parsing is temporarily unavailable. Please try again later.',
      };
    default:
      return { ok: false, suggestPaste: false, message: GENERIC_ERROR };
  }
}

export type SaveOk = { ok: true; library: Library; resumeMd: string };
export type SaveErr = { ok: false; message: string };
export type SaveOutcome = SaveOk | SaveErr;

/**
 * `POST /api/library` (LIB-02) — a WHOLE-OBJECT upsert of the library and the
 * source resume markdown, in one transaction. There are no per-project endpoints
 * and none may be added (ticket Non-goals); every mutation in this ticket
 * therefore submits the complete `Library` plus the unmodified `resumeMd`.
 */
export async function saveLibrary(library: Library, resumeMd: string): Promise<SaveOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library, resumeMd }),
    });
  } catch {
    return { ok: false, message: 'Saving failed. Your library was not changed.' };
  }

  const body: unknown = await res.json().catch(() => null);

  if (res.ok) {
    // LIB-02 echoes exactly what it persisted. The echo is validated, but a
    // malformed echo is NOT turned into an error: the write already committed, so
    // reporting failure would be a lie. Fall back to what we sent instead.
    const echo = body as { library?: unknown; resumeMd?: unknown } | null;
    const echoedLibrary = Library.safeParse(echo?.library);
    return {
      ok: true,
      library: echoedLibrary.success ? echoedLibrary.data : library,
      resumeMd: typeof echo?.resumeMd === 'string' ? echo.resumeMd : resumeMd,
    };
  }

  if (res.status === 401) return { ok: false, message: SESSION_EXPIRED };

  if (res.status === 400) {
    // Safe to surface: LIB-02 guarantees `issues` are Zod PATHS + messages and
    // never VALUES, precisely so this response can be shown to the user. Do not
    // extend this to echoing arbitrary server error bodies.
    const issues = (body as { issues?: unknown } | null)?.issues;
    const shown = Array.isArray(issues)
      ? issues.filter((i): i is string => typeof i === 'string').slice(0, 5)
      : [];
    return {
      ok: false,
      message:
        shown.length > 0
          ? `Your library could not be saved: ${shown.join('; ')}`
          : 'Your library could not be saved. Check the fields above and try again.',
    };
  }

  return { ok: false, message: 'Saving failed. Your library was not changed.' };
}
