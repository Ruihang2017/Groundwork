# Implementation plan — LIB-03: Draft confirm UI + Library page

Ticket: [docs/prd/03-library/tickets/LIB-03-confirm-ui-library-page.md](../prd/03-library/tickets/LIB-03-confirm-ui-library-page.md)
Sub-PRD: [docs/prd/03-library/README.md](../prd/03-library/README.md)
Master spec: [docs/PRD.md](../PRD.md) — §2 P2 (line 48: "库中项目没有 metrics，界面显示 \"no metrics\" 警告"), §3 C1 (line 62: "导入是主路径，手工填写只是补充与深化"), §4 S1 (line 88: "逐条确认/微调"), §5.1 PARSE row (line 104: "草稿必须经用户确认才成为库"；"解析失败 → 引导粘贴纯文本"), §5.5 (server-side trust boundary), §5.6 (`Library`/`Project` shapes; "空数组是合法且被显式展示的状态"), §5.7 Library row (line 179: "导入后草稿确认流；项目无 metrics 时页顶红字盘点 + 卡片级警告"), §5.8 (line 184: **UI 英文** — all UI copy in English), §8.1 ("原始文件解析后即弃、不落盘"), §8.3 (session-scoped identity), §10 P1 (line 291: "3 份 fixture 简历解析正确；空 metrics 状态正确展示")
Upstream tickets whose merged code this builds on: [LIB-01 (`POST /api/parse`)](../prd/03-library/tickets/LIB-01-parse-route.md), [LIB-02 (`GET`/`POST /api/library`, `getLibrary`/`getResume`)](../prd/03-library/tickets/LIB-02-persistence-api.md), [FND-02 (`Library`/`Project` Zod)](../prd/01-foundation/tickets/FND-02-core-entity-schemas.md), [FND-08 (`requireUserId`, middleware gate)](../prd/01-foundation/tickets/FND-08-authjs-session.md), [FND-09 (app shell, jsdom component-test setup)](../prd/01-foundation/tickets/FND-09-app-shell-deploy.md), [EVL-01 (`fixtures/**` corpus)](../prd/02-evaluation/tickets/EVL-01-fixture-corpus.md)
ADRs: none exist (`docs/adr/` contains only `.gitkeep`). This plan raises **one ADR candidate** — see §6. Do **not** create it as part of this ticket.
Base commit: `a9df506` on `main`, working tree clean at planning time (2026-07-23). Branch per repo convention: `ticket/LIB-03`.

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone. Every "verified" claim below was checked by direct inspection or by *running it* at planning time — confirm cheaply if you like, but do not re-derive.

**Standing environment rules on this machine** (carried from `docs/plans/LIB-01.md` / `LIB-02.md`, re-verified this session):

- Invoke pnpm as **`corepack pnpm ...`** — bare `pnpm` is not on the Bash tool's `PATH`. `node_modules/.bin/vitest run` also works and is what the baseline below was measured with.
- Every Bash invocation prints a harmless first line `/c/Users/HoraceHou/.bash_profile: line 1: $'\377\376source': command not found`. That is the user's UTF-16-BOM'd `~/.bash_profile`, **not** a repo file. Ignore it.
- `.gitattributes` is `* text=auto eol=lf` — new files are materialized LF. Do not add CRLF.

---

## 0. Repo-state check performed for this plan (verified 2026-07-23 at `a9df506`)

**Baselines. Record both; your final run must meet or beat them.**

- `node_modules/.bin/vitest run` → **42 files / 404 tests, all green, ~20s.**
- `env -u DATABASE_URL corepack pnpm build` → **green.** Route table currently lists 11 routes, all `ƒ (Dynamic)`. After this ticket it must list a new `ƒ /library` and still be green with `DATABASE_URL` unset (that is exactly what CI does — `.github/workflows/ci.yml` runs `pnpm test` then `pnpm build` with no DB secrets).

### Dependencies — merged, and read directly for this plan

**LIB-01 → `app/api/parse/route.ts` (merged).** Wire contract, transcribed from its own header comment (do not improvise against it):

```
POST /api/parse, Content-Type: application/json
  body { "text": "<pasted resume>" }
POST /api/parse, multipart/form-data
  field `file` = the PDF or DOCX   (or field `text` for pasted text)

200  { "resumeMd": string, "draftLibrary": Library }     Cache-Control: no-store
401  { "error": "Unauthorized" }
422  { "error": "parse_failed", "suggestPaste": true }
503  { "error": "global_breaker_tripped" }
```

Facts you must code against, all read out of the route source:

- `MAX_UPLOAD_BYTES = 10 * 1024 * 1024` (10 MiB); `MAX_TEXT_CHARS = 100_000`. Over either → 422.
- The route **sniffs content**, ignoring `file.type`/`file.name`: `%PDF-` → PDF path, `PK\x03\x04` → DOCX path, anything else → 422. So the `accept=` attribute on your file input is a UX hint only, never a guarantee.
- When both `file` and `text` are present in a multipart body, **`file` wins and a failed file path returns 422** — there is no silent fallback to `text`. **Never send both.**
- `maxDuration = 60`, `ANTHROPIC_TIMEOUT_MS = 45_000`; a real PARSE is 10–40s (PRD §9).
- PARSE has **no per-user quota bucket** by design — the 10 MiB cap and the global spend breaker are the entire backstop. A double-submitted upload is a genuine double spend (~$0.03 each, PRD §9). See §4 C1.
- LIB-01 emits the literal string `"unknown"` for `stage`/`role` when the resume does not state one (`docs/plans/LIB-01.md` §2.3 item 8), explicitly so this ticket's confirm UI "shows the user something to fix".
- LIB-01 `docs/plans/LIB-01.md` §4 R7: **`Project.id` uniqueness is enforced nowhere.** The prompt asks for it; nothing checks it. "LIB-03's confirm UI is where a human sees the draft." Your UI must be robust to duplicate ids — see §4 E2.
- An empty `draftLibrary.projects` array is a **legal success**, not a failure (`lib/parse/schema.ts` header). Handle it.

**LIB-02 → `app/api/library/route.ts` + `lib/db/queries/library.ts` (merged).** Wire contract, transcribed from its header:

```
GET  /api/library
  200 { "library": Library | null, "resumeMd": string | null }   Cache-Control: no-store
  401 { "error": "Unauthorized" }
  500 { "error": "library_read_failed" }

POST /api/library      Content-Type: application/json
  body { "library": Library, "resumeMd": string }
  200 { "library": Library, "resumeMd": string }                 Cache-Control: no-store
  400 { "error": "invalid_body", "issues": string[] }
  401 { "error": "Unauthorized" }
  500 { "error": "library_write_failed" }
```

