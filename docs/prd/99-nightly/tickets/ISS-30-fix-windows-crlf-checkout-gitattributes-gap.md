---
id: ISS-30
title: Fix Windows CRLF checkout materialization breaking vitest parsing (.gitattributes coverage gap)
module: 99-nightly
lane: 99-nightly
size: S
agent: builder
status: draft
date: 2026-07-22
blocked_by: []
blocks: []
---

# ISS-30 — Fix Windows CRLF checkout materialization breaking vitest parsing (.gitattributes coverage gap)

Sourced from tracker issue #30 ("Windows checkout materializes .ts/.mjs as CRLF and breaks vitest parsing — .gitattributes only covers .claude/**"), triaged via the nightly sweep. Not part of any feature PRD module — `99-nightly` is the pipeline's own bucket for maintenance/bug tickets synthesized from tracker issues outside an existing sub-PRD's scope, per `.claude/agents/triage.md` ("write a ticket file at `docs/prd/99-nightly/tickets/ISS-<number>-<slug>.md`"). No parent sub-PRD README exists for this module (it is not a product feature area); the master spec `docs/PRD.md` is not implicated — this is a repo-hygiene/git-config fix, not a product-behavior change.
**Why `builder`:** a mechanical config change (`.gitattributes` + a renormalization pass) with a fully inlined diagnosis and a mechanical acceptance check — no product-logic change, no open design question.

## Background + basis

Issue #30 body (verbatim), reproduced and independently sanity-checked by the triage stage before writing this ticket:

