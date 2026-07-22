import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserId, UnauthorizedError } from '@/lib/auth/session';
import { Library } from '@/lib/schemas/entities';

// LIB-02 Deliverable 2 — the library/resume persistence endpoint.
//
// PRD §5.1 (PARSE row): "草稿必须经用户确认才成为库". LIB-01's /api/parse persists
// NOTHING; this is where a confirmed draft becomes the user's library. The
// `Library` and the source `Resume.sourceMd` are ONE confirmation unit — POST
// writes both atomically or neither (see lib/db/queries/library.ts).
//
// TRUST BOUNDARY (PRD §8.3): `userId` comes EXCLUSIVELY from `requireUserId()`.
// This route reads no id from the body or the query string, and the body schema is
// a `z.object`, which STRIPS unknown keys — so a client-supplied `userId`/`id`/
// `deletedAt` in the payload is silently dropped and can never reach a query.
//
// BUILD-TIME SAFETY (same rule as app/api/parse/route.ts and
// app/api/account/delete/route.ts): `next build`'s "Collecting page data" phase
// statically imports every app/api/**/route.ts, and db/index.ts THROWS at import
// time when DATABASE_URL is unset (an intentional, tested FND-05 fail-fast). So
// `@/lib/db/queries/library` is imported LAZILY inside each handler. That query
// module is itself import-safe (it resolves `@/db/index` at call time, precisely so
// LIB-03's and FIT-03's server components can import it statically) — the lazy
// import here is belt-and-braces, keeping the established regression guard
// meaningful if a future edit ever reintroduces a top-level `db` import over there.
// This is the exact failure FND-08 shipped and had to bounce-fix.
// `@/lib/auth/session` → `@/auth` is safe statically (its DB import is deferred
// into a request-time factory).
//
// WIRE CONTRACT — LIB-03 codes against this, do not improvise:
//
//   GET  /api/library
//     200 { "library": Library | null, "resumeMd": string | null }   Cache-Control: no-store
//     401 { "error": "Unauthorized" }
//     500 { "error": "library_read_failed" }
//
//   POST /api/library      Content-Type: application/json
//     body { "library": Library, "resumeMd": string }
//     200 { "library": Library, "resumeMd": string }                 Cache-Control: no-store
//     400 { "error": "invalid_body", "issues": string[] }   issues are Zod PATHS + messages, never values
//     401 { "error": "Unauthorized" }
//     500 { "error": "library_write_failed" }
//
// A GET for a user with no library is 200 WITH NULLS, not 404: the client
// distinguishes "no library yet" from an error via the null fields, not via the
// HTTP status (ticket Deliverable 2).
//
// `Cache-Control: no-store` on every 200 of both handlers: the body is the user's
// resume, and any shared cache holding it would be a cross-user leak.
//
// CSRF: auth.config.ts sets no cookie override, so Auth.js v5 defaults apply
// (httpOnly, sameSite: 'lax'). A cross-site POST therefore carries no session
// cookie and gets a 401 before any DB access — same posture LIB-01 documented. No
// extra token needed. middleware.ts deliberately excludes /api/**; `requireUserId()`
// in each handler is the only gate, and no middleware matcher entry is added here.
//
// LOGGING: never log `resumeMd`, `library` content, or a raw Drizzle/pg error
// OBJECT. A failing insert here carries the user's whole resume in its query
// parameters, and a driver error can echo them. This diverges DELIBERATELY from
// app/api/account/delete/route.ts, which logs `{ userId, err }` — that route's
// statements carry ids only, this one's carry PII. Error `name` + `message` and
// Zod issue PATHS only.

// `dbTx` (reached through the query module's `confirmLibraryImport`) is
// neon-serverless and needs the `ws` package — an Edge migration would break it
// silently. Node is also the default; this is a guard, not a change.
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

// LIB-01 caps its own pasted-text input at 100_000 chars, so no legitimate PARSE
// output can approach this. It is a DB-bloat/DoS guard on an endpoint that
// otherwise accepts unbounded authenticated text, not a product limit.
// `library.projects` is deliberately NOT length-capped: there is no PRD basis for a
// number, and the practical bound is the PARSE output the user just confirmed. A
// platform-level body-size limit is the right place for a hard cap.
const MAX_RESUME_MD_CHARS = 200_000;

const LibraryPostBody = z.object({
  library: Library,
  resumeMd: z.string().max(MAX_RESUME_MD_CHARS),
});

// Postgres rejects U+0000 in BOTH `text` ("invalid byte sequence for encoding
// UTF8: 0x00") and `jsonb` ("unsupported Unicode escape sequence"). An
// authenticated client can send one in JSON, so without this guard a
// one-character payload is an unhandled 500. Rejected at the boundary as a 400
// instead, on `resumeMd` and on every string nested anywhere inside `library`.
const NUL = String.fromCharCode(0);
function hasNulByte(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (Array.isArray(value)) return value.some(hasNulByte);
  if (value && typeof value === 'object') return Object.values(value).some(hasNulByte);
  return false;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function invalidBody(issues: string[]): NextResponse {
  return NextResponse.json({ error: 'invalid_body', issues }, { status: 400 });
}

export async function GET(): Promise<NextResponse> {
  // 1) Auth FIRST — an unauthenticated caller makes ZERO DB calls.
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) return unauthorized();
    throw e;
  }

  // 2) Lazy query-module import (see BUILD-TIME SAFETY above).
  const { getLibrary, getResume } = await import('@/lib/db/queries/library');

  // 3) Two independent reads. NOT a join: `libraries` and `resumes` have no FK to
  //    each other, and joining would silently drop the library for a user who has
  //    one but no resume row.
  try {
    const [library, resume] = await Promise.all([getLibrary(userId), getResume(userId)]);
    return NextResponse.json(
      { library, resumeMd: resume?.sourceMd ?? null },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    console.error('[library] read failed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return NextResponse.json({ error: 'library_read_failed' }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  // 1) Auth BEFORE the body is read, so an unauthenticated caller costs nothing.
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) return unauthorized();
    throw e;
  }

  // 2) Malformed JSON / wrong content-type must land in the SAME 400, never an
  //    unhandled throw.
  const body: unknown = await req.json().catch(() => null);

  // 3) Validate. NO DB call happens on any rejection path.
  const parsed = LibraryPostBody.safeParse(body);
  if (!parsed.success) {
    return invalidBody(
      // Paths + messages only — never the offending VALUES (they are the user's
      // resume, and this response is attacker-reachable for their own session).
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  if (hasNulByte(parsed.data)) {
    return invalidBody(['body: contains a NUL character']);
  }

  // 4) The atomic write (both tables or neither). Lazy import, as above.
  const { confirmLibraryImport } = await import('@/lib/db/queries/library');
  try {
    await confirmLibraryImport(userId, parsed.data.library, parsed.data.resumeMd);
  } catch (err) {
    // name + message ONLY — see the LOGGING note in the header.
    console.error('[library] write failed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return NextResponse.json({ error: 'library_write_failed' }, { status: 500 });
  }

  // 5) The Zod-parsed values ARE what was persisted, so echoing them needs no
  //    second round-trip (and cannot disagree with the DB).
  return NextResponse.json(
    { library: parsed.data.library, resumeMd: parsed.data.resumeMd },
    { status: 200, headers: NO_STORE },
  );
}

// Only GET and POST are exported — Next.js answers every other method with 405 by
// itself. No delete endpoint of any kind exists in v1 (ticket Non-goals):
// `libraries.deletedAt` is read (filtered on) but never written.
