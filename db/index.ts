import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

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
