import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserId, UnauthorizedError } from '@/lib/auth/session';
import { JobStatus } from '@/lib/schemas/persisted';

// FIT-01 Deliverables 4–5 — read one job, and the GENERIC status-transition route.
//
// WHY THE STATUS ROUTE LIVES IN 04-fit AT ALL (04-fit/README.md's decision): PRD
// §5.4 only names the `interviewing` transition ("用户点击'我拿到面试了'", owned by
// 06-prep), but 05-tailor ships BEFORE 06-prep and needs to set `applied`. Putting
// one generic PATCH here — in the earlier-delivered module — avoids 05-tailor
// depending on the later-delivered 06-prep.
//
// PERMISSIVE BY DESIGN: any of the four JobStatus values is accepted from any
// current status, including screening → interviewing directly. The PRD names NO
// ordering rule (it never says "you cannot go from screening straight to
// interviewing"), and inventing a state machine here would silently break TLR-02's
// "mark as applied" and PRP-03's "I got an interview" buttons the first time a user
// clicks them out of the order we guessed. Enum validity is the whole contract.
// The triggers for `applied`/`closed` are still undefined at product level
// (04-fit/README.md open question #1, owner Horace) — that is a product gap, not a
// licence to guess one here.
//
// PRD §8.3 (cross-user isolation): `userId` comes exclusively from the session, and
// the query module scopes every statement by it. A job belonging to another user is
// a 404 with a BYTE-IDENTICAL body to "no such job" — never a 403. Distinguishing
// the two would confirm that an id exists, which is itself an information leak
// (ticket Deliverable 2). The status UPDATE is a single ownership-scoped statement,
// so there is no read-then-write window in which ownership could change.
//
// The `id` comes ONLY from the path. The PATCH body is a `z.object`, which strips
// unknown keys, so there is no code path in which a client-supplied `id`, `userId`,
// `company`, `jd`, `ledger` or `fit` reaches a statement.
//
// BUILD-TIME SAFETY: `@/lib/db/queries/jobs` is imported LAZILY inside each handler
// (the FND-08 bug class — `next build` statically imports every route module, and
// db/index.ts throws at import time without DATABASE_URL). That query module is
// itself import-safe; the lazy import here is belt-and-braces, keeping the guard
// meaningful if a future edit reintroduces a top-level `db` import over there.
//
// NEXT 15: a dynamic route's `params` is a PROMISE and must be awaited. A
// non-Promise type type-checks in isolation but fails `next build`'s generated
// route-type check in CI.
//
// WIRE CONTRACT — FIT-03, TLR-02 and PRP-03 code against this:
//
//   GET /api/jobs/{id}
//     200 <the job, with ledger/fit possibly null>   Cache-Control: no-store
//     401 { "error":"Unauthorized" }
//     404 { "error":"not_found" }                    also when it is another user's
//     500 { "error":"job_read_failed" }
//
//   PATCH /api/jobs/{id}   Content-Type: application/json
//     body { "status": "screening"|"applied"|"interviewing"|"closed" }
//     200 <the updated job>                          Cache-Control: no-store
//     400 { "error":"invalid_body", "issues": string[] }
//     401 { "error":"Unauthorized" }
//     404 { "error":"not_found" }
//     500 { "error":"job_write_failed" }
//
// `Cache-Control: no-store` on every 2xx: the body carries the user's pasted JD, and
// a shared cache holding it would be a cross-user leak.
//
// CONCURRENCY: PATCH is last-write-wins (no version column, no If-Match) — accepted
// for v1, documented in lib/db/queries/jobs.ts.
//
// LOGGING: error name/message and Zod issue PATHS only — never the job body, the JD,
// or a raw Drizzle/pg error object.

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

// Enum validity is the ONLY body rule (see PERMISSIVE BY DESIGN above). z.object
// strips unknown keys, so extras in the body are dropped rather than persisted.
const PatchJobBody = z.object({ status: JobStatus });

type Ctx = { params: Promise<{ id: string }> };

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/** One body for both "does not exist" and "not yours" — no existence oracle. */
function notFound(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) return unauthorized();
    throw e;
  }

  const { id } = await ctx.params;

  try {
    const { getJob } = await import('@/lib/db/queries/jobs');
    const job = await getJob(userId, id);
    // `null` covers both "no such id" and "another user's id" — the query module
    // never distinguishes them, and neither does this response.
    if (!job) return notFound();
    return NextResponse.json(job, { status: 200, headers: NO_STORE });
  } catch (err) {
    // A throw here means the stored row drifted from PersistedJob (the query
    // module's loud-failure policy). That is a 500, not a 404: the job exists.
    console.error('[jobs] job read failed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return NextResponse.json({ error: 'job_read_failed' }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx): Promise<NextResponse> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) return unauthorized();
    throw e;
  }

  const { id } = await ctx.params;

  // Malformed JSON and an out-of-enum status land in the SAME 400 — never a throw.
  const body: unknown = await req.json().catch(() => null);
  const parsed = PatchJobBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        // Paths + messages only, never the offending value.
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      { status: 400 },
    );
  }

  try {
    const { updateJobStatus } = await import('@/lib/db/queries/jobs');
    // Ownership is enforced INSIDE this single scoped UPDATE ... RETURNING (see the
    // query module): zero rows back ⇒ unknown id or another user's job ⇒ 404.
    const job = await updateJobStatus(userId, id, parsed.data.status);
    if (!job) return notFound();
    return NextResponse.json(job, { status: 200, headers: NO_STORE });
  } catch (err) {
    console.error('[jobs] job status write failed', {
      userId,
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : undefined,
    });
    return NextResponse.json({ error: 'job_write_failed' }, { status: 500 });
  }
}

// Only GET and PATCH are exported — Next.js answers every other method with 405 by
// itself. There is no DELETE in v1: `jobs` has no soft-delete column by FND-05
// design, and no ticket asks for a hard delete of a single job (account deletion
// cascades from `users`).
