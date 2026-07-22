import { NextResponse } from 'next/server';

import { requireUserId, UnauthorizedError } from '@/lib/auth/session';
import { buildPdfParseRequest } from '@/lib/parse/pdf';
import { buildRepairRequest, buildTextParseRequest, type AnthropicMessageRequest } from '@/lib/parse/request';
import { ParseResult } from '@/lib/parse/schema';

// LIB-01 Deliverable 4 — the PARSE stage route.
//
// PRD §5.1 (PARSE row): 导入简历 · 文件/文本 → resumeMd + 草稿 Library ·
// "metrics 只取简历中出现的真实数字（P2）；草稿必须经用户确认才成为库" ·
// "解析失败 → 引导粘贴纯文本".
//
// This route PERSISTS NOTHING. The draft is returned to the client; turning it
// into a real library on user confirmation is LIB-02's job. The only DB row that
// results from a call here is the usage_events row recordUsage() writes.
//
// PRIVACY, and it is a security control rather than hygiene (PRD §8.1
// "原始文件解析后即弃、不落盘"): the uploaded bytes live ONLY in this handler's
// frame for the duration of the request. No fs, no /tmp, no blob SDK, no cache.
// app/(legal)/privacy/page.tsx (PLT-01, live) already tells users "We do not keep
// your original uploaded resume file... there is no file store" — any file write
// added here would make a published legal page false. A static scan in
// route.test.ts enforces this mechanically over this file and lib/parse/**.
//
// BUILD-TIME SAFETY (same rule as app/api/account/delete/route.ts): `next build`'s
// "Collecting page data" phase statically imports every app/api/**/route.ts, and
// db/index.ts THROWS at import time when DATABASE_URL is unset (an intentional
// FND-05 fail-fast). `@/lib/config/quota` and `@/lib/usage/record` BOTH statically
// import `@/db/index`, so they are imported LAZILY inside the handler, never at
// module top level. This is the exact failure FND-08 shipped and had to
// bounce-fix. `@/lib/auth/session` → `@/auth` is safe statically (its DB import is
// deferred into a request-time factory). Guarded by a test that imports this
// module with DATABASE_URL blank and no mocks.
//
// WIRE CONTRACT (LIB-03 codes against this):
//
//   Request A  POST /api/parse, Content-Type: application/json
//              body { "text": "<pasted resume>" }
//   Request B  POST /api/parse, multipart/form-data
//              field `file` = the PDF or DOCX  (or field `text` for pasted text)
//
//   200  { "resumeMd": string, "draftLibrary": Library }
//   401  { "error": "Unauthorized" }
//   422  { "error": "parse_failed", "suggestPaste": true }
//   503  { "error": "global_breaker_tripped" }
//
// CSRF: auth.config.ts sets no cookie override, so Auth.js v5 defaults apply
// (httpOnly, sameSite: 'lax'). A cross-site POST therefore carries no session
// cookie and gets a 401 before any spend — no extra CSRF token needed here.

// Buffer + mammoth need Node (also the default; stated explicitly so an edge
// migration cannot silently break the DOCX path).
export const runtime = 'nodejs';
// Vercel Hobby ceiling. A PARSE call is 10–40s (PRD §9).
export const maxDuration = 60;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

// 10 MiB — base64 inflates to ~13.3 MiB, comfortably under Anthropic's 32 MB
// request cap. Also the only in-ticket DoS/cost guard: PARSE deliberately has NO
// per-user quota bucket (DAILY_QUOTA has no `parse` key by design), so the size
// caps plus the global breaker are the whole backstop. A per-user PARSE rate
// limit is a PRD §8.3 change, not a silent addition here.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// ~25k tokens ≈ $0.05 of input. A real resume is ~5k chars.
const MAX_TEXT_CHARS = 100_000;
// Below `maxDuration`, so a hung upstream surfaces as our own 422 rather than a
// platform 504 with no error contract.
const ANTHROPIC_TIMEOUT_MS = 45_000;

type AnthropicCall = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  truncated: boolean;
};

/** PRD §5.1's failure policy: 解析失败 → 引导粘贴纯文本 (LIB-03 reads `suggestPaste`). */
function parseFailed(): NextResponse {
  return NextResponse.json({ error: 'parse_failed', suggestPaste: true }, { status: 422 });
}

function isUsableText(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_TEXT_CHARS;
}

