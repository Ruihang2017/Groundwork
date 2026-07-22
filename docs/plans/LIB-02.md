# Implementation plan — LIB-02: Library + resume persistence API and query helpers

Ticket: [docs/prd/03-library/tickets/LIB-02-persistence-api.md](../prd/03-library/tickets/LIB-02-persistence-api.md)
Sub-PRD: [docs/prd/03-library/README.md](../prd/03-library/README.md)
Master spec: [docs/PRD.md](../PRD.md) §5.1 (PARSE row — "草稿必须经用户确认才成为库"), §5.5 (server-side Zod trust boundary; layers 1 and 3 consume this ticket's data), §5.6 (`Library`/`Resume` shapes; "库为资产：写操作留 `updatedAt`，删除为软删防手滑"), §5.7 ("无库时禁止新建 job"), §8.1 ("原始文件解析后即弃、不落盘——只存 markdown 与结构化库"), §8.3 (session-scoped queries, "无跨用户查询路径")
Upstream tickets whose merged code this builds on: [FND-05 (Drizzle schema / `db/index.ts`)](../prd/01-foundation/tickets/FND-05-drizzle-schema-neon.md), [FND-08 (`requireUserId`)](../prd/01-foundation/tickets/FND-08-authjs-session.md), [FND-02 (`Library`/`Resume` Zod)](../prd/01-foundation/tickets/FND-02-core-entity-schemas.md), [LIB-01 (PARSE route — the producer of this ticket's input)](../prd/03-library/tickets/LIB-01-parse-route.md)
ADRs: none exist (`docs/adr/` contains only `.gitkeep`). This plan raises **two ADR candidates** — see §6. Do **not** create them as part of this ticket.
Base commit: `ad12743` on `main`, working tree clean at planning time (2026-07-22). Branch per repo convention: `ticket/LIB-02`.

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone. Every "verified" claim below was checked by direct inspection or by running the code at planning time — confirm cheaply if you like, but do not re-derive.

**Standing environment rules on this machine** (carried from `docs/plans/ISS-30.md` / `docs/plans/LIB-01.md`, re-verified this session):

- Invoke pnpm as **`corepack pnpm ...`** — bare `pnpm` is not on the Bash tool's `PATH`. `node_modules/.bin/vitest run` also works and is what the baseline below was measured with.
- Every Bash invocation prints a harmless first line `/c/Users/HoraceHou/.bash_profile: line 1: $'\377\376source': command not found`. That is the user's UTF-16-BOM'd `~/.bash_profile`, **not** a repo file. Ignore it.
- `.gitattributes` is `* text=auto eol=lf` (ISS-30) — new files are materialized LF. Do not add CRLF.

---

## 0. Repo-state check performed for this plan (verified 2026-07-22 at `ad12743`)

**Baseline `pnpm test` is GREEN: 40 files / 366 tests, ~16s.** Record this number. Your final run must be ≥ these counts and still green.

Dependencies — all merged, all read directly for this plan:

- **FND-05 → `db/schema.ts`** exports `libraries` and `resumes` exactly as this ticket needs:
  - `libraries`: `id` (text PK, uuid default), `userId` (text, FK → `users.id` `ON DELETE cascade`), `profile` (`jsonb().$type<Profile>()`, NOT NULL), `projects` (`jsonb().$type<Project[]>()`, NOT NULL, default `[]`), `createdAt`/`updatedAt` (`bigint({mode:'number'})`, epoch-ms), `deletedAt` (`bigint`, **nullable** — the soft-delete column, `libraries`-only).
  - `resumes`: `id`, `userId` (same FK), `sourceMd` (text NOT NULL), `updatedAt` (`bigint`, epoch-ms). No `createdAt`, no `deletedAt` — matches FND-02's `Resume` shape.
  - `updatedAt` on both tables carries `.$onUpdate(() => Date.now())`. **Verified by running it** (drizzle 0.45.2 + PGlite): a `.update().set({...})` that does *not* mention `updatedAt` still bumps it, and leaves `createdAt` untouched. `$onUpdate` also applies inside `onConflictDoUpdate` (`pg-core/query-builders/insert.js:149` reuses `buildUpdateSet`) — irrelevant here, see the next bullet.
  - **There is NO unique constraint on `libraries.userId` or `resumes.userId`** — `db/migrations/0000_legal_pandemic.sql` creates only plain btree indexes `libraries_user_id_idx` / `resumes_user_id_idx`. Verified by inserting two rows for the same `user_id`: both persist. **`onConflictDoUpdate(target: userId)` is therefore NOT available** to you; the upsert must be read-then-insert-or-update (§2.2), and the concurrency consequence is §4 R1.
- **FND-05 → `db/index.ts`** exports two clients, both lazily constructed (no network at import):
  - `db` — `drizzle-orm/neon-http`. **Cannot do multi-statement transactions** (`.transaction()` throws "No transactions support in neon-http driver").
  - `dbTx` — `drizzle-orm/neon-serverless` (Pool + `ws`). Real `BEGIN/COMMIT/ROLLBACK`. This is what `confirmLibraryImport` must use.
  - `db/index.ts` **throws at import time when `DATABASE_URL` is unset** (intentional fail-fast, covered by `db/index.test.ts`). This is the FND-08 build-breaker class of bug — see §2.1 and §4 R8.
  - Its comment says *"ONLY the account-delete route uses `dbTx`; every other call site keeps `db`."* — this ticket makes that sentence stale. `db/index.ts` is `01-foundation`-owned (`docs/prd/breakdown-plan.md` §3): **do not edit it.** See §5 Q4.
- **FND-08 → `lib/auth/session.ts`** exports `requireUserId(): Promise<string>` and `UnauthorizedError`. Catch by `instanceof`, return HTTP 401 `{ error: 'Unauthorized' }` (the exact body both existing routes use).
- **FND-02 → `lib/schemas/entities.ts`** exports `Library` (`{ profile: Profile, projects: Project[] }`), `Resume` (`{ sourceMd: string, updatedAt: number }`), `Profile`, `Project`, `PROJECT_ID_PATTERN`. `Project` requires all of `id/name/stage/role/stack/summary/metrics/tags`; `Project.id` must match `^[a-z0-9]+(-[a-z0-9]+)*$`. `Profile.contact.links` has `.default([])` — a parse can therefore *add* that key (§4 R11). Zod v4 objects **strip unknown keys by default** — this is load-bearing for the trust boundary (§4 S1).
- **LIB-01 → `app/api/parse/route.ts`** (merged) returns `{ resumeMd, draftLibrary }` and persists nothing. LIB-03 will pass those two values straight into this ticket's `POST` (LIB-03 ticket, Deliverable 2).
- **Downstream consumers whose call shapes are already fixed in their tickets** — do not rename these:
  - `04-fit`/FIT-01 `POST /api/jobs` step (b): `hasLibrary(userId)` → 403 `{ error: 'no_library' }` when false.
  - `04-fit`/FIT-03 `app/(app)/jobs/page.tsx`: `hasLibrary(userId)` **from a React Server Component**.
  - `05-tailor`/TLR-01: `getLibrary(userId)` and `getResume(userId)`, then reads `resume.sourceMd`.
  - `03-library`/LIB-03 `app/(app)/library/page.tsx`: `getLibrary`/`getResume` **from a React Server Component**; `_components/draft-confirm.tsx` `POST`s `{ library, resumeMd }`.
- **`vitest.config.ts` needs NO change.** `include` already covers `lib/**/*.test.ts` and `app/**/*.test.{ts,tsx}` — both of this ticket's test locations. **Do not append a glob** (every FND/EVL ticket had to; this one does not).
- **`package.json` needs NO change.** `@electric-sql/pglite@^0.5.4` is already a devDependency and is the established test-Postgres substitute (`db/migrate.test.ts` Tier 3, `lib/config/quota.test.ts`, `app/api/account/delete/route.test.ts`). No new dependency of any kind.
- **`lib/db/` does not exist yet.** `lib/db/queries/library.ts` is the **first file** in what will become a five-file convention (`jobs.ts`, `tailored-resumes.ts`, `briefs.ts`, `admin.ts` are already allocated to 04/05/06/07 in `breakdown-plan.md` §3). See §6 ADR candidate A1.
- **File ownership (breakdown-plan §3)**: `app/api/library/route.ts` + `lib/db/queries/library.ts` belong to `03-library`. `db/schema.ts`, `db/index.ts`, `db/migrations/**`, `lib/schemas/**`, `lib/auth/session.ts`, `vitest.config.ts`, `package.json` all belong to `01-foundation` — **read/import only**.
- **Serial-safety**: `git branch -a` lists only `main` plus already-merged `ticket/*` branches; no `ticket/LIB-02` or `ticket/LIB-03` exists; `app/api/library/` and `lib/db/` do not exist. Nothing is in flight against any file this ticket touches. If that has changed at build time, stop and escalate.
- **Empirically verified at planning time, so you do not have to discover them** (drizzle-orm 0.45.2 + `@electric-sql/pglite` 0.5.4 = PostgreSQL 18.3):
  1. `tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`)` runs fine inside a drizzle transaction on PGlite; `hashtext` exists.
  2. A throw inside `db.transaction(...)` rolls back **both** table writes made before it.
  3. jsonb round-trips `{profile, projects}` unchanged.
  4. **A NUL character (U+0000) inside a string is rejected by Postgres** — `invalid byte sequence for encoding "UTF8": 0x00` for a `text` column, `unsupported Unicode escape sequence` for `jsonb`. An authenticated client can send one in JSON. Unless you reject it at the boundary it is an unhandled 500 (§2.3 step 3, §4 R3).
  5. `PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>` type-checks as a common supertype of the neon-http `db`, the neon-serverless `dbTx`, a PGlite client, **and** the `tx` handed to `.transaction()`. The exact function bodies in §2.2 were compiled against the real repo types with zero errors before this plan was written.

---

## 1. Scope

### In scope (exactly four files, all new)

- `lib/db/queries/library.ts` — `getLibrary`, `hasLibrary`, `upsertLibrary`, `getResume`, `upsertResume`, `confirmLibraryImport`.
- `lib/db/queries/library.test.ts` — the query layer's machine-checkable acceptance surface.
- `app/api/library/route.ts` — `GET` + `POST`.
- `app/api/library/route.test.ts` — the route's machine-checkable acceptance surface.

### Explicitly out of scope — do not implement, even opportunistically

- **No schema change and no migration.** Do not add a UNIQUE constraint, a version column, or any column. `db/schema.ts` and `db/migrations/**` are `01-foundation`-owned. The missing unique constraint is real (§4 R1) and is escalated as §5 Q1 — not fixed here.
- **No edit to `db/index.ts`**, including its now-stale "only account-delete uses `dbTx`" comment (§5 Q4).
- **No delete endpoint of any kind** (no soft delete, no hard delete). `libraries.deletedAt` is *read* (filtered on) but never written. Account-level hard delete already exists and belongs to PLT-01.
- **No per-project REST endpoints.** The whole `Library` object is submitted in one `POST` (ticket Non-goals).
- **No resume-only update endpoint.** `resumeMd` is only ever written together with a `Library` confirmation.
- **No optimistic locking / `version` column / ETag / If-Match.** Ticket Feedback obligation #2 forbids adding one silently; the accepted risk must be *recorded* instead (§2.2 header comment + your Deviations note).
- **No UI.** `app/(app)/library/**` is LIB-03.
- **No `vitest.config.ts`, `package.json`, `tsconfig.json`, `.env.example` change.**
- **No LLM call, no `recordUsage()`, no quota/breaker check.** This ticket spends nothing; `usage_events` is not touched. (PARSE already recorded its usage; a confirm is free.)
- **No `lib/schemas/**` addition.** `Library`/`Resume` already exist; the request-body schema is module-local (defined in the route file), per breakdown-plan §3's "module-local Zod types live in your own module directory".

---

## 2. Change list

### 2.1 The one architectural decision that shapes both files: where `@/db/index` is imported

`db/index.ts` throws at import time without `DATABASE_URL`, and CI runs `pnpm build` with no `DATABASE_URL`. `next build`'s "Collecting page data" phase statically imports every `app/api/**/route.ts` **and every page module** — including the React Server Components that LIB-03 (`app/(app)/library/page.tsx`) and FIT-03 (`app/(app)/jobs/page.tsx`) will write around `getLibrary`/`hasLibrary`.

Existing repo precedent (`lib/config/quota.ts`, `lib/usage/record.ts`) is *static* `import { db } from '@/db/index'` in the lib module + *lazy* `await import(...)` at each route. That works because those two modules are only ever reached from route handlers. **This module is different: two future server components import it directly.** Making every one of four future consumers remember the lazy-import trick is the exact foot-gun FND-08 already shipped and had to bounce-fix.

**Decision (deliberate, documented divergence from quota.ts/record.ts — put this reasoning in the file header comment so the Reviewer sees it was a choice):**

- `lib/db/queries/library.ts` has **no top-level `@/db/index` import**. Each function resolves its client with `await import('@/db/index')` at call time. The module is therefore import-safe with no environment at all, and downstream tickets may import it statically from a page or a route.
- Do **not** cache the resolved client in a module-level variable — the ESM module cache already makes the dynamic import a map lookup, and a local cache would leak one test's PGlite instance into the next test.
- `app/api/library/route.ts` **still** imports the query module lazily inside each handler, matching `app/api/parse/route.ts` and `app/api/account/delete/route.ts`. Belt and braces: it keeps the established regression guard (§3 test R9) meaningful even if a future edit reintroduces a top-level `db` import in the query module.
- `@/db/schema` (table objects only, no connection) and `drizzle-orm` are safe to import statically anywhere.

### 2.2 `lib/db/queries/library.ts`

Header comment must state, in substance: what this module owns (the only write path to `libraries`/`resumes`); the PRD anchors (§5.1 confirmation rule, §5.6 asset/updatedAt rule, §8.3 userId scoping); the §2.1 lazy-import rule and *why*; the accepted last-write-wins risk (verbatim sentence below); and that `confirmLibraryImport` is the only write entry point the app calls in v1.

The accepted-risk sentence, recorded verbatim per ticket Feedback obligation #2:

> Accepted for v1: last-write-wins on `POST /api/library`, single-user single-session usage pattern assumed, no PRD requirement for concurrent-edit protection.

Imports (all static, all DB-connection-free):

```ts
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from '@/db/schema';
import { libraries, resumes } from '@/db/schema';
import { Library, type Resume } from '@/lib/schemas/entities';
```

The executor type + the client resolver (both verified to compile):

```ts
/**
 * The common supertype of every Drizzle client this module can run against:
 * the neon-http `db`, the neon-serverless `dbTx`, a `tx` handed to
 * `.transaction()`, and the PGlite client the tests inject. Exported so a
 * caller can pass its own transaction handle in (see `confirmLibraryImport`).
 */
export type Executor = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

async function defaultDb(): Promise<Executor> {
  const { db } = await import('@/db/index'); // lazy — see file header
  return db;
}
```

Functions — the ticket's Deliverable 1 signatures, each with an **additive optional** `executor` parameter on the two upserts (still callable exactly as the ticket specifies; it exists so `confirmLibraryImport` can run them inside its transaction, and this is what lets one implementation serve both the standalone and the transactional path):

```ts
export async function getLibrary(userId: string): Promise<Library | null>
export async function hasLibrary(userId: string): Promise<boolean>
export async function upsertLibrary(userId: string, library: Library, executor?: Executor): Promise<void>
export async function getResume(userId: string): Promise<Resume | null>
export async function upsertResume(userId: string, sourceMd: string, executor?: Executor): Promise<void>
export async function confirmLibraryImport(userId: string, library: Library, resumeMd: string): Promise<void>
```

Bodies — this is the exact shape that was type-checked against the repo; deviate only with a recorded reason:

```ts
export async function getLibrary(userId: string): Promise<Library | null> {
  const db = await defaultDb();
  const [row] = await db
    .select()
    .from(libraries)
    .where(and(eq(libraries.userId, userId), isNull(libraries.deletedAt)))
    .orderBy(desc(libraries.updatedAt))   // duplicate-tolerant: newest wins (§4 R1)
    .limit(1);
  if (!row) return null;

  const parsed = Library.safeParse({ profile: row.profile, projects: row.projects });
  if (!parsed.success) {
    // Paths only — a jsonb value here is a real person's resume data (PII).
    console.error('[library] stored libraries row does not match the Library schema', {
      userId,
      issues: parsed.error.issues.map((i) => i.path.join('.')),
    });
    throw new Error('Stored library row does not match the Library schema');
  }
  return parsed.data;
}
```

- **Why re-validate on read** (decision, not an accident): `db/schema.ts`'s own convention comment says `.$type<T>()` is compile-time only — "Postgres validates 'is valid JSON', NOT 'matches the Zod shape'". A drifted row (e.g. after a future FND-02 field addition) must fail loudly here rather than flow into TLR-01's tailoring as a half-shaped object. Failing loud is deliberately preferred over returning `null`, which would tell the user "you have no library" and invite them to create a second one.
- **Why `getResume` does *not* Zod-parse**: `sourceMd`/`updatedAt` are NOT NULL scalar columns whose Drizzle types already guarantee `string`/`number` — there is no jsonb shape to drift. State this asymmetry in a comment so it doesn't read as an oversight.

```ts
export async function hasLibrary(userId: string): Promise<boolean> {
  const library = await getLibrary(userId);
  return library !== null && library.projects.length > 0;
}
```

- PRD §5.7 gating semantics, per the ticket: an existing-but-empty library is **not** "has a library". Reusing `getLibrary` (rather than a bespoke `COUNT`) keeps one definition of "the user's current library row" — at one row per user the cost is irrelevant.

```ts
export async function getResume(userId: string): Promise<Resume | null> {
  const db = await defaultDb();
  const [row] = await db
    .select({ sourceMd: resumes.sourceMd, updatedAt: resumes.updatedAt })
    .from(resumes)
    .where(eq(resumes.userId, userId))
    .orderBy(desc(resumes.updatedAt))
    .limit(1);
  return row ? { sourceMd: row.sourceMd, updatedAt: row.updatedAt } : null;
}
```

```ts
export async function upsertLibrary(userId: string, library: Library, executor?: Executor): Promise<void> {
  const db = executor ?? (await defaultDb());
  const [existing] = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(and(eq(libraries.userId, userId), isNull(libraries.deletedAt)))
    .orderBy(desc(libraries.updatedAt))
    .limit(1);

  if (existing) {
    await db
      .update(libraries)
      .set({ profile: library.profile, projects: library.projects }) // updatedAt via $onUpdate
      .where(and(eq(libraries.id, existing.id), eq(libraries.userId, userId)));
    return;
  }
  await db.insert(libraries).values({ userId, profile: library.profile, projects: library.projects });
}
```

- **Never set `updatedAt` by hand** — `$onUpdate`/`$defaultFn` own it (verified working). Never set `createdAt` on the update path.
- **The `WHERE` keeps `eq(userId)` even though `id` is the primary key** — defense in depth for PRD §8.3: no statement in this module may be able to touch another user's row even if an id were ever wrong.
- **`isNull(deletedAt)` in the lookup** means a soft-deleted row is never resurrected or overwritten; a confirm after a (future) soft delete inserts a fresh active row and leaves the tombstone alone. No delete path exists in v1, so this is forward-compatibility, not live behavior — say so in a comment.

`upsertResume` is the same shape without the `deletedAt` filter, setting `{ sourceMd }`.

```ts
export async function confirmLibraryImport(userId: string, library: Library, resumeMd: string): Promise<void> {
  const { dbTx } = await import('@/db/index'); // neon-serverless: `db` (neon-http) CANNOT do transactions
  await dbTx.transaction(async (tx) => {
    // Serializes concurrent confirmations for THIS user only. Not optimistic
    // locking and NOT a change to last-write-wins semantics (that stays accepted,
    // see header): it exists solely so two simultaneous confirms cannot both find
    // "no row" and both INSERT — there is no UNIQUE constraint on userId to stop
    // them (see docs/plans/LIB-02.md §4 R1 / §5 Q1). Transaction-scoped: released
    // on COMMIT or ROLLBACK, always the same single lock, so it cannot deadlock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
    await upsertLibrary(userId, library, tx);
    await upsertResume(userId, resumeMd, tx);
  });
}
```

- Both writes or neither — the ticket's Deliverable 1 requirement, because TLR-01's number-integrity check is only sound when `Library` and `Resume.sourceMd` are in sync.
- `upsertLibrary`/`upsertResume` called standalone (no `executor`) do **not** take the lock. That is acceptable because nothing in v1 calls them standalone — the route only calls `confirmLibraryImport`. Say that in a comment so a future caller knows what it is opting out of.

### 2.3 `app/api/library/route.ts`

Header comment must state: the wire contract (below); that `userId` comes exclusively from the session (PRD §8.3); the lazy-import build-safety rule (§2.1) and that it is the FND-08 bug class; and the `Cache-Control: no-store` reason (the body is the user's resume).

```
export const runtime = 'nodejs';
```

Explicit, with the reason in a comment: `dbTx` is neon-serverless and needs the `ws` package — an Edge migration would break it silently. (Node is also the default; this is a guard, not a change.)

Wire contract — **LIB-03 codes against this, do not improvise**:

```
GET  /api/library
  200 { "library": Library | null, "resumeMd": string | null }   Cache-Control: no-store
  401 { "error": "Unauthorized" }
  500 { "error": "library_read_failed" }

POST /api/library      Content-Type: application/json
  body { "library": Library, "resumeMd": string }
  200 { "library": Library, "resumeMd": string }                 Cache-Control: no-store
  400 { "error": "invalid_body", "issues": string[] }            issues are Zod PATHS + messages, never values
  401 { "error": "Unauthorized" }
  500 { "error": "library_write_failed" }
```

200-with-nulls on `GET` for a user with no library is explicit in the ticket: the client distinguishes "no library yet" from an error via the null fields, not via HTTP status.

Module-local body schema + guards (defined in this file — module-local Zod belongs in the module, per breakdown-plan §3):

```ts
// LIB-01 caps its own pasted-text input at 100_000 chars, so no legitimate
// PARSE output can approach this. It is a DB-bloat/DoS guard on an endpoint that
// otherwise accepts unbounded authenticated text, not a product limit.
const MAX_RESUME_MD_CHARS = 200_000;

const LibraryPostBody = z.object({
  library: Library,
  resumeMd: z.string().max(MAX_RESUME_MD_CHARS),
});
```

`z.object` strips unknown keys, so a client-supplied `userId`/`id`/`deletedAt` in the body is silently dropped and can never reach a query — that is the trust boundary, and §3 test R8 pins it.

NUL-character guard (verified necessary — Postgres rejects U+0000 in both `text` and `jsonb`; without this the endpoint 500s on a one-character payload):

```ts
const NUL = String.fromCharCode(0); // U+0000 — see plan §4 R3
function hasNulByte(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (Array.isArray(value)) return value.some(hasNulByte);
  if (value && typeof value === 'object') return Object.values(value).some(hasNulByte);
  return false;
}
```

`GET` handler order (follow literally):

1. `requireUserId()` inside try/catch → `UnauthorizedError` ⇒ 401 `{ error: 'Unauthorized' }`, **zero DB calls**; rethrow anything else.
2. `const { getLibrary, getResume } = await import('@/lib/db/queries/library');` (lazy — §2.1).
3. `const [library, resume] = await Promise.all([getLibrary(userId), getResume(userId)]);` inside try/catch → on throw, `console.error('[library] read failed', { userId, name, message })` and 500 `{ error: 'library_read_failed' }`.
4. 200 `{ library, resumeMd: resume?.sourceMd ?? null }` with `Cache-Control: no-store`.

`POST` handler order:

1. `requireUserId()` — same as above. **Before the body is read**, so an unauthenticated caller costs nothing.
2. `const body = await req.json().catch(() => null);` — malformed JSON / wrong content-type must land in the same 400, never an unhandled throw.
3. `LibraryPostBody.safeParse(body)`; on failure → 400 `{ error: 'invalid_body', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }`. Then `hasNulByte(parsed.data)` → the same 400 with `issues: ['body: contains a NUL character']`. **No DB call on either path** (§3 test R5 asserts zero calls).
4. `const { confirmLibraryImport } = await import('@/lib/db/queries/library');` then `await confirmLibraryImport(userId, parsed.data.library, parsed.data.resumeMd)` in try/catch → on throw, log **name + message only** and return 500 `{ error: 'library_write_failed' }`.
   - **Do not log the error object or the query/params** (this diverges from `app/api/account/delete/route.ts`, which logs `{ userId, err }` — say so in the comment). A failing insert here carries the user's whole resume in its parameters; a Drizzle/pg error can echo them into the log. Log `err instanceof Error ? err.name : 'unknown'` and `err.message`.
5. 200 `{ library: parsed.data.library, resumeMd: parsed.data.resumeMd }` with `Cache-Control: no-store` — the Zod-parsed values *are* what was persisted, so this needs no second round-trip.

Export only `GET` and `POST`; Next.js answers other methods with 405 by itself.

### 2.4 What must not change

`db/**`, `lib/schemas/**`, `lib/auth/**`, `lib/config/**`, `lib/usage/**`, `lib/validation/**`, `auth*.ts`, `middleware.ts` (`/api/**` is deliberately excluded from the matcher — every API route enforces its own auth), `app/api/parse/**`, `app/(app)/**`, `vitest.config.ts`, `package.json`, `pnpm-lock.yaml`, `.env.example`. Read/import only.

---

## 3. Test plan

Both files use the established PGlite pattern (`lib/config/quota.test.ts`, `app/api/account/delete/route.test.ts`): `new PGlite()` → `drizzle(client, { schema })` → `migrate(db, { migrationsFolder: './db/migrations' })` → `vi.resetModules()` + `vi.doMock('@/db/index', () => ({ db: testDb, dbTx: testDb }))` → dynamic `import()` of the module under test.

Two non-negotiable mechanics, both learned the hard way in this repo:

- **Per-test timeout.** Copy `app/api/account/delete/route.test.ts`'s ISS-29 fix: a file-level `const PGLITE_TEST_TIMEOUT_MS = 30_000;` passed as the **third argument of every `it()`** that touches PGlite. Vitest binds a task's timeout at collection time, so `vi.setConfig` in a hook is a silent no-op. Under full-suite load the 5000ms default is not enough for a PGlite boot + migration.
- **One PGlite per file, not per test** (`beforeAll`), with a **fresh `crypto.randomUUID()` userId per test** for isolation — the pattern `lib/config/quota.test.ts` uses. The per-test-instance style in `app/api/account/delete/route.test.ts` costs 14.4s for nine tests; do not add another file like that. Each test seeds its own `users` row first (FK).

### `lib/db/queries/library.test.ts`

| # | Test | Pins |
|---|---|---|
| Q1 | `hasLibrary` → `false` for a user with no `libraries` row | acceptance 1 |
| Q2 | `hasLibrary` → `false` for a row with `projects: []` (seeded directly via Drizzle) | acceptance 2 |
| Q3 | `hasLibrary` → `true` after `confirmLibraryImport` with a non-empty `projects` | acceptance 3 |
| Q4 | `getResume` returns the submitted `sourceMd` **verbatim** after `confirmLibraryImport`. Use adversarial content: CJK, an emoji, a `\r\n`, a markdown code fence with backticks, a `$1`-looking token, a `'`-quote, and a ~50 KB tail. Assert strict `toBe` equality, not `toContain` | acceptance 4; TLR-01's P0 dependency |
| Q5 | **Atomicity.** Wrap the injected client in a Proxy modelled on `withFailingDeleteOn` in `app/api/account/delete/route.test.ts`: inside `.transaction()`, make `tx.insert`/`tx.update` throw when `getTableName(t) === 'resumes'`. Seed a pre-existing library+resume, call `confirmLibraryImport` with new content, expect it to reject, then assert **both** rows are identical to before (content *and* `updatedAt`) | acceptance 5 |
| | *(Why not "mock `upsertResume` to throw" as the ticket words it: `confirmLibraryImport` calls it as a local binding inside the same ESM module, so an external module-mock cannot intercept it. Failing the underlying write is the same scenario and additionally proves a real Postgres ROLLBACK. Record this as a deviation-in-mechanism, not in intent.)* | |
| Q6 | Two sequential `confirmLibraryImport` calls for one user ⇒ **exactly one** `libraries` row and one `resumes` row (`db.select()...where(eq(userId))` length 1 on both), content = the second call's, and `updatedAt` strictly greater than after the first call. **Force a clock gap** between the calls (`await new Promise(r => setTimeout(r, 5))`) — `$onUpdate` is client-side `Date.now()` with ms resolution, so two calls in the same millisecond would flake | acceptance 6 |
| Q7 | Cross-user isolation: seed users A and B with distinct library+resume content via `confirmLibraryImport`; assert `getLibrary`/`getResume`/`hasLibrary` for A never return B's data and vice versa (both tables) | acceptance 8 (query half) |
| Q8 | `getLibrary` and `getResume` → `null` for an unknown userId; `hasLibrary` → `false` | ticket Goal ("or 404-equivalent null state") |
| Q9 | Soft delete is respected: seed a library row with `deletedAt` set ⇒ `getLibrary` → `null`, `hasLibrary` → `false`; a subsequent `upsertLibrary` inserts a **new active** row and leaves the tombstone's `deletedAt` and content untouched | §2.2 / §4 R5 |
| Q10 | `upsertLibrary` / `upsertResume` standalone (no executor argument, so they resolve `db` themselves): insert-then-update path works and bumps `updatedAt`; `createdAt` unchanged on the library update | Deliverable 1 |
| Q11 | `getLibrary` **rejects** when the stored jsonb does not match `Library` (seed `profile: {}` — `name` is required — directly via Drizzle) | §2.2 decision |
| Q12 | The advisory lock is actually issued: Proxy the client so `tx.execute` calls are recorded, and assert one recorded SQL contains `pg_advisory_xact_lock`. **This is a structural assertion, not a proof of mutual exclusion** — PGlite is single-connection so real concurrency cannot be tested here; say so in the test's comment | §4 R1 |

### `app/api/library/route.test.ts`

`@/auth` is mocked file-wide via `vi.hoisted` (stable references across `vi.resetModules()`), exactly as in `app/api/parse/route.test.ts`. Two loader helpers:

- `loadRouteWithMockedQueries(mocks)` — `resetModules` + `doMock('@/lib/db/queries/library', …vi.fn()s)`; for call-count assertions.
- `loadRouteWithRealQueries(testDb)` — `resetModules` + `doUnmock('@/lib/db/queries/library')` + `doMock('@/db/index', () => ({ db: testDb, dbTx: testDb }))`; for end-to-end assertions through real SQL.

| # | Test | Pins |
|---|---|---|
| R1 | `GET` unauthenticated (`auth()` → `null`) ⇒ 401 `{ error: 'Unauthorized' }`, and the mocked `getLibrary`/`getResume` were called **zero** times | §8.3 |
| R2 | `GET` for a user with nothing ⇒ 200 `{ library: null, resumeMd: null }` (real queries + PGlite) | ticket Deliverable 2 |
| R3 | `POST` then `GET` (real queries) ⇒ the `GET` returns the persisted library and `resumeMd`; response `Cache-Control` is `no-store` | Deliverables 1–2 |
| R4 | **Cross-user isolation through the route** (real queries): seed user A's library+resume, set the session to user B who has their own distinct rows, `GET` ⇒ only B's data; then session = a third user with no rows ⇒ nulls. Proves `WHERE userId = ?` is actually applied on both tables | acceptance 8 |
| R5 | `POST` with each of these bodies ⇒ 400 `{ error: 'invalid_body', issues: [...] }` **and `confirmLibraryImport` called zero times** (mocked): (a) `{}`; (b) `{ library: <valid>, resumeMd: 42 }`; (c) a library whose `projects[0].id` is `Not_KebabCase`; (d) a library with `profile` missing `name`; (e) `resumeMd` of `MAX_RESUME_MD_CHARS + 1` chars; (f) a `resumeMd` containing a U+0000 character (`String.fromCharCode(0)`); (g) a U+0000 character inside `library.profile.name`; (h) a request whose body is not JSON at all | acceptance 7; §4 R3/R4 |
| R6 | `POST` unauthenticated ⇒ 401 and `confirmLibraryImport` called zero times | §8.3 |
| R7 | `POST` happy path (real queries) ⇒ 200, body echoes `{ library, resumeMd }`, and both DB rows exist with the submitted content | Deliverables 1–2 |
| R8 | **Trust boundary**: `POST` a body with an extra `userId: <other user's id>` key (and an `id`/`deletedAt`) while the session is user A ⇒ 200, the row is written under **A**, and the other user's rows are untouched | §8.3 |
| R9 | **Build guard** (copy `app/api/parse/route.test.ts`'s last test): `vi.stubEnv('DATABASE_URL', '')` + `resetModules` + `doUnmock('@/lib/db/queries/library')`, then `await expect(import('@/app/api/library/route')).resolves.toBeDefined()`, plus the sanity assertion `await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/)` so the test cannot pass merely because the env var happened to be set | §4 R8 |
| R10 | `POST` 500 path: mock `confirmLibraryImport` to reject ⇒ 500 `{ error: 'library_write_failed' }` and the response body contains no resume text | §4 S3 |

Acceptance item 9 (`pnpm test` green) is the whole-suite run in §7.

---

## 4. Risks and edge cases

- **R1 — No UNIQUE constraint on `libraries.userId` / `resumes.userId` (verified: plain btree indexes only, and duplicate rows really do insert).** Two concurrent `POST`s from the same user can both read "no row" and both INSERT, leaving a user with two library rows — worse than last-write-wins, because reads would then flip between two versions and a later confirm would update only one of them. Mitigations inside this ticket's file-scope: (i) `pg_advisory_xact_lock(hashtext(userId))` as the first statement of the confirm transaction; (ii) duplicate-tolerant reads (`ORDER BY updatedAt DESC LIMIT 1`) so even a pre-existing duplicate yields deterministic, newest-wins behavior; (iii) upserts that UPDATE by primary key. The real fix is a UNIQUE constraint + migration in `db/schema.ts`, which is `01-foundation`'s file-scope — escalated as §5 Q1, **not** done here.
- **R2 — Last-write-wins content clobbering between two tabs.** Accepted for v1 per ticket Feedback obligation #2; the verbatim acceptance sentence goes in the module header (§2.2) and in your Deviations note. Do **not** add a version column or ETag. If you believe it is unacceptable, escalate rather than implement.
- **R3 — A NUL character (U+0000) makes Postgres throw (verified).** A `resumeMd` containing one is a single-character 500 from any authenticated client unless the §2.3 guard rejects it first; the same applies to any string nested inside `library` (jsonb rejects it too, with a different message). Rejected at the boundary as a 400.
- **R4 — Unbounded body.** `resumeMd` is capped at 200k chars. `library.projects` is deliberately **not** length-capped (no PRD basis for a number, and the practical bound is the PARSE output the user just confirmed) — a documented accepted risk, not an oversight. A platform-level body-size limit is the right place for a hard cap.
- **R5 — Soft-deleted rows.** `getLibrary`/`upsertLibrary` filter `deletedAt IS NULL`, so a tombstone is never read, resurrected, or overwritten. Unreachable in v1 (no delete endpoint) — kept so a future delete ticket does not have to retrofit it. `resumes` has no `deletedAt` by design (FND-05); rows are overwritten in place.
- **R6 — `updatedAt` is client-side `Date.now()`** (db/schema.ts convention note), not `now()` in the DB. Two writes inside one millisecond produce equal timestamps: the "updatedAt advanced" test must force a clock gap (§3 Q6). Also means `updatedAt` ordering is only as monotone as the app servers' clocks — fine for "newest wins" at this scale, worth knowing.
- **R7 — PGlite test cost (ISS-29).** A PGlite boot + full migration chain exceeds Vitest's 5000ms default under full-suite load. Per-test third-argument timeouts + one instance per file are mandatory (§3), or CI flakes intermittently — the exact failure issue #29 filed.
- **R8 — Build-time `DATABASE_URL` fail-fast.** CI runs `pnpm build` with no `DATABASE_URL`; "Collecting page data" statically imports every route module. §2.1's lazy-import rule plus test R9 is what keeps this ticket from re-shipping the FND-08 bounce bug. Run `corepack pnpm build` locally before you hand off (§7).
- **R9 — `getLibrary` throws on shape drift, and `hasLibrary` inherits it**, so FIT-03's Jobs page would 500 on a corrupted row rather than silently claim "no library". Deliberate (loud beats silently-wrong); flagged for the Reviewer as §5 Q3 with a one-line fallback if they disagree.
- **R10 — `Promise.all` in `GET`.** Two independent reads, no ordering dependency; a rejection in either surfaces as one 500. Do not "optimize" them into a join — `libraries` and `resumes` have no FK to each other and a join would silently drop the library when no resume row exists.
- **R11 — Zod defaults mutate the round-trip.** `Profile.contact.links` has `.default([])`, so a stored `contact` without `links` comes back *with* `links: []`. Harmless and correct, but do not write a test that asserts `getLibrary(...)` deep-equals the raw seeded jsonb in that specific case.
- **R12 — `jsonb` column semantics.** Postgres `jsonb` does not preserve object key order and drops duplicate keys. Assertions must compare parsed objects (`toEqual`), never serialized JSON strings.

**Security-sensitive paths (the Reviewer will check these specifically):**

1. **S1 — Trust boundary.** `userId` comes only from `requireUserId()`. The body schema is `z.object({ library, resumeMd })` and Zod strips unknown keys, so a client-supplied `userId`/`id` cannot reach any query (test R8). No route reads an id from the query string.
2. **S2 — Cross-user isolation on both tables.** Every `select`/`update`/`insert` in the module is `userId`-scoped, and the update statements keep `eq(userId)` alongside the primary key. Tested at both layers (Q7, R4).
3. **S3 — PII in logs.** Never log `resumeMd`, `library` content, or a raw Drizzle/pg error object (its parameters can carry the whole resume). Log `userId`, error `name`/`message`, and Zod issue **paths** only. This is an intentional divergence from `app/api/account/delete/route.ts`'s `{ userId, err }` — comment it so it reads as a decision.
4. **S4 — Response caching.** `Cache-Control: no-store` on every 200 (both handlers): the body is the user's resume, and a shared cache holding it would be a cross-user leak.
5. **S5 — CSRF.** `auth.config.ts` sets no cookie override, so Auth.js v5 defaults apply (`httpOnly`, `sameSite: 'lax'`); a cross-site `POST` carries no session cookie and gets a 401 before any DB access. No extra token needed — same posture LIB-01 documented.
6. **S6 — DoS surface.** Bounded `resumeMd`, no LLM/paid call, no file handling, no URL fetching (no SSRF surface), one short transaction per request.
7. **S7 — Privacy invariant inherited from LIB-01.** This ticket persists markdown and structured library data only — never file bytes, never a path or blob reference (PRD §8.1, and `app/(legal)/privacy/page.tsx` says so publicly). Do not add any "original file" side channel.
8. **S8 — No new auth surface.** `middleware.ts` excludes `/api/**` on purpose; `requireUserId()` in each handler is the only gate. Do not add a middleware matcher entry.

---

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| Q1 | Should `libraries.userId` and `resumes.userId` get **UNIQUE constraints** (new migration, `01-foundation` file-scope)? That would let this module use `onConflictDoUpdate` and would make "one row per user" a DB invariant instead of an application one. Not doable inside this ticket's file-scope. | **Horace** — a follow-up `01-foundation` ticket. Until then this plan's advisory lock + newest-wins reads stand. |
| Q2 | Is `pg_advisory_xact_lock` in scope here, or should this ticket only *document* the duplicate-row race? It is not optimistic locking and does not alter last-write-wins semantics — it only defends the ticket's own "exactly one row" acceptance item. | **Reviewer**, at review time. Mechanical fallback if rejected: delete the one `tx.execute(...)` line and test Q12; everything else is unchanged. |
| Q3 | Should `getLibrary` **throw** (this plan) or return `null` when a stored row fails `Library.safeParse`? Throwing surfaces corruption as a 500 on FIT-03's Jobs page; returning `null` would render "no library yet" and invite a duplicate import. | **Reviewer**. Fallback is one line: replace the `throw` with `return null` and flip test Q11. |
| Q4 | `db/index.ts`'s comment "ONLY the account-delete route uses `dbTx`; every other call site keeps `db`" becomes false with this ticket, but that file is `01-foundation`-owned. Leave it stale (default), or authorize a one-line comment-only edit? | **Reviewer/Horace**. Default: leave it; note the staleness in the Deviations note and in `lib/db/queries/library.ts`'s header. |
| Q5 | Is `MAX_RESUME_MD_CHARS = 200_000` (2× LIB-01's own 100k input cap) the right ceiling, and should `library.projects` get a length cap too? | **Horace**, only if a real resume ever hits it. Documented as accepted (§4 R4), not silently tuned. |

---

## 6. ADR candidates (flagged, **not** decided or implemented here)

- **A1 — the `lib/db/queries/*.ts` convention.** This is the first file of its kind, and `breakdown-plan.md` §3 already allocates `jobs.ts` (FIT-01), `tailored-resumes.ts` (TLR-01), `briefs.ts` (PRP-01/02) and `admin.ts` (PLT-03) to the same directory. Four modules will copy whatever shape lands here: lazy `@/db/index` import inside functions (§2.1), an optional `Executor` parameter so one implementation serves both standalone and in-transaction use, reads on `db` / atomic writes on `dbTx`, and Zod re-validation of jsonb on read. Reversing that after four modules have copied it is expensive — worth `docs/adr/0001-db-query-helper-convention.md` if Horace wants it recorded. **Do not write the ADR in this ticket.**
- **A2 — per-user row identity without a DB-level unique constraint.** Choosing an application-level advisory lock over a schema constraint is a durable architectural choice about where invariants live. If Horace prefers the constraint (§5 Q1), that is a schema ADR plus a migration in `01-foundation`, not a change here.

---

## 7. Build sequence (suggested order; each step ends green)

1. `git checkout -b ticket/LIB-02` from `main` at `ad12743`. Re-run the baseline (`node_modules/.bin/vitest run`) and confirm **40 files / 366 tests** green before touching anything.
2. Write `lib/db/queries/library.ts` (§2.2) — the whole module, header comment included.
3. Write `lib/db/queries/library.test.ts` (§3 Q1–Q12). Run just that file until green. Watch the wall-clock: if the file alone exceeds ~10s, you created a PGlite per test instead of per file.
4. Write `app/api/library/route.ts` (§2.3).
5. Write `app/api/library/route.test.ts` (§3 R1–R10). Run just that file until green.
6. Full `node_modules/.bin/vitest run` — must be **≥ 42 files / ≥ 366 + your new tests**, all green, with no pre-existing test modified.
7. `corepack pnpm lint` and **`corepack pnpm build`** — the build must pass with `DATABASE_URL` unset (that is what CI does). If it fails on a DB import, §2.1 was violated somewhere.
8. Hand off with: the diff summary, the real test output (file/test counts), and a **Deviations note** that must include, at minimum: (a) the verbatim accepted-risk sentence from §2.2; (b) the Q5 atomicity mechanism deviation (Proxy-injected write failure instead of module-mocking `upsertResume`, with the ESM reason); (c) any of §5's open questions you resolved differently from this plan's default, and why; (d) the stale `db/index.ts` comment (§5 Q4) left untouched on purpose.
