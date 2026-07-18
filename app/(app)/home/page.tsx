// Placeholder authenticated-area landing page (FND-09). 03-library (Library page,
// /library) and 04-fit (Jobs pages, /jobs) land the real authenticated-area content
// in later modules — this file exists only to prove the (app) route group's
// middleware protection (middleware.ts, FND-08) works end to end. Lives at /home,
// not bare `/`, because app/(app)/page.tsx (the ticket's literal File-scope path)
// would resolve to the exact same URL as the public app/page.tsx and fail
// `next build` with Next's "two parallel pages resolve to the same path" error
// (E28) — see docs/plans/FND-09.md §0.5 for the verified root cause.
export default function AuthenticatedHome() {
  return <p>Signed in. Library and Jobs pages land in later modules.</p>;
}