/**
 * Resolves the request body into a Messages-API request, or `null` if the input
 * is unusable (wrong content-type, missing/oversize/undetectable file, empty or
 * oversize text, unreadable DOCX). Returning `null` rather than throwing keeps
 * every failure funnelling into the one 422 contract.
 *
 * SNIFF CONTENT, NEVER TRUST `file.type` / `file.name`: a client-declared
 * `application/pdf` on a ZIP would ship a ZIP to Anthropic as base64 PDF — wasted
 * spend and a confusing failure. Only `PK\x03\x04` (a ZIP local-file header) is
 * accepted for DOCX; `PK\x05\x06` / `PK\x07\x08` are the empty-archive and
 * spanned-archive markers, which cannot begin a real .docx.
 */
async function buildRequestFromBody(req: Request): Promise<AnthropicMessageRequest | null> {
  const contentType = req.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body: unknown = await req.json().catch(() => null);
    const text = (body as { text?: unknown } | null)?.text;
    return isUsableText(text) ? buildTextParseRequest(text) : null;
  }

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null);
    if (!form) return null;

    const file = form.get('file');
    if (file && typeof file === 'object' && 'arrayBuffer' in file) {
      // PRECEDENCE: when both `file` and `text` are present, `file` WINS and a
      // failed file path returns 422 — it does NOT silently fall back to `text`.
      // A silent fallback would hide upload bugs from LIB-03 and from the user.
      if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) return null;
      const buf = Buffer.from(await file.arrayBuffer());

      if (buf.subarray(0, 5).toString('latin1') === '%PDF-') {
        return buildPdfParseRequest(buf);
      }
      if (
        buf.length >= 4 &&
        buf[0] === 0x50 &&
        buf[1] === 0x4b &&
        buf[2] === 0x03 &&
        buf[3] === 0x04
      ) {
        // Lazy so the PDF and pasted-text paths never pay mammoth's load cost.
        const { extractDocxText } = await import('@/lib/parse/docx');
        const text = await extractDocxText(buf).catch(() => null);
        return isUsableText(text) ? buildTextParseRequest(text) : null;
      }
      return null;
    }

    const text = form.get('text');
    return isUsableText(text) ? buildTextParseRequest(text) : null;
  }

  return null;
}

/**
 * One Anthropic Messages call. Returns `null` on any transport/HTTP/timeout
 * failure — the caller converts that to 422 without a repair retry (a 429/500/
 * timeout is not a JSON problem; a second paid call cannot help).
 *
 * Uses the global `fetch` with no injection seam, deliberately: tests stub
 * `globalThis.fetch`, and an `fetchImpl` option on a request-handling route would
 * be a live seam in production code that exists only for tests.
 *
 * LOGGING: NEVER logs the response body or the request headers. The headers carry
 * ANTHROPIC_API_KEY and the body can echo a real person's resume. This diverges
 * on purpose from eval/judge.ts, which logs error bodies — its input is synthetic
 * fixture text, this one's is user PII. Status codes, error names, and lengths
 * only.
 */
