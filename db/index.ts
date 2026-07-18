import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePool } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

import * as schema from './schema';

// Fail fast at import time if the database URL is missing — a clear error beats a
// silently-undefined client that only explodes at the first query. See
// .env.example for the expected variable.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Set it in your environment (see .env.example) before importing db/index.ts.',
  );
}

// `neon-http` is the zero-persistent-connection driver, a good fit for Vercel
// serverless single-query-per-request work. `neon()` is lazy (no eager connect),
// so constructing here does not touch the network. Trade-off: neon-http does not
// support real multi-statement interactive transactions — if a future ticket
// (e.g. PLT-01's hard account-delete) needs cross-table atomicity, it may swap
// this one file to `neon-serverless`; the db/schema.ts table objects are
// driver-independent and would not change.
const sql = neon(connectionString);

export const db = drizzle(sql, { schema });

// Transaction-capable client (ADDITIVE — the `db` export above is unchanged in
// both shape and behavior). PLT-01's account hard-delete needs cross-table
// atomicity ("within ONE DB transaction", ticket Deliverable 2b), which the
// neon-http `db` above CANNOT provide: `neon-http`'s `.transaction()` throws
// unconditionally ("No transactions support in neon-http driver"). This is the
// exact swap the `db` comment above pre-authorized. `neon-serverless` is a
// Pool-based driver with real interactive BEGIN/COMMIT/ROLLBACK transactions —
// the SAME abstract `.transaction(async (tx) => …)` API PGlite implements, so
// the delete route's code path is black-box-identical between production
// (`dbTx`) and tests (a PGlite instance mocked in for `dbTx`).
//
// `ws` is passed explicitly so this works regardless of whether the runtime
// Node.js version exposes a native global `WebSocket` (Node >=22 does; older /
// unknown edge runtimes may not) — removes an environment-dependent unknown
// rather than relying on it. `drizzle({ connection, ws, schema })` internally
// sets `neonConfig.webSocketConstructor = ws` (verified against the installed
// neon-serverless driver). The `Pool` is lazy — it opens no socket until the
// first query — so constructing here (like `db`) touches no network, and the
// DATABASE_URL fail-fast above still guards both exports identically.
//
// ONLY the account-delete route uses `dbTx`; every other call site keeps `db`.
export const dbTx = drizzlePool({
  connection: connectionString,
  ws,
  schema,
});