> ## Symptom
>
> After merging PLT-02, `corepack pnpm test` on `main` failed at the **file** level (not an assertion):
>
> ```
> FAIL tests/backup.test.ts [ tests/backup.test.ts ]
> SyntaxError: Invalid or unexpected token
>  ❯ tests/backup.test.ts:16:1
> Test Files  1 failed | 37 passed (38)
>      Tests  317 passed (317)      <- the file's 16 tests never ran
> ```
>
> ## Root cause (confirmed empirically)
>
> `core.autocrlf=true` on Windows materializes files with CRLF at checkout. Vitest/esbuild then fails to parse `tests/backup.test.ts` + its import of the shebang'd `.github/scripts/backup.mjs`.
>
> Proof:
> ```
> worktree tests/backup.test.ts CR: 242     <- CRLF after checkout
> git blob tests/backup.test.ts CR: 0       <- LF in the repo (content is correct)
>
> rm tests/backup.test.ts .github/scripts/backup.mjs
> git -c core.autocrlf=false checkout -- tests/backup.test.ts .github/scripts/backup.mjs
> corepack pnpm exec vitest run tests/backup.test.ts
>   -> Test Files 1 passed (1) / Tests 16 passed (16)
> ```
>
> Full suite with LF-materialized files: **38 files / 333 tests green.**
>
> ## Why review missed it
>
> The Builder *authored* these files with LF, so they stayed LF in that working tree for the whole build+review session — the file is only re-materialized as CRLF on a subsequent `git checkout`. The Reviewer legitimately observed `tests/backup.test.ts 16/16` green. The failure appears only after a branch switch, a fresh clone, or the post-merge DoD run. Reproduced on branch `ticket/PLT-02` itself after a checkout, so this is **not** a merge regression.
>
> CI (Linux, no autocrlf) is expected to be unaffected — this bites Windows working copies and every post-merge DoD test run performed by `deliver-ticket.mjs`.
>
> ## Affected area
>
> `.gitattributes` currently pins only the agent-templates scripts:
>
> ```
> .claude/workflows/*.js text eol=lf
> .claude/scripts/*.mjs text eol=lf
> ```
>
> Nothing covers `tests/**`, `.github/scripts/**`, or source `*.ts`/`*.tsx`. Any future ticket that adds a `.mjs` (especially with a shebang) or certain `.ts` files can reproduce this on its own merge.
>
> ## Acceptance
>
> - [ ] `[machine]` `.gitattributes` guarantees LF materialization for the source/test file types this repo uses (at minimum `*.ts`, `*.tsx`, `*.mjs`, `*.js`; a repo-wide `* text=auto eol=lf` is acceptable if justified).
> - [ ] `[machine]` After `git rm --cached -r .` + re-checkout (or equivalent renormalization), `tr -dc '\r' < tests/backup.test.ts | wc -c` returns 0.
> - [ ] `[machine]` `corepack pnpm test` green on a freshly re-checked-out working tree — i.e. green *after* a branch switch, not only in the authoring session.
> - [ ] `[machine]` Binary assets (if any) are not corrupted by the new rules — verify no unintended entries are line-ending-normalized.
> - [ ] `[machine]` The existing `.claude/**` LF rules keep working (the Workflow tool rejects CRLF scripts).
>
> ## Impact / urgency
>
> Blocks reliable Definition-of-Done checks: `deliver-ticket.mjs` runs the suite immediately after `git checkout main` + merge, which is exactly when new files get CRLF. PLT-02 (#26) was merged with `dodPassed=false` for this reason alone — its code is fine. With 13 tickets still to deliver, this will keep producing false-red DoD failures until fixed.

Triage-stage sanity checks performed on this session's working tree (facts this ticket relies on beyond the issue text — do not re-derive, but do re-verify the same commands still hold before building):

- `pnpm` is **not** on `PATH` on the machine this pipeline runs on — always invoke it via `corepack pnpm ...`, never bare `pnpm`.
- Current `.gitattributes` content in full (verbatim), including its own line endings (it has CRLF line endings within the file itself — that is cosmetic and out of this ticket's required scope, but note it in case the chosen rule ends up also matching `.gitattributes` itself):
  ```
  # agent-templates: Workflow tool rejects CRLF scripts (keep LF)
  .claude/workflows/*.js text eol=lf
  .claude/scripts/*.mjs text eol=lf
  ```
- **Full-repo blob scan (194 tracked files at `git ls-files | wc -l`):** for every single tracked file, `git show main:<path> | tr -dc '\r' | wc -c` returns `0` — i.e. **zero** tracked blobs in this repository currently contain any CR byte, repo-wide, not just for `tests/backup.test.ts`. This means the committed content is already fully LF-clean; the bug is 100% checkout-time materialization (client `core.autocrlf` vs. `.gitattributes` coverage gap), not a content problem. Practically: a renormalization pass (`git add --renormalize .`) is expected to be a **no-op** in this repo today (0 files rewritten) — but it must still be run and its result asserted, not assumed, because the point of running it is to catch any file that does need it (now or after a future merge), and skipping the run would mean nobody ever actually checked.
- **No binary assets are tracked in this repo at all.** `git ls-files | grep -Ei '\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|pdf|zip|gz|db|sqlite|wasm)$'` returns nothing. The full extension tally across all 194 tracked files is: `85 md, 64 ts, 13 tsx, 9 mjs, 8 json, 3 sql, 3 js, 3 gitkeep, 2 yml, 1 yaml, 1 gitignore, 1 gitattributes, 1 example` — text-only. `fixtures/**` (the resume/JD test corpus) is all `.md`/`.json`, not real binary PDFs/DOCX — confirmed by `docs/prd/03-library/tickets/LIB-01-parse-route.md`'s own acceptance checklist, which deliberately uses `.md` fixtures with the pasted-plain-text code path (not real binary files) to keep tests fast and deterministic. So the binary-corruption risk this ticket must guard against is **currently theoretical** — there is nothing to break today — but the chosen rule must still be robust to a future binary file being added (e.g. by a later ticket), not merely "safe because nothing exists to break right now."
- **Nothing is in flight.** `git branch -a` at authoring time lists only `main` plus branches already merged into it (`git branch --merged main` confirms `ticket/EVL-01`, `ticket/EVL-02`, `ticket/FND-01` through `ticket/FND-10`, `ticket/ISS-29`, `ticket/PLT-01`, `ticket/PLT-02` are all merged). None of `LIB-01`, `LIB-02`, `LIB-03`, `FIT-01`, `FIT-02`, `FIT-03`, `TLR-01`, `TLR-02`, `PRP-01`, `PRP-02`, `PRP-03`, `PRP-04`, `PLT-03`, `PLT-04` has a branch yet, and every one of those 14 ticket files has `status: draft` — confirmed by reading each file's frontmatter directly. There is no live file-scope collision with this ticket today.

## Goal

`.gitattributes` guarantees LF checkout materialization — on any client, regardless of that client's local `core.autocrlf` setting — for every source/test file type this repo actually uses, proven by a **fresh re-materialization** of the working tree (not merely a green run in the authoring session). This is the exact distinction that let the same false-green failure mode slip past three prior Reviewers/Builders in a row (PLT-02, EVL-02, and this issue's own discovery context) — a working tree that was merely authored with LF looks identical to a correctly-configured one until it is torn down and rebuilt from the committed objects.

## Non-goals

- No content edit to `tests/backup.test.ts` or `.github/scripts/backup.mjs` — their committed blobs are already LF (0 CR bytes, confirmed above); there is nothing wrong with their content. This ticket is purely a `.gitattributes` + renormalization mechanism fix, never a hand-edit to test or script bodies.
- No change to any application/route/library/test logic anywhere else in the repo.
- No `.editorconfig` or IDE-level line-ending settings — out of scope, and would not actually fix this bug: `.gitattributes` is git's own authoritative mechanism for controlling what bytes land on disk at `git checkout` time, which is the exact operation that breaks vitest here (see Feedback obligation item 1 for what to do if this assumption turns out wrong).
- No unrelated repo-hygiene sweep (reformatting, dependency bumps, script rewrites) riding along with the renormalization commit — the renormalization commit must contain ONLY mechanical line-ending changes caused by the new `.gitattributes` rules, nothing else.

## File-scope (write-owns)

- `.gitattributes` — the ticket's one hand-authored file. The Builder chooses between a broad `* text=auto eol=lf` rule and targeted per-extension rules (Deliverable 1) and must write the justification directly into the file as a comment.
- Renormalization side effects: whichever tracked files' stored/materialized form `git add --renormalize .` touches as a mechanical consequence of the new rules. Per the full-repo blob scan above, this is expected to be a **no-op** (0 files) in this repo today — the command must still be run and its result recorded (Deliverables 2-3), not assumed.
- Does not touch: no test assertions, no route/lib logic, no CI workflow YAML *content* (`.github/workflows/*.yml` may only be swept by the mechanical renormalization pass if `.yml` ends up covered by the chosen rule — never hand-edited).
- Serial-safety: nothing is currently in flight (Background) — `git branch -a` shows no branch yet for any of `LIB-01..03`, `FIT-01..03`, `TLR-01/02`, `PRP-01..04`, `PLT-03/04`, and all 14 are `status: draft`. There is no live collision today. However, because this ticket's renormalization step is repo-wide by construction (it walks every tracked path in one pass), it inherently touches files across every module directory in the single commit it produces (Deliverable 2). This ticket should therefore merge to `main` **before** any of those 14 tickets are branched — if one of their branches is cut first and this ticket's `.gitattributes`/renormalization commit lands on `main` afterward, that branch would still carry the stale `.gitattributes` and its own eventual merge could reproduce this exact bug independently for its own new files. Record this as a scheduling note in Feedback obligation item 3, not as a blocking dependency (`blocked_by: []` stays empty — nothing today actually blocks this ticket, and it blocks nothing that exists yet either, so `blocks: []` also stays empty; the ordering constraint is advisory for whoever sequences the next milestone batch).

## Deliverables

1. Edit `.gitattributes` to guarantee LF checkout materialization for every source/test file type this repo currently uses, at minimum `*.ts`, `*.tsx`, `*.mjs`, `*.js` (issue #30's own acceptance floor), while preserving the two existing `.claude/**` rules **verbatim**: `.claude/workflows/*.js text eol=lf` and `.claude/scripts/*.mjs text eol=lf` — do not delete, weaken, or reorder them in a way that changes their effective outcome. Choose exactly one shape and justify the choice with a one-line comment written into `.gitattributes` itself (matching the existing comment style, e.g. `# agent-templates: Workflow tool rejects CRLF scripts (keep LF)`), citing this ticket id `ISS-30`:
   - **(a) Repo-wide `* text=auto eol=lf`.** Justification to write in: simplest single line; self-extends to any future file type any of the 14 not-yet-started tickets (or any later ticket) introduces, with no further `.gitattributes` edits ever required again for this class of bug; safe for binaries because `text=auto` only normalizes paths git's own content-sniffing heuristic classifies as text (a NUL byte, or a high enough proportion of non-printable bytes, in roughly the first 8000 bytes of the blob marks it binary and exempts it from any eol conversion — this is git's documented `core.autocrlf`/`text=auto` detection mechanism, not a guess). Because it is a catch-all, it is a strict superset of the two existing `.claude/**` rules' effect (both already resolve to LF; `* text=auto eol=lf` also resolves those same paths to LF), so ordering between the catch-all and the two specific lines does not change the outcome for `.claude/**` — confirm this explicitly in the Changelog if this option is chosen.
   - **(b) Targeted per-extension rules.** `*.ts text eol=lf`, `*.tsx text eol=lf`, `*.mjs text eol=lf`, `*.js text eol=lf`, plus any other extensions judged necessary from the repo's actual current inventory (Background's tally: `.json`, `.md`, `.yml`/`.yaml`, `.sql` are the other text types actually present). Justification to write in: explicit and auditable — no reliance on `text=auto`'s content-sniffing heuristic ever misclassifying an unusual future file.
   Either way, do not remove the pre-existing `.claude/**` lines from the file.