async function callAnthropic(request: AnthropicMessageRequest): Promise<AnthropicCall | null> {
  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error('[parse] anthropic returned', res.status);
      return null;
    }

    const data = await res.json();
    const blocks: unknown = data?.content;
    const text = Array.isArray(blocks)
      ? blocks
          .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
          .map((b) => b.text as string)
          .join('')
      : '';

    return {
      text,
      tokensIn: Number(data?.usage?.input_tokens ?? 0),
      tokensOut: Number(data?.usage?.output_tokens ?? 0),
      truncated: data?.stop_reason === 'max_tokens',
    };
  } catch (err) {
    console.error('[parse] anthropic call failed', {
      name: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

/**
 * Pulls the JSON object out of a model reply: strips an optional code fence, then
 * slices from the first `{` to the last `}`. Returns `null` if that is not valid
 * JSON. The prompt forbids fences; this tolerates one anyway rather than burning
 * a paid repair call on a cosmetic violation.
 */
function extractJsonObject(text: string): unknown | null {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Validates one model reply. Returns the parsed result, or an `errorSummary`
 * describing what was wrong in terms a model can act on (Zod's issue paths are
 * what let it fix e.g. a non-kebab-case `projects[0].id`).
 */
function validateCall(
  call: AnthropicCall,
): { ok: true; value: ParseResult } | { ok: false; errorSummary: string } {
  if (call.truncated) {
    return { ok: false, errorSummary: 'the reply was cut off before the JSON ended' };
  }
  const json = extractJsonObject(call.text);
  if (json === null) {
    return { ok: false, errorSummary: 'the reply was not valid JSON' };
  }
  const parsed = ParseResult.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errorSummary: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, value: parsed.data };
}

export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();

  // 1) Auth FIRST — before the body is read, before the breaker, before any
  //    spend. `userId` comes EXCLUSIVELY from the session; this handler reads no
  //    id from the body or query (PRD §8.3 trust boundary).
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw e;
  }

  // 2) Global spend breaker (PRD §8.3 "全局日花费熔断阈值"). PARSE has no
  //    per-user quota bucket, but the global breaker applies to ALL paid
  //    operations — these are two independent controls and only the per-user one
  //    is PARSE-exempt. Lazy import: see BUILD-TIME SAFETY above.
  //
  //    FAIL CLOSED when checkGlobalBreaker() THROWS (FND-06 does that
  //    deliberately when GLOBAL_DAILY_SPEND_LIMIT_USD is unset/blank/non-numeric):
  //    no paid call may go out without a configured breaker. It returns the SAME
  //    503 rather than a new error code, because LIB-03 cannot act differently on
  //    "breaker tripped" vs "breaker misconfigured" — the operator sees the real
  //    reason in the log line. Either way: zero Anthropic calls, zero recordUsage.
  try {
    const { checkGlobalBreaker } = await import('@/lib/config/quota');
    const breaker = await checkGlobalBreaker();
    if (breaker.tripped) {
      return NextResponse.json({ error: 'global_breaker_tripped' }, { status: 503 });
    }
  } catch (err) {
    console.error('[parse] global breaker check failed; failing closed', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return NextResponse.json({ error: 'global_breaker_tripped' }, { status: 503 });
  }

  // 3) Resolve the source. Any unusable input → 422 with NO Anthropic call.
  const request = await buildRequestFromBody(req).catch(() => null);
  if (!request) return parseFailed();

  // 4) The paid call. Transport failure → 422, and NO repair retry.
  const first = await callAnthropic(request);
  if (!first) return parseFailed();

  let validated = validateCall(first);
  let repair: AnthropicCall | null = null;

  // 5) Exactly ONE JSON-repair retry (PRD §5.1 "JSON 修复重试 1 次"), covering
  //    syntax errors, schema errors, and truncation alike. Never a second one.
  if (!validated.ok) {
    console.error('[parse] first reply unusable; attempting one repair', {
      stage: 'repair',
      reason: validated.errorSummary.slice(0, 200),
      outputLength: first.text.length,
    });
    repair = await callAnthropic(buildRepairRequest(first.text, validated.errorSummary));
    if (!repair) return parseFailed();
    validated = validateCall(repair);
    if (!validated.ok) {
      console.error('[parse] repair reply also unusable; giving up', {
        stage: 'repair',
        reason: validated.errorSummary.slice(0, 200),
        outputLength: repair.text.length,
      });
      return parseFailed();
    }
  }

  // 6) Usage on SUCCESS only (Deliverable 4(f)), one row per user-facing
  //    operation — including the repair call's tokens, which were really spent.
  //
  //    KNOWN GAP, deliberately not fixed here (plan §5 Q1): a paid call that
  //    completes but fails JSON/Zod repair costs real money and writes no
  //    usage_events row, so checkGlobalBreaker() under-counts it. FND-10 supports
  //    `status: 'failure'` for exactly this. Recording failures is a product/cost
  //    decision for Horace, escalated rather than silently changed; the failure
  //    paths above at least console.error so the spend is visible in logs.
  const { recordUsage } = await import('@/lib/usage/record');
  await recordUsage({
    userId,
    op: 'parse',
    tokensIn: first.tokensIn + (repair?.tokensIn ?? 0),
    tokensOut: first.tokensOut + (repair?.tokensOut ?? 0),
    searches: 0,
    durationMs: Date.now() - startedAt,
  });

  // 7) Nothing reaches the client that has not cleared ParseResult (PRD §5.5) —
  //    raw model text is never returned on any path. `no-store` because the body
  //    is the user's full resume.
  return NextResponse.json(
    { resumeMd: validated.value.resumeMd, draftLibrary: validated.value.draftLibrary },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