- `POST` is a **whole-object upsert**: it replaces the user's entire library and `resumeMd` in one transaction. There are no per-project endpoints and none may be added (ticket Non-goals).
- `issues` are Zod **paths + messages only, never values** (LIB-02 guarantees this deliberately, so the response is safe to show to the user — see §4 S5).
- `resumeMd` is capped at `MAX_RESUME_MD_CHARS = 200_000` server-side, and a U+0000 anywhere in the payload is a 400.
- `lib/db/queries/library.ts` exports `getLibrary(userId): Promise<Library | null>`, `getResume(userId): Promise<Resume | null>` (`Resume = { sourceMd, updatedAt }`), `hasLibrary`, `upsertLibrary`, `upsertResume`, `confirmLibraryImport`. It is **deliberately import-safe with no `DATABASE_URL`** (no top-level `@/db/index` import) *precisely so this ticket's server component can import it statically* — that is stated verbatim in its header. Import it statically; do not add a lazy-import dance.
- `getLibrary` **throws** (does not return `null`) when a stored row fails `Library.safeParse`. That is a recorded LIB-02 decision ("loud beats silently-wrong"). §2.2 tells you what to do — and, more importantly, what not to do.
- LIB-02 accepted, verbatim: *"last-write-wins on `POST /api/library`, single-user single-session usage pattern assumed, no PRD requirement for concurrent-edit protection."* There is **no UNIQUE constraint** on `libraries.userId`; `confirmLibraryImport` takes a per-user advisory lock to stop duplicate rows. Consequence for your UI: §4 C2.

**FND-02 → `lib/schemas/entities.ts`** (read-only import; `lib/schemas/**` is 01-foundation file-scope):

```ts
Project = { id: string /* PROJECT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/ */,
            name: string, stage: string, role: string,
            stack: string[], summary: string, metrics: string[], tags: string[] }
Library = { profile: Profile, projects: Project[] }
Profile = { name: string, headline?: string, targetRole?: string,
            contact?: { email?: string, links: string[] /* .default([]) */ } }
```

No field has `.min(1)` — **empty strings and empty arrays are valid**, by design (PRD §5.6: "空数组是合法且被显式展示的状态"). `PROJECT_ID_PATTERN` is exported; import it rather than re-typing the regex.

**FND-09 → the component-test setup, already established.** Read `app/(app)/settings/_components/delete-account-confirm.test.tsx` before you write a line — it is the house style you must match:

- `vitest.config.ts`'s global `environment` is `'node'`; every component test file starts with a literal `// @vitest-environment jsdom` first line.
- Vitest globals are **off**. Import `describe/it/expect/vi/afterEach` from `'vitest'`, and register `afterEach(cleanup)` explicitly in every file (RTL's auto-cleanup does not self-register without globals; skipping it produces "multiple elements found" failures later in the same file).
- **`@testing-library/user-event` is NOT installed.** Use `fireEvent` from `@testing-library/react`. `package.json` is 01-foundation file-scope — **do not add any dependency**, not even a dev one.
- Installed and available: `@testing-library/react@16.3.2`, `@testing-library/dom@10.4.1`, `jsdom@26.1.0`, `react@19.2.7`, `vitest@3.2.7`, `zod@4.4.3`. Node is v22.11.0.
- **No CSS framework exists.** Every existing page/component uses inline `style={{…}}`. The repo's danger colour is `#b00020` (`delete-account-confirm.tsx`, `settings/page.tsx`) — use it for the "红字" elements so the human dogfood check lands on a colour the rest of the app already uses.

**`vitest.config.ts` needs NO change.** `include` already covers `app/**/*.test.{ts,tsx}`, which reaches every test location in this ticket (including `app/(app)/library/_lib/*.test.ts`). Do **not** append a glob — every FND/EVL ticket had to; this one does not, and that file is 01-foundation file-scope anyway.

**`middleware.ts` needs NO change.** Its gate is allowlist-by-omission: `PUBLIC_PATHS` = `/`, `/signin`, `/privacy`, `/tos`. `/library` is protected the moment the page exists. Do not touch the matcher.

### Verified empirically at planning time, in an isolated probe against this repo's exact toolchain — so you do not have to discover them

1. **`render(await LibraryPage())` works** for an `async` server component under `vitest` + `jsdom` + React 19.2.7 + RTL 16.3.2, including when the page renders `'use client'` children with hooks, and `vi.mock` of its data module applies normally. (The `'use client'` directive is inert under Vitest's transform — client components render like any other component.) The one constraint: the element tree the async function *returns* must contain only synchronous components. Keep `page.tsx` thin (§2.2) and this holds.
2. **`fireEvent.change(input, { target: { files: [file] } })` reaches a React `onChange` handler** and `e.target.files[0]` is the real `File` (correct `.name`, `.size`). `@testing-library/dom`'s `events.js` implements this by `Object.defineProperty(node, 'files', …)`.
3. **…but `new FormData(formElement)` does NOT see that injected file** — jsdom serialises from its internal file list, so the field comes back as a zero-byte `File`. **Therefore: build the multipart body manually (`fd.append('file', fileFromState)`) from a `File` you hold in React state. A component that does `new FormData(e.currentTarget)` will pass in a browser and silently fail every test.** This is the single most expensive trap in this ticket.
4. **`node:fs` works under the `jsdom` environment**, and `import.meta.url` is a real `file://` URL there — so `loadFixtures()` from `@/eval/fixtures` can be called from a jsdom-environment test file. (An earlier probe failure on this was an artifact of importing across vite roots, not a real limitation.)
5. `screen.getByRole('article', { name: /…/i })` + `within(card)` correctly scopes per-card queries when each card is `<article aria-labelledby={headingId}>` with a heading — and per-card `htmlFor`/`id` prefixes keep `getByLabelText` unambiguous across many cards.
6. jsdom provides `File`, `FormData`, `Blob`, `fetch`, `structuredClone` as globals.

### File ownership and serial-safety

- `docs/prd/breakdown-plan.md` §3 assigns `app/(app)/library/**` wholly to `03-library`. **This ticket owns every file it creates.** `app/api/parse/**`, `app/api/library/**`, `lib/parse/**`, `lib/db/queries/library.ts` are the same module's *other* tickets and are **read/import only** here.
- 01-foundation file-scope, **read/import only**: `lib/schemas/**`, `lib/auth/session.ts`, `db/**`, `auth*.ts`, `middleware.ts`, `app/layout.tsx`, `app/(app)/home/page.tsx`, `vitest.config.ts`, `package.json`, `tsconfig.json`, `eslint.config.mjs`. `fixtures/**` and `eval/**` are 02-evaluation, read-only.
- `git branch -a` lists only `main` plus already-merged `ticket/*` branches; no `ticket/LIB-03` exists; `app/(app)/library/` does not exist. Nothing is in flight against any file this ticket touches. If that has changed at build time, **stop and escalate**.

---

## 1. Scope

### In scope

Exactly one new directory tree, `app/(app)/library/**` — 10 source files + 8 test files, all new (§2.2–§2.9). Nothing outside that tree is created or modified.

The three things the ticket exists to deliver:

1. **Import entry point** — file (PDF/DOCX) or pasted text → `POST /api/parse`, with a loading state and the PRD §5.1 failure policy (422 `suggestPaste` → paste UI).
2. **Draft confirm flow** — per-project editable cards (PRD §4 S1 "逐条确认/微调"), add/remove, then one `POST /api/library` carrying the edited `Library` **and the byte-for-byte pass-through `resumeMd`**.
3. **Library page** — the confirmed library with **both** empty-metrics UI elements required by PRD §5.7 (page-top red tally banner **and** per-card warning — both, not either/or), plus ongoing add/edit/remove (PRD §5 S5 "复利": the library keeps growing).

### Explicitly out of scope — do not implement, even opportunistically

- **No new API route, no Server Action, no route handler.** This ticket calls two existing endpoints and one query module. Adding an `app/api/**` file is a scope breach.
- **No edit to `app/layout.tsx` or `app/(app)/home/page.tsx`** to add a nav link to `/library`, however tempting. Both are 01-foundation file-scope. The consequence (the page is reachable only by typing the URL) is real and is escalated as §5 Q1 — **report it, do not fix it**.
- **No re-import / re-parse affordance for a user who already has a library.** Deliverable 5 branches on `library === null`; the ticket's Feedback obligation #3 explicitly makes re-import-vs-`resumeMd`-overwrite a *future* ticket's open question. If you find yourself designing overwrite semantics, stop and escalate.
- **No UI that edits `resumeMd`.** It is state, never a form field, never rendered (§4 S1, §4 E7).
- **No markdown rendering and no new dependency** (`react-markdown` et al.). `resumeMd` is not displayed at all, so the question does not arise — and adding a dep touches 01-foundation's `package.json`.
- **No streaming/SSE for PARSE.** The ticket's Deliverable 1 already decided a plain loading state, because PRD §5.1's streaming/delay-budget row names Fit/Tailor/Prep only. The ticket *requires* you to record this as a deliberate narrower reading, not an oversight — put that sentence in `upload-form.tsx`'s header comment (§2.5).
- **No per-project REST calls, no optimistic locking, no ETag/version.** LIB-02's whole-object upsert and its accepted last-write-wins are inherited. If real editing UX makes that untenable, ticket Feedback obligation #1 applies: **escalate to `03-library/README.md`'s decisions table, do not paper over it in client state management.**
- **No `hasLibrary()` usage and nothing under `app/(app)/jobs/**`.** That gate is `04-fit`/FIT-03.
- **No AI-driven "guided library enrichment"** (PRD §11 V1.5, untriggered).
- **No `Profile` editing UI** in v1 — pass-through only (§2.6, §5 Q2).
- **No `vitest.config.ts` / `package.json` / `middleware.ts` change.**

---

## 2. Change list

### 2.0 Architecture in one paragraph (read this before writing any file)

`page.tsx` is a thin async **server** component: it resolves `userId`, reads `getLibrary` + `getResume`, and hands both to a single stateful **client** orchestrator, `library-workspace.tsx`. The workspace owns the whole client state machine — *no library* → `<UploadForm>`; *parsed draft in hand* → `<DraftConfirm>`; *library present* → the confirmed page (banner + `<ProjectCard>` list, with an inline `<ProjectEditor>` when a card is being edited). Two thin API-client functions in `_lib/api.ts` own every `fetch`, so status-code mapping is unit-testable and no component contains a URL. Pure list/id/string helpers live in `_lib/library-edits.ts` so the nastiest edge cases (empty textarea → `[]`, kebab-case id generation) are tested as functions rather than through the DOM. **No `useRouter`, no `router.refresh()`, no `next/navigation` import anywhere** — the workspace updates its own state from the `POST /api/library` echo, which keeps every test free of Next router mocks (§4 C5 records the tradeoff).

### 2.1 Files (all new, all under `app/(app)/library/`)

| # | File | Kind |
|---|---|---|
| 1 | `page.tsx` | server component (ticket Deliverable 5) |
| 2 | `_components/library-workspace.tsx` | client — state machine |
| 3 | `_components/upload-form.tsx` | client (ticket Deliverable 1) |
| 4 | `_components/draft-confirm.tsx` | client (ticket Deliverable 2) |
| 5 | `_components/project-editor.tsx` | client — shared editable card |
| 6 | `_components/project-card.tsx` | client (ticket Deliverable 4) |
| 7 | `_components/empty-metrics-banner.tsx` | pure presentational (ticket Deliverable 3) |
| 8 | `_lib/api.ts` | `requestParse` + `saveLibrary` |
| 9 | `_lib/library-edits.ts` | pure helpers |
| 10 | `_fixtures/library-fixtures.ts` | **test-only** fixtures |
| 11–18 | `page.test.tsx`, `_components/{library-workspace,upload-form,draft-confirm,project-card,empty-metrics-banner}.test.tsx`, `_lib/{api,library-edits}.test.ts` | tests |

The five file names the ticket names literally (`page.tsx`, `upload-form.tsx`, `draft-confirm.tsx`, `empty-metrics-banner.tsx`, `project-card.tsx`) are **non-negotiable** — the Reviewer will look for them. The other five are this plan's decomposition; you may merge or split them if you record the deviation, provided the five named files exist and own the behaviour their Deliverable describes.

Folders beginning with `_` are Next.js **private folders**, excluded from routing — `_components` is already the repo's convention (`app/(app)/settings/_components/`), and `_lib`/`_fixtures` inherit it. Nothing under `app/(app)/library/` becomes a route except `page.tsx` → `/library`.

### 2.2 `page.tsx` — the server component

```tsx
import { requireUserId } from '@/lib/auth/session';
import { getLibrary, getResume } from '@/lib/db/queries/library';
import LibraryWorkspace from '@/app/(app)/library/_components/library-workspace';

export const metadata = { title: 'Library — Groundwork' };

export default async function LibraryPage() {
  const userId = await requireUserId();
  const [library, resume] = await Promise.all([getLibrary(userId), getResume(userId)]);
  return (
    <section style={{ maxWidth: '56rem' }}>
      <h1>Library</h1>
      <LibraryWorkspace initialLibrary={library} initialResumeMd={resume?.sourceMd ?? null} />
    </section>
  );
}
```

Decisions embedded here, each of which must appear as a header comment so the Reviewer sees them as choices:

- **Static import of `@/lib/db/queries/library` is correct and deliberate.** LIB-02 made that module import-safe with no `DATABASE_URL` *specifically for this consumer* (its header says so). This is the FND-08 build-breaker class of bug; §3 pins it with a build-guard test and §7 requires a real `pnpm build` with `DATABASE_URL` unset.
- **`requireUserId()` is allowed to throw.** `middleware.ts` gates `/library` on every request, so `UnauthorizedError` here means the gate is broken — that should be loud, not silently redirected. Do **not** import `redirect` from `next/navigation` to paper over it. (§5 Q4 hands the alternative to the Reviewer.)
- **Do NOT wrap `getLibrary()` in a try/catch that falls back to the upload flow.** `getLibrary` throws on a schema-drifted row by LIB-02's explicit decision; catching that and rendering "no library yet" would invite the user to import a *second* library over a corrupted one — the precise failure LIB-02 rejected. Let it propagate. §3 pins this with a test.
- `export const dynamic = 'force-dynamic';` — optional but recommended, with a comment saying it is documentation rather than behaviour change: `app/layout.tsx` is already `force-dynamic` and every route in the current build output is `ƒ (Dynamic)`, so this only makes the intent local and immune to a future layout edit.
- Server → client props: `Library` and `string | null` are plain JSON, so they cross the boundary cleanly. Do not pass functions or class instances.
- **Never render `resumeMd`.** It is passed down as state for the save round-trip only.

### 2.3 `_lib/library-edits.ts` — pure helpers (write and test these first)

```ts
export function splitList(input: string, sep: 'comma' | 'line'): string[];
export function joinList(values: readonly string[], sep: 'comma' | 'line'): string;
export function makeProjectId(name: string, taken: ReadonlySet<string>): string;
export function blankProject(taken: ReadonlySet<string>): Project;
export function countMissingMetrics(projects: readonly Project[]): number;
```

- `splitList` splits on `,` or `\n` (accept `\r\n` too), **trims every entry and drops empty ones**. `splitList('', …)` must return `[]` — **not `['']`**. This is not a nicety: `['']` has `length === 1`, which makes `metrics.length === 0` false and silently deletes the empty-metrics warning that is this ticket's entire acceptance surface (§4 E1).
- `makeProjectId` must **always** return a string matching the imported `PROJECT_ID_PATTERN`: lowercase; replace every run of non-`[a-z0-9]` with `-`; strip leading/trailing `-`; collapse `--`; cap at ~60 chars (strip a trailing `-` after the cut); if the result is empty (a CJK-only name, punctuation-only, or an empty name) fall back to the literal `project`; then de-duplicate against `taken` by suffixing `-2`, `-3`, … until free. Unit-test it *against the imported regex*, not against hand-written expected strings alone.
- `blankProject` returns `{ id: makeProjectId('', taken), name: '', stage: 'unknown', role: 'unknown', stack: [], summary: '', metrics: [], tags: [] }`. `'unknown'` matches LIB-01's convention for unstated values (`docs/plans/LIB-01.md` §2.3 item 8) — **this plan deliberately does not override it, which closes LIB-01 §5 Q4 ("does LIB-03 want a different sentinel?") with "no"**. Because a blank project has `metrics: []`, adding one immediately trips both empty-metrics UI elements — correct, and worth a test.
- `makeProjectId` is called **only when a project is created**. Never regenerate an id when the user edits a name: ids are the join key FND-07's referential-integrity layer uses downstream, and rewriting them under the user would silently re-point future bindings.

### 2.4 `_lib/api.ts` — the only two `fetch` call sites in this ticket

```ts
export type ParseOk = { ok: true; resumeMd: string; draftLibrary: Library };
export type ParseErr = { ok: false; suggestPaste: boolean; message: string };
export async function requestParse(input: { file: File } | { text: string }): Promise<ParseOk | ParseErr>;

export type SaveOk = { ok: true; library: Library; resumeMd: string };
export type SaveErr = { ok: false; message: string };
export async function saveLibrary(library: Library, resumeMd: string): Promise<SaveOk | SaveErr>;
```

`requestParse`, exactly:

- File branch: `const fd = new FormData(); fd.append('file', input.file); fetch('/api/parse', { method: 'POST', body: fd })`. **Do not set a `Content-Type` header** — the browser must generate the multipart boundary; setting it by hand produces a body the server cannot parse. **Do not send a `text` field alongside `file`** (the route makes `file` win and 422s rather than falling back).
- Text branch: `fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: input.text }) })`.
- Relative, same-origin URLs only; no `credentials` option needed (same-origin is the default and the session cookie is `httpOnly`/`sameSite: lax`).
- **No client-side `AbortSignal.timeout`** below the server's `maxDuration = 60` — a 30s client abort would kill legitimate parses. Simplest correct choice: no client timeout at all. Say so in a comment.
- Response handling: `const body = await res.json().catch(() => null)`. On `res.ok`, run `ParseResult.safeParse(body)` (import from `@/lib/parse/schema` — it imports only zod + entities, so it is client-safe) and treat a failure as a generic error; the server already validated, this is cheap defence in depth against a proxy mangling the body. Status mapping:

| Status | Result |
|---|---|
| 200 + valid | `{ ok: true, resumeMd, draftLibrary }` |
| 401 | `{ ok: false, suggestPaste: false, message: 'Your session has expired. Sign in again to continue.' }` |
| 422 | `{ ok: false, suggestPaste: body?.suggestPaste === true, message: "We couldn't read that resume. Paste the text instead." }` |
| 503 | `{ ok: false, suggestPaste: false, message: 'Resume parsing is temporarily unavailable. Please try again later.' }` |
| anything else / `fetch` throws | `{ ok: false, suggestPaste: false, message: 'Something went wrong. Please try again.' }` |

`saveLibrary`: `fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ library, resumeMd }) })`. 200 → `{ ok: true, library: body.library, resumeMd: body.resumeMd }` (LIB-02 echoes exactly what it persisted). 400 → `{ ok: false, message: 'Your library could not be saved: ' + issues.slice(0, 5).join('; ') }` (safe: LIB-02 guarantees paths+messages, never values — §4 S5). 401 → session-expired message. 500 / other / throw → `'Saving failed. Your library was not changed.'`

**Never `console.log`/`console.error` the request body, the response body, `resumeMd`, or any `Library` content** anywhere in this ticket — it is a real person's resume (PRD §8.1; both LIB-01 and LIB-02 hold this line explicitly). If you want a breadcrumb, log a status code and nothing else.

### 2.5 `_components/upload-form.tsx` (Deliverable 1)

```ts
export default function UploadForm({ onParsed }: { onParsed: (r: ParseOk) => void })
```

State: `mode: 'file' | 'text'`, `file: File | null`, `text: string`, `busy: boolean`, `error: string | null`, `pasteSuggested: boolean`.

Behaviour:

- Two modes with an explicit switch ("Paste text instead" / "Upload a file instead"). File mode: `<label htmlFor>` + `<input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">`; the `onChange` handler stores `e.target.files?.[0] ?? null` **in state** (this is what makes the manual `FormData` build in §2.4 both correct and testable — verified fact 3 in §0). Text mode: a `<textarea>` with a label.
- Client-side pre-checks that avoid a pointless paid round-trip: empty selection/empty text → inline message, **zero** `fetch` calls; `file.size > 10 * 1024 * 1024` → "That file is larger than 10 MB. Upload a smaller file or paste the text instead.", zero `fetch` calls.
- Submit: set `busy`, call `requestParse`, clear `busy` in a `finally`. **The submit button must be `disabled` while `busy`** — see §4 C1 (a double click is a double Anthropic charge, and PARSE has no per-user quota).
- Loading state: a visible, non-spinner-dependent text status is required so tests can assert it — e.g. `<p role="status">Reading your resume… this usually takes about 30 seconds.</p>` (PRD §4 S1 says "约 30s"; being honest about the wait is the cheapest possible UX here).
- **On `{ ok: false, suggestPaste: true }`: switch `mode` to `'text'`, set `pasteSuggested`, and render the paste UI with the guidance message — never a generic error screen.** This is PRD §5.1's "解析失败 → 引导粘贴纯文本" and acceptance item 4. Edge case: if the user is **already** in text mode and gets `suggestPaste: true` again, do not silently "switch" to the mode they are in — show the error message on the textarea ("We couldn't read that text either. Check that you pasted the whole resume."), or the user sees a no-op and thinks the button is broken (§4 E10).
- On `{ ok: false, suggestPaste: false }`: render `error` inline via `role="alert"`; stay in the current mode.
- On success: call `onParsed(result)` and render nothing further (the workspace swaps the view).

Header comment must contain the ticket-mandated sentence about streaming, in substance: *PRD §5.1's streaming requirement and delay budget name Fit/Tailor/Prep only; PARSE has no named streaming requirement, so a plain loading state is a deliberate narrower reading of §5.1, not an oversight.*

### 2.6 `_components/draft-confirm.tsx` (Deliverable 2)

```ts
export default function DraftConfirm({
  draftLibrary, resumeMd, onSaved,
}: { draftLibrary: Library; resumeMd: string; onSaved: (library: Library, resumeMd: string) => void })
```

- Working state: `rows: { uid: string; project: Project }[]`, seeded once from `draftLibrary.projects` (`uid` from `crypto.randomUUID()`, available in jsdom). **`uid`, not `project.id` and not the array index, is the React `key` and the DOM-id prefix.** Reasons, both real: PARSE can emit duplicate `Project.id`s (LIB-01 §4 R7), and index keys make "remove the middle card" reassign inputs to the wrong project (§4 E2/E3).
- `draftLibrary.profile` is held verbatim and **not editable** in v1 (§5 Q2). `resumeMd` is held in a ref/state and **never** placed in a form field — a `<textarea>`/hidden input would normalise newlines and break the byte-for-byte acceptance item (§4 E7).
- Renders `<EmptyMetricsBanner projects={…} />` at the top (recommended and in scope: the draft step is exactly where the user can still add the missing numbers) and one `<ProjectEditor>` per row.
- "Add a project" appends `blankProject(takenIds)`. Each card has "Remove". Removing the last project leaves zero cards — legal, keep the confirm button enabled (an empty `Library` is valid; §4 E4/E9).
- "Confirm and save": build `next: Library = { profile, projects: rows.map(r => r.project) }`, run `Library.safeParse(next)` **client-side first** and, on failure, render the issue paths inline without calling the API (this converts LIB-02's opaque 400 into a field-level message; the server check remains the real boundary). On success call `saveLibrary(next, resumeMd)`; on `ok` call `onSaved(result.library, result.resumeMd)`; on failure show `message` via `role="alert"` and keep every edit on screen — **losing the user's edits on a save error is the exact friction ticket Feedback obligation #1 is about; if you cannot avoid it, escalate rather than work around it.**
- The confirm button is `disabled` while a save is in flight (§4 C2 — LIB-02 has no UNIQUE constraint on `libraries.userId`, so two concurrent confirms are a duplicate-row risk, not merely a duplicate write).

### 2.7 `_components/project-editor.tsx` (shared by the draft flow and the confirmed page)

```ts
export default function ProjectEditor({
  uid, project, onChange, onRemove, onDone,
}: { uid: string; project: Project; onChange: (next: Project) => void;
     onRemove?: () => void; onDone?: () => void })
```

Controlled inputs, one per ticket-named field: **Name**, **Stage**, **Role** (text), **Stack** (text, comma-separated), **Summary** (textarea), **Metrics** (textarea, **one per line**), **Tags** (text, comma-separated). Arrays go through `splitList`/`joinList`. `id` is shown as static text, not an input (§2.3).

Every control needs `<label htmlFor={`${uid}-metrics`}>` / `id={`${uid}-metrics`}`. **Duplicate DOM ids across cards break `getByLabelText` with "found multiple elements"** — the `uid` prefix is what prevents it (§4 E12). Wrap each editor in `<article aria-labelledby={`${uid}-heading`}>` with the project name (or `Untitled project` when the name is empty) as the heading, so tests can scope with `within(screen.getByRole('article', { name: … }))` (verified fact 5).

Metrics help text should state the P2 rule plainly: "One real number per line, exactly as it appears in your resume. Leave empty if you have none — that is a valid state, and it will be flagged." (PRD §2 P2 / §5.6.)

### 2.8 `_components/project-card.tsx` (Deliverable 4) and `_components/empty-metrics-banner.tsx` (Deliverable 3)

`ProjectCard` — read-only display:

```ts
export default function ProjectCard({ project, onEdit, onRemove }:
  { project: Project; onEdit?: () => void; onRemove?: () => void })
```

`<article aria-labelledby>` + heading (name, or `Untitled project`), then role · stage, stack, summary, metrics list, tags. **When `project.metrics.length === 0`, and only then, render the per-card warning** — a distinct element containing the literal lowercase string `no metrics` (PRD §2 line 48 uses that exact string as the interface wording), styled `#b00020`, e.g. `no metrics — add a real number from your resume`. This is PRD §5.7's "卡片级警告", and it is **in addition to**, never instead of, the banner.

`EmptyMetricsBanner` — pure, no hooks, no `'use client'` needed:

```ts
export default function EmptyMetricsBanner({ projects }: { projects: readonly Project[] })
```

Returns `null` when `projects.length === 0` **or** when `countMissingMetrics(projects) === 0`. Otherwise a `role="alert"`, `#b00020`, bold paragraph tallying the count — PRD §5.7's "页顶红字盘点":

> `{missing} of {total} projects have no metrics — add real numbers from your resume so Fit and Tailor can cite evidence.`

Handle singular/plural (`1 of 7 projects has no metrics`). Tests assert on the tally substring, so keep the number-space-`of`-space-number shape.

### 2.9 `_components/library-workspace.tsx` — the state machine

```ts
export default function LibraryWorkspace({ initialLibrary, initialResumeMd }:
  { initialLibrary: Library | null; initialResumeMd: string | null })
```

State: `library: Library | null`, `resumeMd: string`, `draft: ParseOk | null`, `editingUid: string | null`, `busy: boolean`, `error: string | null`, plus the same `rows`-with-`uid` device as §2.6 for the confirmed list.

Render branches, in this order:

1. `draft !== null` → `<DraftConfirm draftLibrary={draft.draftLibrary} resumeMd={draft.resumeMd} onSaved={(lib, md) => { setLibrary(lib); setResumeMd(md); setDraft(null); }} />`
2. `library === null` → intro copy (PRD §3 C1: import is the main path, manual entry supplements it) + `<UploadForm onParsed={setDraft} />`
3. otherwise → the confirmed Library page: `<EmptyMetricsBanner>` + the `<ProjectCard>` list (with the card at `editingUid` swapped for `<ProjectEditor>`), an "Add a project" button, and an inline error region.

Mutations on the confirmed page (edit-save, remove, add) each build the full next `Library` and call `saveLibrary(next, resumeMd)`; on `ok` set state from the echo, on failure show `message` and **leave the on-screen state as the user left it** (do not roll back to the server value silently — the user would watch their edit vanish with no explanation). While `busy`, disable every mutating control (§4 C2/C3).

`initialResumeMd === null` while `initialLibrary !== null` is unreachable through this app's flows (LIB-02 writes both atomically) but is representable in the DB. Send `resumeMd ?? ''` and put a comment saying exactly that, and why `''` was chosen over blocking saves. §5 Q3 hands the alternative to the Reviewer.

When `library.projects.length === 0` (legal — the user removed everything, or PARSE found nothing), render "Your library has no projects yet." plus the add affordance, **and no banner**. Say in the copy that a library with no projects will not let them create jobs (PRD §5.7 "无库时禁止新建 job" — `hasLibrary()` returns `false` for an empty projects array, per LIB-02).

### 2.10 `_fixtures/library-fixtures.ts` — test-only

Exports, for use by test files **only** (add a header comment saying so — no production component may import this module):

- `RESUME_MD_FIXTURE: string` — `loadFixtures().resumes.find(r => r.id === 'synthetic-junior')!.text`, imported from `@/eval/fixtures` (verified working from a jsdom test — §0 fact 4). Grounds the tests in EVL-01's real corpus rather than an ad-hoc string, as the ticket's Test plan requires.
- `DRAFT_LIBRARY_FIXTURE: Library` — a hand-built `Library` matching that resume: `profile.name = 'Jordan Avery'`, and **two projects, exactly one of which has `metrics: []`** — `trailmark` (metrics: `['92% test coverage on the API layer', 'page load under 1.5s on the route list']`) and `pantry` (`metrics: []`, because the fixture literally says "Metrics: none reported"). This mixed-metrics property is the one EVL-01's Deliverable 5 guarantees the corpus has, and it is what makes the §3 A2/A3 assertions meaningful rather than self-fulfilling.
- `PARSE_OK_FIXTURE = { resumeMd: RESUME_MD_FIXTURE, draftLibrary: DRAFT_LIBRARY_FIXTURE }`.
- Optionally `THREE_PROJECT_FIXTURE` (2 of 3 missing metrics) for the banner tally test.

Assert once, in `_lib/library-edits.test.ts` or the banner test, that `Library.safeParse(DRAFT_LIBRARY_FIXTURE).success === true` — a fixture that silently drifts from FND-02's schema would make several tests pass for the wrong reason.

### 2.11 What must not change

Everything outside `app/(app)/library/**`. In particular `app/api/parse/**`, `app/api/library/**`, `lib/db/queries/library.ts`, `lib/parse/**`, `lib/schemas/**`, `middleware.ts`, `app/layout.tsx`, `app/(app)/home/page.tsx`, `vitest.config.ts`, `package.json`, `pnpm-lock.yaml`. Read/import only. No existing test may be edited.

---

## 3. Test plan

All component tests: first line `// @vitest-environment jsdom`, explicit `afterEach(cleanup)`, `fireEvent` (no `user-event`), `vi.stubGlobal('fetch', fetchMock)` with `afterEach(() => vi.restoreAllMocks())` — the exact shape of `app/(app)/settings/_components/delete-account-confirm.test.tsx`. **No test may make a real network call**; every `fetch` is stubbed, matching LIB-01's and LIB-02's posture.

Helper used throughout: `const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);`

### Acceptance item → tests

**A1 — `draft-confirm.tsx` renders one editable card per project; "Confirm and save" submits the edited `library` PLUS the unmodified `resumeMd`.** (`_components/draft-confirm.test.tsx`)

| # | Test |
|---|---|
| D1 | Renders exactly one editable card per project in `DRAFT_LIBRARY_FIXTURE` — `screen.getAllByRole('article')` length equals `DRAFT_LIBRARY_FIXTURE.projects.length`, and each project's name appears in a Name input |
| D2 | **The acceptance assertion.** Edit project 0's Name via `fireEvent.change`, click "Confirm and save"; assert exactly one `fetch` to `'/api/library'` with `method: 'POST'`; `bodyOf(...)`: `body.library.projects[0].name` is the edited value, `body.library.projects[1]` is unchanged, and **`expect(body.resumeMd).toBe(RESUME_MD_FIXTURE)`** — strict `toBe`, byte-for-byte, not `toContain` |
| D3 | A 200 response calls `onSaved` with the echoed library + resumeMd |
| D4 | A 400 `{ error: 'invalid_body', issues: ['library.projects.0.id: …'] }` shows an inline error, does **not** call `onSaved`, and **leaves the user's edits in the DOM** |
| D5 | "Add a project" appends a card whose generated id matches `PROJECT_ID_PATTERN`, is not already taken, and whose metrics are empty |
| D6 | Removing the **middle** card of a three-project fixture leaves the other two with their own values intact (this is the index-key bug, §4 E3) |
| D7 | Editing the Metrics textarea to empty submits `metrics: []`, not `['']` (§4 E1) |
| D8 | Double-clicking "Confirm and save" issues exactly **one** `fetch` (button disabled while in flight) |
| D9 | A draft with `projects: []` renders zero cards, the add affordance, and can still be confirmed (LIB-01 says an empty draft is a legal success) |

**A2 — banner renders iff at least one project has `metrics: []`.** (`_components/empty-metrics-banner.test.tsx`)

| # | Test |
|---|---|
| B1 | With a 3-project fixture where 2 have `metrics: []`, renders and the text contains `2 of 3` and `no metrics` |
| B2 | With all projects having non-empty metrics, renders nothing (`container.firstChild === null`) |
| B3 | With `projects: []`, renders nothing (§4 E4) |
| B4 | Singular case: 1 of 3 → `1 of 3 projects has no metrics` |

**A3 — `project-card.tsx` warns exactly on `metrics.length === 0` cards, against a mixed fixture.** (`_components/project-card.test.tsx` + one list-level test in `library-workspace.test.tsx`)

| # | Test |
|---|---|
| C1 | A project with metrics: no `no metrics` text; the metrics themselves are rendered |
| C2 | A project with `metrics: []`: the warning is present |
| C3 | **List level**: render the confirmed page with a mixed fixture; for every project, `within(screen.getByRole('article', { name: … })).queryByText(/no metrics/i)` is non-null **iff** that project's metrics are empty. Compute the expected set from the fixture (`projects.filter(p => p.metrics.length === 0)`), do not hardcode names — this is the assertion that proves "correct subset only" |
| C4 | A project whose `name` is `''` still renders a findable card (`Untitled project`) — otherwise the accessible name is empty and `getByRole('article', { name })` cannot address it |

**A4 — paste fallback after a mocked `suggestPaste: true`.** (`_components/upload-form.test.tsx`)

| # | Test |
|---|---|
| U1 | Select a file, submit; `fetch` resolves `{ ok: false, status: 422, json: async () => ({ error: 'parse_failed', suggestPaste: true }) }`; assert the paste textarea is now present, the guidance message is shown, and **no generic error page** is rendered |
| U2 | Continuing from U1, type into the textarea and submit: the second `fetch` call is to `'/api/parse'` with `Content-Type: application/json` and body `{ text: … }`; a 200 calls `onParsed` with `{ resumeMd, draftLibrary }` |
| U3 | The file submit sends a `FormData` body whose `get('file')` is the selected `File`, with **no `Content-Type` header set by us** and **no `text` field present** |
| U4 | A >10 MiB file is rejected client-side with a message and **zero** `fetch` calls |
| U5 | 503 → the temporarily-unavailable message; 401 → the session-expired message; both keep the form usable |
| U6 | Double-clicking submit issues exactly one `fetch` (§4 C1) |
| U7 | Already in paste mode, a second `suggestPaste: true` shows an error rather than a silent no-op (§4 E10) |
| U8 | While in flight, the `role="status"` loading text is present and the submit button is disabled |

**A5 — `pnpm test` green.** The full-suite run in §7: **≥ 42 files / ≥ 404 tests**, all green, no pre-existing test modified.

**A6 — `[human]` Horace's visual check.** Nothing to implement beyond using `#b00020` and bold for both empty-metrics elements. Call it out in the handoff note as the one open acceptance item.

### Additional tests this plan requires (not tied to a single acceptance line)

`page.test.tsx` — mock `@/lib/auth/session` (`requireUserId` → a fixed id) and `@/lib/db/queries/library` (`getLibrary`/`getResume`) with `vi.mock` + `vi.hoisted` for stable refs across `resetModules` (the pattern in `app/api/parse/route.test.ts`):

| # | Test |
|---|---|
| P1 | `getLibrary` → `null`: `render(await LibraryPage())` shows the upload entry point and no project cards |
| P2 | `getLibrary` → the fixture library, `getResume` → `{ sourceMd, updatedAt }`: shows the `h1`, the banner, one card per project, and **no** upload form |
| P3 | `getLibrary` rejects (schema-drifted row): `await expect(LibraryPage()).rejects.toThrow()` — it must **not** degrade to the upload flow (§2.2) |
| P4 | **Build guard**, copied from the last test of `app/api/parse/route.test.ts`: `vi.stubEnv('DATABASE_URL', '')`, `vi.resetModules()`, `vi.doUnmock('@/lib/db/queries/library')`, `vi.doUnmock('@/lib/auth/session')`, then `await expect(import('@/app/(app)/library/page')).resolves.toBeDefined()`, **plus** the sanity assertion `await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/)` so the test cannot pass merely because the env var happened to be set |

`library-workspace.test.tsx`:

| # | Test |
|---|---|
| W1 | Full happy path with a scripted `fetch` mock: no library → upload → PARSE 200 → draft cards → "Confirm and save" → `POST /api/library` 200 → the confirmed page renders with the banner and the cards, and the upload form is gone |
| W2 | Confirmed page: click Edit on a card, change Summary, Save → the `POST` body carries the full library with the edit **and** `resumeMd` equal to the initial `initialResumeMd` (`toBe`) |
| W3 | Confirmed page: Remove a project → the `POST` body's `projects` omits exactly that project |
| W4 | Removing the last project leaves the "no projects yet" state, no banner, and the add affordance |
| W5 | A failed save shows the error and leaves the user's on-screen edit intact (no silent rollback) |
| W6 | `initialResumeMd === null` with a non-null library → the save body's `resumeMd` is `''`, never `null`/`undefined` (§4 E5) |
| W7 | The C3 mixed-metrics list-level assertion (may live here rather than in `project-card.test.tsx`) |

`_lib/library-edits.test.ts`: `splitList('')` → `[]`; `splitList(' a , ,b ')` → `['a','b']`; `\r\n` handling; `joinList`/`splitList` round-trip; `makeProjectId` against `PROJECT_ID_PATTERN` for a normal name, a CJK-only name, `''`, punctuation-only, a 200-char name, and a duplicate (→ `-2`); `blankProject` passes `Project.safeParse` and has `metrics: []`; `countMissingMetrics`; `Library.safeParse(DRAFT_LIBRARY_FIXTURE).success === true`.

`_lib/api.test.ts`: the request shape of both helpers (URL, method, headers, body) and the full status→result mapping table from §2.4, including a `fetch` that throws.

---

## 4. Risks and edge cases

### Concurrency (the Reviewer checks these specifically)

- **C1 — Double-submitted PARSE is a double charge.** PARSE deliberately has **no per-user quota bucket** (`DAILY_QUOTA` has no `parse` key; LIB-01's route says so explicitly) — the 10 MiB cap and the *global* spend breaker are the only backstops. A double-clicked upload spends ~$0.06 instead of ~$0.03 and burns 60–80s of serverless time. Mitigation: `disabled` while in flight, pinned by test U6. This is a cost-control issue, not a cosmetic one.
- **C2 — Double-submitted save can create duplicate library rows.** LIB-02 records that `libraries.userId` / `resumes.userId` have **no UNIQUE constraint** (plain btree indexes only), so two simultaneous confirms could both find "no row" and both INSERT. LIB-02 mitigates with `pg_advisory_xact_lock`, which serialises but does not make the client's duplicate submit harmless. Mitigation: single-flight (`busy` gate) on every mutating control, pinned by D8.
- **C3 — Overlapping mutations on the confirmed page.** Edit-save then remove before the first response lands: the later response's echo could resurrect the earlier state. Mitigation: block all mutating controls while `busy` (simplest, testable). If you instead implement a request-sequence guard, say so in the deviations note.
- **C4 — State updates after unmount.** React 19 no longer warns; no cleanup needed. Do not add `isMounted` bookkeeping.
- **C5 — The server-rendered props go stale after a client save.** `initialLibrary` is a snapshot; the workspace's own state is the live copy, and a hard reload re-fetches. This is the deliberate cost of not using `router.refresh()`/Server Actions (§2.0, §6). Two browser tabs will diverge and the second save wins — which is exactly LIB-02's accepted last-write-wins, inherited, not newly introduced.

### Security and privacy

- **S1 — Resume PII must not leak client-side.** No `console.log` of the parse/save payloads, `resumeMd`, or library content. **No `localStorage`/`sessionStorage`/`IndexedDB`/cookie persistence of any of it** — PRD §8.1's "原始文件解析后即弃、不落盘" is a published promise (`app/(legal)/privacy/page.tsx` is live and says "there is no file store"); a draft cached in `localStorage` would make a shipped legal page false. Never put resume text in a URL or query string.
- **S2 — No `dangerouslySetInnerHTML`, anywhere.** Library content originates from an LLM whose input is attacker-influenced resume text (LIB-01 §4 S1 prompt-injection note). React's default escaping is the whole XSS control. Do not add a markdown/HTML renderer.
- **S3 — Identity comes only from the session.** Never put `userId` (or `id`, `deletedAt`) in a request body. LIB-02's `z.object` strips unknowns, so it would be harmless — and it would still be a smell the Reviewer flags.
- **S4 — Same-origin relative URLs only** (`/api/parse`, `/api/library`). No absolute URL, no configurable base, no `credentials: 'include'`.
- **S5 — Displaying LIB-02's `issues` is safe** *because* LIB-02 guarantees paths+messages and never values. Do not extend this to displaying arbitrary server error bodies.
- **S6 — File handling.** The `File` is passed straight to `fetch`; never read into a string, never stored beyond the component's lifetime, never sent anywhere but `/api/parse`.
- **S7 — The 10 MiB client check is UX, not security.** The server cap is the real control; do not present the client check as a guarantee.

### Edge cases

- **E1 — Empty textarea → `['']`.** The single highest-consequence bug in this ticket: `['']` has length 1, so the empty-metrics banner and card warning both silently vanish — the acceptance surface disappears while every render still "works". `splitList` must drop empties; test D7 and the `_lib` tests pin it.
- **E2 — Duplicate `Project.id` from PARSE** (LIB-01 §4 R7 — uniqueness enforced nowhere). Using `project.id` as a React key would collide and cross-wire inputs. Use per-row `uid`. Do **not** "fix" duplicates by silently rewriting model-produced ids — that would merge or rename two genuinely different projects. §5 Q6 asks the Reviewer whether an inline duplicate warning is wanted.
- **E3 — Array-index React keys** break "remove the middle card". Use `uid`.
- **E4 — `projects: []` is legal and reachable** (user removes everything; PARSE finds nothing). Banner must render nothing; the page shows the add affordance; the copy should mention that jobs cannot be created without projects (`hasLibrary()` → `false`).
- **E5 — `resumeMd === null` with a non-null library.** Unreachable through this app (LIB-02 writes both atomically) but representable. Send `''`; comment it; §5 Q3.
- **E6 — `stage`/`role` arrive as the literal `"unknown"`** from LIB-01, on purpose. Display as-is in an editable field. This plan closes LIB-01 §5 Q4 with "keep `unknown`" — no `03-library/README.md` changelog entry is needed because nothing is being overridden.
- **E7 — `resumeMd` can be ~200 KB.** Holding it in state is fine. Putting it in a `<textarea>` or hidden input is not: browsers normalise `\r\n` in form values, which would break the byte-for-byte acceptance item.
- **E8 — CJK / non-ASCII content is expected** (PRD §5.8 allows bilingual library summaries). `makeProjectId('语音助手', …)` must not produce an id that fails `PROJECT_ID_PATTERN` — hence the `project` fallback.
- **E9 — An empty `draftLibrary.projects` is a legal PARSE success.** Do not treat it as a parse failure or block confirmation.
- **E10 — `suggestPaste: true` while already in paste mode** must produce a visible error, not a silent mode "switch" to the current mode.
- **E11 — `new FormData(formElement)` loses the test-injected file** (verified, §0 fact 3). Build the FormData manually from state. A component that reads the form element passes in a browser and fails every test — and the reverse-engineering time is what this plan is trying to save you.
- **E12 — Duplicate DOM ids across cards** break `getByLabelText`. Prefix every `id`/`htmlFor` with the row `uid`.
- **E13 — Do not set a client-side timeout below the server's `maxDuration = 60`.** A real PARSE takes 10–40s.
- **E14 — `/library` has no navigation entry point.** `app/layout.tsx`'s header links only to `/`, and `app/(app)/home/page.tsx` still says "Library and Jobs pages land in later modules". Both files are 01-foundation file-scope. The page will be reachable only by typing the URL — which will block Horace's `[human]` dogfood item unless he is told. **Report it in the handoff; do not edit those files.** §5 Q1.

---

## 5. Open questions

| # | Question | Who decides | Default if undecided |
|---|---|---|---|
| Q1 | Nothing links to `/library` (`app/layout.tsx` / `app/(app)/home/page.tsx` are 01-foundation file-scope, and `04-fit`/FIT-03 will hit the same wall for `/jobs`). Who adds app navigation, and in which ticket? | **Horace** — a follow-up `01-foundation` or `07-platform-launch` ticket | Do not edit those files. Flag prominently in the handoff so the dogfood pass starts at `/library` directly |
| Q2 | Should the confirm UI let the user edit `Library.profile` (name, headline, targetRole, contact)? The ticket's Deliverable 2 enumerates project fields only, and `lib/schemas/entities.ts` explicitly invites extension "if a later module (e.g. 03-library's confirm UI) needs more" | **Horace**, at the P1 dogfood pass (ticket Feedback obligation #2 governs: fix in-ticket, log in `03-library/README.md`'s changelog) | Pass `profile` through unedited |
| Q3 | `library !== null` but `resumeMd === null` (unreachable via app flows): send `''` on save, or disable saving with an explanatory message? Sending `''` creates an empty `resumes` row, which would make TLR-01's number-integrity check reject every number | **Reviewer** | Send `''`, with the reasoning in a code comment |
| Q4 | Should `page.tsx` catch `UnauthorizedError` and `redirect('/signin')` instead of throwing? Middleware already gates `/library`, so a throw means the gate is broken | **Reviewer** | Let it throw (loud) — matches LIB-02's posture |
| Q5 | Banner copy, tone, and whether it also belongs on the draft-confirm step (this plan says yes; the ticket's minimum bar is the confirmed page) | **Horace**, at dogfood — ticket Feedback obligation #2 says fix directly here and log it in `03-library/README.md`'s changelog, no escalation | Render on both; wording as in §2.8 |
| Q6 | Should the confirm UI actively warn about duplicate `Project.id`s (LIB-01 §4 R7), or merely tolerate them? | **Reviewer** | Tolerate (per-row `uid`s), no warning, no silent rewriting |
| Q7 | If real editing UX shows that whole-object submit loses work (e.g. one project's validation error blocking another's edit), ticket Feedback obligation #1 forbids papering over it in client state | **Horace**, via `03-library/README.md`'s decisions table (version +0.1) | Escalate the finding; do not build a workaround |

---

## 6. ADR candidate (flagged, **not** decided or implemented here)

**A1 — client-owned state + whole-object POST for every interactive page in this app.** This is the repo's **first** interactive, data-mutating page, and it establishes four things that `04-fit`/FIT-03, `05-tailor`/TLR-02 and `06-prep`/PRP-02 will copy: (i) a thin async server component that only reads and hands data to a client orchestrator; (ii) mutations via `fetch` to an existing route handler rather than a Server Action; (iii) no `router.refresh()`/`revalidatePath` — the client trusts the endpoint's echo; (iv) API-client + pure-helper modules under `_lib/` so components stay thin and testable without `user-event`. Reversing that after three more modules have copied it is expensive. Worth `docs/adr/000N-page-state-and-mutation-convention.md` if Horace wants it recorded. **Do not write the ADR in this ticket.** (LIB-02 already flagged two ADR candidates that remain unwritten; `docs/adr/` still contains only `.gitkeep`.)

---

## 7. Build sequence (suggested order; each step ends green)

1. `git checkout -b ticket/LIB-03` from `main` at `a9df506`. Re-run `node_modules/.bin/vitest run` and confirm **42 files / 404 tests** green before touching anything.
2. `_lib/library-edits.ts` + `_lib/library-edits.test.ts`. Get the id/list edge cases right here, in isolation, where they are cheap.
3. `_fixtures/library-fixtures.ts`, with the `Library.safeParse` self-check test.
4. `_components/empty-metrics-banner.tsx` + test (acceptance A2 — the smallest complete acceptance item; bank it early).
5. `_components/project-card.tsx` + test (A3).
6. `_components/project-editor.tsx` (no dedicated test file; it is covered through D1–D7).
7. `_lib/api.ts` + `_lib/api.test.ts`.
8. `_components/upload-form.tsx` + test (A4). **Build the FormData manually** (§0 fact 3) or U3 will fail in a way that looks like a jsdom bug.
9. `_components/draft-confirm.tsx` + test (A1 — the byte-for-byte `resumeMd` assertion, D2, is the ticket's centrepiece).
10. `_components/library-workspace.tsx` + test (W1–W7).
11. `page.tsx` + `page.test.tsx` (P1–P4).
12. Full `node_modules/.bin/vitest run` — **≥ 42 files / ≥ 404 + your new tests**, all green, no pre-existing test modified.
13. `corepack pnpm lint` (flat config extends `next/core-web-vitals` + `next/typescript`: no `any`, no unused vars, `react/jsx-key` on every `.map`).
14. **`env -u DATABASE_URL corepack pnpm build`** — must be green with `DATABASE_URL` unset (that is what CI does), and the route table must now list **`ƒ /library`**. If it fails on a DB import, something in the page's static graph reaches `@/db/index` eagerly.
15. Hand off with: the diff summary, the real test output (file/test counts), the build route-table line for `/library`, and a **Deviations note** covering at minimum — (a) any of §5's defaults you resolved differently and why; (b) the fact that `/library` has no nav entry point (§4 E14 / §5 Q1) and how Horace should reach it for the `[human]` acceptance item; (c) the deliberate narrower reading of PRD §5.1 streaming for PARSE (ticket Deliverable 1 requires this to be recorded); (d) confirmation that LIB-01 §5 Q4 is closed with "keep `unknown`"; (e) any file merges/splits relative to §2.1.
