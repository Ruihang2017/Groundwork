# PARSE manual smoke check (human-run — deliberately NOT part of `pnpm test`)

LIB-01 Test plan item 5. Run this **once before P1 sign-off**, and again after any
edit to `lib/parse/prompt.ts`.

## Why this exists

`pnpm test` stubs `globalThis.fetch` in every PARSE test, so CI proves the route's
**plumbing** (auth → breaker → source resolution → Zod → repair → usage → response)
and nothing about whether the prompt actually works. In particular CI never exercises:

- the **PDF native document-input** path against the real API (all three `[fixture]`
  tests use the pasted-text path, because EVL-01's fixtures are `.md` files);
- the **DOCX** happy path (no real `.docx` fixture exists, and `fixtures/**` is
  02-evaluation's file-scope — LIB-01 may not add one);
- the **prompt itself** — no real model ever sees it in CI.

A real call is non-deterministic and costs money (~$0.03/run, PRD §9), which is why
it is not in CI. This file is the compensating control.

> **Do not commit a real resume.** Generate your test files locally from
> `fixtures/resumes/synthetic-mid.md` (print-to-PDF from any markdown viewer; paste
> into a word processor and save-as `.docx`) and keep them **out of git** — the
> repo has no file store and must never gain one.

## Environment

```
ANTHROPIC_API_KEY=sk-ant-...
GLOBAL_DAILY_SPEND_LIMIT_USD=5           # must be set — the route fails CLOSED (503) without it
DATABASE_URL=postgres://...              # recordUsage() writes one usage_events row on success
AUTH_SECRET=..., AUTH_GOOGLE_ID/SECRET or RESEND_API_KEY+RESEND_FROM_EMAIL
```

## Recipe A — end to end (the point of this document)

```sh
corepack pnpm dev
# sign in at http://localhost:3000/signin, then copy the
# `authjs.session-token` cookie value out of devtools
```

```sh
COOKIE='authjs.session-token=<paste>'

# 1. PDF — the path CI cannot reach
curl -sS -X POST http://localhost:3000/api/parse -H "Cookie: $COOKIE" \
  -F "file=@./local-only/resume.pdf" | tee /dev/stderr | jq .

# 2. DOCX — mammoth extraction, also unreachable in CI
curl -sS -X POST http://localhost:3000/api/parse -H "Cookie: $COOKIE" \
  -F "file=@./local-only/resume.docx" | jq .

# 3. Pasted text — the CI-covered path, run here against a REAL model
curl -sS -X POST http://localhost:3000/api/parse -H "Cookie: $COOKIE" \
  -H 'content-type: application/json' \
  --data "$(jq -Rs '{text: .}' < fixtures/resumes/synthetic-mid.md)" | jq .
```

Check, for each of the three:

1. **HTTP 200**, body is `{ resumeMd, draftLibrary }` and nothing else.
2. `draftLibrary.projects` is **non-empty** and each `id` is kebab-case and unique.
3. **Every string in every `metrics` array appears VERBATIM in the source resume.**
   This is the P2 guardrail ("数字永不虚构") and the single most important check here:

   ```sh
   # for the pasted-text run, mechanically:
   jq -r '.draftLibrary.projects[].metrics[]' out.json \
     | while read -r m; do grep -qF "$m" fixtures/resumes/synthetic-mid.md \
       || echo "FABRICATED: $m"; done
   ```

4. A project whose source says "none reported" has `metrics: []` — not an invented
   number, and not a string like `"none reported"`.
5. `resumeMd` is a **transcription**, not a summary: section headings and bullets from
   the source are all still present, and no number has been rounded or dropped.
   (TLR-01's number-integrity check later uses this text as its only source pool — a
   summarizing PARSE silently deletes real numbers and makes legitimate rewrites get
   filtered as fabrications.)
6. `stage`/`role` are `"unknown"` where the source states neither — never invented.
7. Server log shows no resume text, no model output, and no request headers.
8. One new `usage_events` row with `op = 'parse'`.

### DOCX-specific check (ticket Feedback obligation #2)

`mammoth.extractRawText` drops headings and list markers. If run #2's `draftLibrary`
is materially worse than run #1's — projects merged, metrics attributed to the wrong
project, sections mistaken for projects — **stop and escalate to Horace**: the
question is whether DOCX should be de-scoped to "convert to PDF first" guidance in
LIB-03's UI. Do **not** silently switch `lib/parse/docx.ts` to
`mammoth.convertToMarkdown()`; that is a decision, not a fix.

## Recipe B — isolate "our code" from "the API"

If Recipe A's PDF run fails, this tells a bug in `buildPdfParseRequest` apart from an
API-side rejection (e.g. if the deployed API requires a beta header for PDF document
input, or rejects `PRIMARY_MODEL` for document inputs — plan §4 R2; no code in this
repo has ever called `claude-sonnet-5` with a document block):

```sh
B64=$(base64 -w0 ./local-only/resume.pdf)
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"claude-sonnet-5\",\"max_tokens\":1024,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"document\",\"source\":{\"type\":\"base64\",\"media_type\":\"application/pdf\",\"data\":\"$B64\"}},{\"type\":\"text\",\"text\":\"Reply with the first line of this document only.\"}]}]}" | jq .
```

- Works here but not through the route → our request builder or handler is wrong.
- Fails here too → an API-level requirement (beta header / model support). Add it in
  `callAnthropic` and **record it as a deviation** on the ticket.

## Cost

Each full Recipe-A pass is roughly 3 × ~$0.03 ≈ $0.10 (PRD §9). Intentionally not in
CI, which would otherwise pay this on every push.

## Write-back rule (ticket Feedback obligation #1)

`lib/parse/prompt.ts` is new, hand-authored content — there is no legacy prompt asset
(02-evaluation/README.md open question #2). If it fails any check above:

1. Fix the prompt here, and
2. record the input that caught it as feedback into `02-evaluation`'s corpus (extend
   `fixtures/manifest.json` and/or add a regression note to `02-evaluation/README.md`'s
   changelog),

so the failure mode cannot be silently re-introduced later.