2. Run `git add --renormalize .` immediately after step 1, in its **own commit**, separate from the `.gitattributes` edit commit — minimum two commits: commit A = the `.gitattributes` content change only; commit B = the renormalization pass. This keeps the reviewable diff small even if it turns out non-trivial: commit A's diff is a handful of `.gitattributes` lines; commit B's diff, if non-empty, is purely mechanical line-ending churn, and its commit message must say so explicitly (e.g. `mechanical: git add --renormalize . — N files, line-ending only, no content change`) so the Reviewer can skim rather than line-by-line it. Per Background's full-repo blob scan (0 files currently have any CR byte), commit B is expected to be **empty** — if `git add --renormalize .` + `git status` shows nothing staged, do not force an empty commit; instead record in this ticket's Changelog that the renormalization pass was run and confirmed a no-op, with the exact command output/file count.
3. Verification pass, performed **after** commits A (and B, if non-empty) exist locally, that simulates the actual failure scenario (a fresh checkout/branch-switch/post-merge DoD run), not merely a green authoring working tree: fully drop and re-derive the working tree's materialized files from the committed objects — `git rm --cached -r . -q && git reset --hard HEAD` (re-checks-out every tracked file honoring the *new* `.gitattributes`) — then confirm both (a) `tr -dc '\r' < tests/backup.test.ts | wc -c` prints `0`, and (b) `corepack pnpm test` is green. Run this fresh-checkout-then-test sequence **twice** consecutively (Acceptance item 7) to rule out any residual flakiness in the fix itself. A green run in the ordinary authoring working tree, without this teardown-and-rebuild step, does **not** satisfy this ticket — that is exactly the false-green pattern documented in issue #30's "Why review missed it" section.

