import { eq, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { signOut } from '@/auth';
import {
  accounts,
  briefs,
  jobs,
  libraries,
  resumes,
  sessions,
  tailoredResumes,
  usageEvents,
  users,
} from '@/db/schema';
import { requireUserId, UnauthorizedError } from '@/lib/auth/session';

// PLT-01 Deliverable 2 — the app's single most destructive endpoint: an
// authenticated POST that HARD-DELETES the caller's entire account and all of
// their data across every per-user table, then signs them out. PRD §5.6/§8.3:
// "删号 = 硬删该用户全部数据". PRD §12 names this as a concrete PII-leak
// mitigation, so its correctness is a security control, not a nice-to-have.
//
// BUILD-TIME SAFETY (plan §2.2 point 1): `@/db/index` is imported LAZILY inside
// the handler, never at module top level. `next build`'s "Collecting page data"
// phase statically imports every app/api/**/route.ts module; a top-level
// `import { dbTx } from '@/db/index'` would pull db/index.ts (which THROWS at
// import time when DATABASE_URL is unset — an intentional, tested FND-05
// fail-fast) into the static build graph and break `pnpm build` on any checkout
// with no DATABASE_URL (including CI). This is exactly the failure FND-08 v0.1
// shipped and had to bounce-fix. `@/db/schema` (table objects only, no
// connection) and `@/auth`/`@/lib/auth/session` (DB import is itself deferred to
// a request-time factory) are safe to import statically.

export async function POST(): Promise<NextResponse> {
  // 1) Auth FIRST, before any DB access. `userId` comes EXCLUSIVELY from the
  //    session (plan §2.2 point 7 — trust boundary): this route reads no userId
  //    from the request body or query string, so a caller cannot delete anyone
  //    but themselves. `requireUserId()` throws UnauthorizedError for no/invalid
  //    session; convert that to a 401 and make ZERO DB calls in that case.
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw e;
  }

  // Lazy DB import (see BUILD-TIME SAFETY above). `dbTx` is the transaction-
  // capable client (neon-serverless); the neon-http `db` cannot do multi-
  // statement transactions (see db/index.ts).
  const { dbTx } = await import('@/db/index');

  // 2) ONE transaction, explicit ordered deletes, children before parents so the
  //    FKs are always satisfied at each step.
  //
  //    RECONCILIATION WITH ON DELETE CASCADE (ticket Feedback obligation #1,
  //    plan §2.2 point 4): db/schema.ts already sets `onDelete: 'cascade'` on
  //    every one of these FKs (libraries/resumes/jobs/usageEvents/accounts/
  //    sessions → users.id, and tailoredResumes/briefs → jobs.id). The explicit
  //    per-table deletes below and the DB-level cascade fired by the final
  //    `DELETE FROM users` are NOT two racing mechanisms: they run strictly
  //    sequentially inside this single transaction, so by the time the users row
  //    is deleted every child table for this userId is already empty and the
  //    cascade fires as a zero-row no-op. Keeping the explicit deletes is
  //    deliberate defense-in-depth — it matches Deliverable 2's literal statement
  //    list and makes the rollback-atomicity test meaningful (there is more than
  //    one statement to fail on). If any statement throws, the whole transaction
  //    ROLLS BACK: a partial delete (some tables cleared, users row still
  //    present) would be strictly worse than no delete — the user would believe
  //    they are gone when they are not.
  //
  //    NOT touched: `verification_tokens` (no userId column — keyed by
  //    identifier/token for pending, not-yet-consumed magic links; the ticket
  //    names only accounts/sessions) and `eval_runs` (no userId column — it is
  //    fixture/regression data, deliberately OUT of scope per the ticket
  //    Background).
  try {
    await dbTx.transaction(async (tx) => {
      await tx.delete(usageEvents).where(eq(usageEvents.userId, userId));
      // briefs/tailoredResumes have no direct userId — reach them through the
      // user's jobs (PRD §8.3 "无跨用户查询路径"). Delete BEFORE the jobs rows
      // they reference.
      const userJobIds = tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.userId, userId));
      await tx.delete(briefs).where(inArray(briefs.jobId, userJobIds));
      await tx
        .delete(tailoredResumes)
        .where(inArray(tailoredResumes.jobId, userJobIds));
      await tx.delete(jobs).where(eq(jobs.userId, userId));
      await tx.delete(resumes).where(eq(resumes.userId, userId));
      await tx.delete(libraries).where(eq(libraries.userId, userId));
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      await tx.delete(accounts).where(eq(accounts.userId, userId));
      await tx.delete(users).where(eq(users.id, userId));
    });
  } catch (err) {
    // 6) Transaction failed → it rolled back; DO NOT sign out; return a generic
    //    500 with NO internal detail (this endpoint must not leak schema/query
    //    details to a caller whose delete just failed). PRD §8.4 "不上 APM" —
    //    console.error is the whole error-observability budget (matches
    //    lib/usage/record.ts).
    console.error('[account/delete] transaction failed; rolled back', {
      userId,
      err,
    });
    return NextResponse.json(
      { error: 'Account deletion failed' },
      { status: 500 },
    );
  }

  // 5) Sign out AFTER a successful commit. The DB deletion succeeding is what
  //    `{ deleted: true }` asserts; clearing the session cookie is a best-effort
  //    side effect. The user's sessions row was already deleted above, so the
  //    adapter's session lookup is a no-op — but wrap defensively anyway: a
  //    failure to clear the cookie must NOT report a successful deletion as
  //    failed to the caller, while still surfacing the problem to server logs.
  try {
    await signOut({ redirect: false });
  } catch (err) {
    console.error(
      '[account/delete] deletion committed but signOut failed to clear the session',
      { userId, err },
    );
  }

  return NextResponse.json({ deleted: true });
}