## Acceptance checklist (classified)

- [ ] `[machine]` `.gitattributes` resolves `*.ts`, `*.tsx`, `*.mjs`, and `*.js` to an LF rule — either via explicit per-extension lines or via a repo-wide `* text=auto eol=lf` catch-all (confirm by grepping `.gitattributes` for the relevant line(s), whichever shape was chosen).
- [ ] `[machine]` The two pre-existing rules are still present verbatim: `grep -F '.claude/workflows/*.js text eol=lf' .gitattributes` and `grep -F '.claude/scripts/*.mjs text eol=lf' .gitattributes` both match exactly one line each, unchanged.
- [ ] `[machine]` **Fresh-materialization proof (the item that matters most — this is precisely what fooled 3 prior Reviewers):** after `git rm --cached -r . -q && git reset --hard HEAD` run from a clean working tree (no uncommitted changes beforehand) on the branch carrying this ticket's commits, `tr -dc '\r' < tests/backup.test.ts | wc -c` prints `0`.
- [ ] `[machine]` Immediately following that same fresh re-materialization (not a separately-restored working tree, not the authoring session's tree), `corepack pnpm test` exits 0 with every file passing — baseline to match or exceed: 38 files / 333 tests (Background); if other tickets landed between authoring and build the exact counts may differ, but zero failures is the bar.
- [ ] `[machine]` That fresh-materialization-then-test sequence is repeated a second consecutive time and is also green (Deliverable 3) — mirrors ISS-29's own "twice in a row" bar, applied here to the checkout/test cycle rather than a single test file.
- [ ] `[machine]` `git add --renormalize .` was run once (after the `.gitattributes` edit, before the fresh-checkout proof) and its result matches the Background scan's expectation: either it reports zero files needing rewriting (expected outcome — record the confirming command/output in the Changelog), or — if non-zero — every changed file is enumerated in the Changelog and individually spot-checked via `git diff <file>` to show only line-ending changes (no non-whitespace hunks).
- [ ] `[machine]` No binary asset is corrupted by the rule: re-run `git ls-files | grep -Ei '\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|pdf|zip|gz|db|sqlite|wasm)$'` after the fix lands and confirm it is still empty (proves the ticket itself introduced no binary regression); if option (a) `* text=auto eol=lf` was chosen, additionally record in the Changelog the specific git heuristic being relied on (content-sniffing: a NUL byte, or a high-enough proportion of non-text bytes, in roughly the first 8000 bytes of the blob marks it binary and exempt from eol conversion) rather than merely asserting "it's safe."
- [ ] `[machine]` The `.gitattributes` edit and the renormalization pass are separate, identifiable commits — `git log --oneline` on this ticket's branch shows two distinct commits, OR the renormalization commit is documented as skipped-because-empty per Deliverable 2 (in which case one commit is acceptable, with the Changelog explanation standing in for the second commit).

No `[human]` criteria — this is a self-contained, mechanically verifiable infra fix. The rule-shape choice (Deliverable 1's (a) vs (b)) is delegated to the Builder with a mandatory written justification, not a judgment call that needs human escalation.

## Test plan

1. Reconfirm the regression is real before changing anything: from a clean `main` checkout, force the CRLF-on-checkout condition exactly as issue #30's own reproduction does — `rm tests/backup.test.ts .github/scripts/backup.mjs && git -c core.autocrlf=true checkout -- tests/backup.test.ts .github/scripts/backup.mjs` (note: this requires `core.autocrlf=true` in the ambient git config, which is already this machine's setting per Background) — then run `corepack pnpm test` and confirm the exact reported failure shape (`FAIL tests/backup.test.ts` / `SyntaxError: Invalid or unexpected token` at `tests/backup.test.ts:16:1`). This is the regression baseline; do not skip it even though the root cause is already confirmed — a baseline proves the fix actually changes something.
2. Apply Deliverable 1 (`.gitattributes` edit); commit as commit A.
3. Run `git add --renormalize .`; inspect `git status` / `git diff --stat --cached` for the file count; commit as commit B if non-empty, or record the no-op in the Changelog per Deliverable 2.
4. Run the fresh-materialization-then-test sequence from Deliverable 3 / Acceptance items 3-4, twice consecutively (Acceptance item 5).
5. Re-run the binary-safety scan (Acceptance item 7).
6. `git log --oneline` on the ticket branch to confirm commit separation (Acceptance item 8).
7. Confirm the two `.claude/**` rules are untouched (Acceptance item 2). Do not write a new test for the Workflow tool's CRLF rejection itself — that enforcement mechanism already exists and is outside this ticket's scope; the grep check is sufficient to prove this ticket did not regress it.

## Feedback obligation

1. General rule: if implementation reveals that `.gitattributes` alone cannot force LF materialization independent of a client's `core.autocrlf` setting on the actual delivery machine (e.g. some git version/config interaction where `.gitattributes` is overridden or ignored), that falsifies this ticket's Background/Goal — stop, update this ticket (version +0.1, changelog line) with the actual finding, and escalate rather than silently substituting a different mechanism. In particular, do not fall back to an `.editorconfig`-only fix as a silent substitute — `.editorconfig` does not affect what `git checkout` writes to disk and would not actually close issue #30.
2. If `git add --renormalize .` (Deliverable 2) turns up any file with a diff beyond pure line-ending changes, or any path the Builder cannot confirm is safe to renormalize (in particular anything that would match the binary-extension list even though today's scan found none), stop before committing it: exclude that specific path with a targeted `-text` (or path-specific) override added to `.gitattributes`, and record the exclusion plus the reason in this ticket's Changelog. Do not force-renormalize a file whose safety cannot be confirmed.
3. Scheduling note for whoever sequences the next milestone batch (not this ticket's job to enforce, only to flag): because this ticket's renormalization pass is repo-wide by construction, it should merge to `main` before `LIB-01`, `LIB-02`, `LIB-03`, `FIT-01`, `FIT-02`, `FIT-03`, `TLR-01`, `TLR-02`, `PRP-01`, `PRP-02`, `PRP-03`, `PRP-04`, `PLT-03`, or `PLT-04` are branched (File-scope). None of the 14 are in flight as of this ticket's authoring — this is a forward-looking scheduling note, not a blocker discovered mid-ticket. If, contrary to the authoring-time state recorded in Background, the Builder finds one of those 14 already has a branch cut by the time this ticket is built, stop and escalate under Rule 1's general clause rather than silently proceeding or rebasing it.
4. This ticket closes the false-red Definition-of-Done risk documented in issue #30's "Impact/urgency" (the proximate cause of PLT-02 (#26)'s historical `dodPassed=false`, though PLT-02 is already merged and not itself blocked by this ticket) for every future ticket delivery. Once merged with both fresh-materialization test runs green, that is the full scope of this ticket; re-verifying any specific past ticket's Definition-of-Done status is `/verify-delivery`'s job, not this ticket's.

## Changelog

### v0.1 (2026-07-22, ISS-30 Builder writeback)

Built on branch `ticket/ISS-30` from `main` @ `7a55be3`. Plan followed as written (`docs/plans/ISS-30.md`); no deviations.

**Rule shape chosen: option (a), repo-wide `* text=auto eol=lf`** (plan §2.2). Why: the repo is provably text-only today (195 tracked files, extension tally text-only, binary-extension scan empty, 0 CR bytes across all blobs); a targeted per-extension list would need ≥12 patterns today and would silently miss whatever file type the next of the 14 queued tickets introduces — the catch-all kills the bug class rather than one instance, with no further `.gitattributes` edits ever needed for it. The mandatory justification is written into `.gitattributes` itself as the `# ISS-30: ...` comment.

**Ordering confirmation (acceptance item 2 / plan §2.1).** The catch-all was placed FIRST and the two pre-existing `.claude/**` lines LAST, verbatim — commit A's diff is `1 file changed, 3 insertions(+)`, zero deletions, so the existing lines are byte-identical. gitattributes resolution is last-match-wins per attribute, so those paths still resolve through their own unconditional rules: `git check-attr text eol` reports `text: set` / `eol: lf` for `.claude/workflows/run-milestone.js` and `.claude/scripts/publish-tickets.mjs` (i.e. `text` *set*, not `auto` — unchanged from before the edit), and `git ls-files --eol .claude/workflows/ .claude/scripts/` shows all six files at `i/lf w/lf attr/text eol=lf`, the identical string as before. Both orderings resolve those paths to LF; this ordering makes the no-change property exact.

**Renormalization pass (Deliverable 2 / acceptance item 6): run once, confirmed a no-op — commit B skipped, not forced.** Run immediately after commit A:

```
$ git add --renormalize .
(exit 0, no output)
$ git status --porcelain
(empty)
$ git diff --cached --stat
(empty)
$ git diff --cached --name-only | wc -l
0
```

Zero files needed rewriting, matching the Background full-blob scan's expectation. Per Deliverable 2 no empty commit was forced; this entry is the required record. No `-text` exclusion was needed (Feedback obligation 2 did not trigger — nothing was staged to inspect).

**Regression baseline — the red was forced and observed first (Test plan step 1).** From clean `ticket/ISS-30` before commit A:

```
$ rm tests/backup.test.ts .github/scripts/backup.mjs
$ git -c core.autocrlf=true checkout -- tests/backup.test.ts .github/scripts/backup.mjs
$ tr -dc '\r' < tests/backup.test.ts | wc -c        -> 242     (exactly issue #30's number)
$ tr -dc '\r' < .github/scripts/backup.mjs | wc -c  -> 154
$ git ls-files --eol tests/backup.test.ts .github/scripts/backup.mjs
  i/lf  w/crlf  attr/    tests/backup.test.ts
  i/lf  w/crlf  attr/    .github/scripts/backup.mjs
$ corepack pnpm test
  FAIL tests/backup.test.ts [ tests/backup.test.ts ]
  SyntaxError: Invalid or unexpected token
   -> tests/backup.test.ts:16:1
  Test Files  1 failed | 37 passed (38)
       Tests  317 passed (317)
  exit 1
```

Failure shape matches issue #30 verbatim (file, error, `16:1`, 1 failed/37 passed, 317 tests). The fix therefore demonstrably changes something.

**Fresh-materialization proof, run TWICE consecutively (Deliverable 3 / acceptance items 3-5).** Each cycle from a clean tree (`git status --porcelain` empty as a hard precondition), tearing the working tree down and re-deriving every tracked file from the committed objects under the new `.gitattributes`:

| | cycle 1 | cycle 2 |
|---|---|---|
| `git rm --cached -r . -q && git reset --hard HEAD` | ok, `git status --porcelain` empty | ok, `git status --porcelain` empty |
| `tr -dc '\r' < tests/backup.test.ts \| wc -c` | **0** | **0** |
| `tr -dc '\r' < .github/scripts/backup.mjs \| wc -c` | **0** | (canary pair `w/lf`) |
| `git ls-files --eol` on the canary pair | `i/lf w/lf attr/text=auto eol=lf` (both) | `i/lf w/lf attr/text=auto eol=lf` (both) |
| `git ls-files --eol \| grep -Ec 'w/crlf\|w/mixed'` | **0** (was 140 crlf + 1 mixed) | **0** |
| `corepack pnpm test` | **38 passed (38) files / 333 passed (333) tests, exit 0**, 13.45s | **38 passed (38) files / 333 passed (333) tests, exit 0**, 14.02s |

Both cycles green with zero failures, meeting the 38/333 baseline. This is green *after* a full teardown-and-rebuild from committed objects, not merely a green authoring tree — the distinction that produced the false-greens documented in issue #30's "Why review missed it".

**Binary safety (acceptance item 7).** Post-fix re-scan `git ls-files | grep -Ei '\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|pdf|zip|gz|db|sqlite|wasm)$'` is still empty (grep exit 1) — this ticket introduced no binary regression. Because option (a) was chosen, the specific git mechanism relied on, per acceptance item 7's requirement to name it rather than assert safety: `text=auto` applies eol conversion only to blobs git's own content-sniffing heuristic classifies as text — a NUL byte, or a high enough proportion of non-printable bytes, within roughly the first 8000 bytes of the blob marks it binary and exempts it from *all* eol conversion (git's documented `core.autocrlf`/`text=auto` detection). Future NUL-bearing binaries (PNG/PDF/ZIP/WOFF) are exempt by construction. The known heuristic edge — UTF-16 text contains NULs and is sniffed as binary — fails *safe*: such a file is left untouched, never corrupted.

**Commit shape (acceptance item 8).** `git log --oneline main..HEAD` on `ticket/ISS-30`:

```
<C> ISS-30: writeback — Changelog (rule shape, renormalize no-op, both fresh-materialization proofs)
7132a49 ISS-30: repo-wide LF materialization rule (* text=auto eol=lf) — fixes CRLF checkout breaking vitest (#30)
17c8408 ISS-30: commit Architect implementation plan
```

Commit A (`7132a49`) is the `.gitattributes` change alone; commit B is absent and documented as skipped-because-empty above, per acceptance item 8's escape clause; commit C is this Changelog append only. `git diff main..HEAD --stat` lists exactly `.gitattributes` (3 insertions) and `docs/plans/ISS-30.md` (the plan, committed per repo convention) before commit C adds this ticket file — no third content-bearing file, so no renormalization churn was smuggled in.

**Scheduling flag repeated (Feedback obligation 3 / plan §5 Q1).** Re-verified at build time: `git branch -a` lists only `main`, `origin/main`, and 15 already-merged `ticket/*` branches — none of `LIB-01..03`, `FIT-01..03`, `TLR-01/02`, `PRP-01..04`, `PLT-03/04` has a branch, so nothing collided and no escalation was triggered. Forward-looking: this ticket should merge to `main` **before** any of those 14 cut a branch, or such a branch would carry the stale `.gitattributes` and reproduce this bug for its own new files at its own merge. Advisory for whoever sequences the next milestone batch; not a blocker (`blocked_by`/`blocks` stay empty).
