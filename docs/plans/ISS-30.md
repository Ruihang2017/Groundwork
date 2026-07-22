# Implementation plan — ISS-30: Fix Windows CRLF checkout materialization breaking vitest parsing (.gitattributes coverage gap)

Ticket: [docs/prd/99-nightly/tickets/ISS-30-fix-windows-crlf-checkout-gitattributes-gap.md](../prd/99-nightly/tickets/ISS-30-fix-windows-crlf-checkout-gitattributes-gap.md)
Sub-PRD: none — `99-nightly` is the pipeline's maintenance lane (no product README); `docs/PRD.md` is not implicated (git-config/repo-hygiene fix, no product-behavior change).
ADRs: none exist (`docs/adr/` contains only `.gitkeep`), and **this change is not an ADR candidate** — the line-ending policy is a single `.gitattributes` line, reversible by editing that line and re-running the (no-op) renormalization; no stored content changes either way, so reversal cost is near zero.
Base commit: `7a55be3` on `main` (working tree clean at planning time; that commit is the ISS-30 triage ticket itself). Branch per repo convention: `ticket/ISS-30`.

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone. Two standing environment rules: **always invoke pnpm as `corepack pnpm ...`** (bare `pnpm` is not on `PATH` on this machine), and **run every verification command below via the Bash tool** (they are POSIX — `tr`, `wc`, `grep`; PowerShell does not have them). Every Bash invocation on this machine prints a harmless first line `/c/Users/HoraceHou/.bash_profile: line 1: $'\377\376source': command not found` — that is the user's UTF-16-BOM'd `~/.bash_profile`, **not** a repo file; ignore it and do not "fix" it (out of scope).

## 0. Repo-state check performed for this plan (verified 2026-07-22 at `7a55be3` by direct inspection — Builder: re-verify the cheap ones, do not re-derive the expensive ones)

- **`core.autocrlf=true` is set at SYSTEM scope**: `git config --show-scope --show-origin core.autocrlf` → `system  file:C:/Program Files/Git/etc/gitconfig  true`. Not local, not global — it governs every clone on this machine, including the working tree `deliver-ticket.mjs` re-checks-out for the post-merge DoD run (`.claude/scripts/deliver-ticket.mjs:124` does `git checkout <DEFAULT_BRANCH>` before running the suite — that is the exact moment newly-merged files materialize as CRLF today).
- **`.gitattributes` current content is exactly the 3 lines the ticket quotes** (comment + two `.claude/**` rules), nothing else.
- **195 tracked files** (`git ls-files | wc -l`; ticket said 194 — the +1 is the ISS-30 ticket file itself, committed by triage). Extension tally: 86 `md`, 64 `ts`, 13 `tsx`, 9 `mjs`, 8 `json`, 3 `sql`, 3 `js`, 3 `gitkeep`, 2 `yml`, 1 `yaml`, 1 `gitignore`, 1 `gitattributes`, 1 `example`. **Text-only**; the ticket's binary-extension grep returns nothing.
- **Full blob scan re-run this session at `7a55be3`: 0 of 195 tracked blobs contain any CR byte** (`git show HEAD:<path> | tr -dc '\r' | wc -c` = 0 for every path). The renormalization pass in §2.3 is therefore still expected to be a no-op — run it and assert it anyway, per the ticket.
- **Worktree materialization state right now (`git ls-files --eol`): 140 of 195 files are `w/crlf`** (including `.gitattributes` itself and most `.ts`/`.tsx`), **1 file is `w/mixed`** (`CLAUDE.md`), and — the deceptive part — **`tests/backup.test.ts` and `.github/scripts/backup.mjs` are currently `w/lf`** (0 CR bytes in the worktree copy of `backup.test.ts`, measured). They are sitting in the authored-LF state that fooled three prior sessions: the suite is green *today* and flips red only after those two files are re-materialized. The Builder MUST NOT take today's green as evidence of anything.
- **Planning-time baseline: `corepack pnpm test` at `7a55be3` is GREEN — `38 passed (38)` files / `333 passed (333)` tests, ~13.6s** — exactly the ticket's baseline numbers. Consequence: the red regression baseline in §3 step 1 must be *forced* via re-materialization; it will not appear on its own in this tree.
- **The mechanism the fix relies on is already empirically proven on this machine**: the six files under the existing rules (`.claude/workflows/*.js`, `.claude/scripts/*.mjs`) all show `i/lf w/lf attr/text eol=lf` in `git ls-files --eol` — i.e. the in-tree `eol=lf` attribute **defeats** system-scope `core.autocrlf=true` at checkout, on this exact git install. The fix below just extends that proven mechanism to everything.
- **Why only this file pair breaks while 140 other CRLF files parse fine**: `tests/backup.test.ts:16` is the start of the multi-line `import {...} from '../.github/scripts/backup.mjs'` (the exact `16:1` SyntaxError location issue #30 reports), and `backup.mjs:1` is a `#!/usr/bin/env node` shebang. The pair is the repo's CRLF-sensitive canary; a green suite with CRLF elsewhere does NOT disprove the coverage gap. Do not investigate the byte-level esbuild behavior further — the issue's empirical reproduction is the authority.
- **Serial-safety re-verified**: `git branch -a` lists only `main` + 15 already-merged `ticket/*` branches. None of `LIB-01..03`, `FIT-01..03`, `TLR-01/02`, `PRP-01..04`, `PLT-03/04` has a branch. If that has changed by build time, **stop and escalate** per ticket Feedback obligation 3 — do not proceed.
- git on this machine supports `--show-scope` (≥2.26) and `git add --renormalize` (≥2.16) — both used successfully this session.
- Ticket-changelog convention (PLT-02 precedent): the Builder **appends** a `## Changelog` section with dated `v0.1 (...)` entries to the ticket file at writeback; the ISS-30 ticket currently has no such section — create it.

## 1. Scope

**In scope** — one hand-authored file plus bookkeeping:

- `.gitattributes`: add one catch-all rule + one justification comment (§2.1). The two existing `.claude/**` lines survive **byte-for-byte verbatim**.
- `git add --renormalize .` run once, result asserted (expected no-op → no commit; if non-empty → its own mechanical commit, §2.3).
- Ticket file `docs/prd/99-nightly/tickets/ISS-30-fix-windows-crlf-checkout-gitattributes-gap.md`: append the `## Changelog` section the ticket's own acceptance items require (renormalize evidence, ordering confirmation, binary-heuristic note, both proof-run results). This is self-referential bookkeeping the ticket text mandates, not scope creep.

**Explicitly out of scope** (ticket Non-goals — do not do these even opportunistically):

- No content edit to `tests/backup.test.ts`, `.github/scripts/backup.mjs`, or any test/route/lib/config source. Their blobs are already LF-clean.
- No `.editorconfig`, no IDE settings — they do not control what `git checkout` writes to disk and would not close issue #30 (Feedback obligation 1 covers the escalation path if `.gitattributes` itself proves insufficient).
- **No edit to the machine's git config** — do not touch `C:/Program Files/Git/etc/gitconfig` or set `core.autocrlf` anywhere. A machine-config "fix" is uncommittable, leaves every other clone broken, and is exactly the silent-substitute the ticket forbids.
- No hand-edit to `.github/workflows/*.yml` content, no reformatting sweep, no dependency bumps. The renormalization commit (if any) contains line-ending churn only.
- Do not "fix" the noisy `~/.bash_profile` (not a repo file).

## 2. Change list

### 2.1 The edit — `.gitattributes` (the only hand-authored file in commit A)

Replace the file's entire content with **exactly** this (LF line endings, trailing newline at EOF):

```
# ISS-30: repo-wide LF materialization — core.autocrlf=true checkouts wrote CRLF and broke vitest parsing (issue #30); text=auto content-sniffing exempts true binaries, and the catch-all self-extends to every future file type with no further edits
* text=auto eol=lf

# agent-templates: Workflow tool rejects CRLF scripts (keep LF)
.claude/workflows/*.js text eol=lf
.claude/scripts/*.mjs text eol=lf
```

Load-bearing details:

- **The catch-all goes FIRST, the two existing lines stay LAST, verbatim.** gitattributes resolution is last-match-wins per attribute, so with this ordering the `.claude/**` paths keep resolving through their own unconditional `text eol=lf` lines — `git ls-files --eol` shows the identical `attr/text eol=lf` string for them before and after, i.e. literally zero change for the already-working rules. (Both orderings yield LF for those paths — the ticket's option-(a) text requires confirming this in the Changelog — but this ordering makes the no-change property exact, not merely equivalent.)
- The `# ISS-30: ...` line **is** the ticket's Deliverable-1 mandatory one-line justification, matching the existing comment style and citing the ticket id. Keep its substance; minor wording tightening is fine, the ticket id and the text=auto-binary-exemption rationale must survive.
- The Write tool may materialize the worktree file with either ending; the committed blob will be LF regardless (clean filter), and §3 step 5's teardown re-materializes it LF. Don't fight the editor over it.

### 2.2 Rule-shape decision — option (a) `* text=auto eol=lf`, and why not (b)

The ticket delegates the (a)/(b) choice to the Builder with a mandatory written justification; this plan pins **option (a)** and pre-drafts that justification (§2.1's comment). If the Builder switches to (b), that is a plan deviation — record it in the build report AND write (b)'s justification into the file per the ticket. Reasons (a) wins:

1. **The repo is provably text-only today** (§0: extension tally, empty binary grep, 0-CR blob scan) — there is nothing for the catch-all to misclassify now.
2. **A targeted list is already ≥12 patterns today and silently incomplete tomorrow.** Covering the actual inventory needs `*.ts *.tsx *.mjs *.js *.md *.json *.sql *.yml *.yaml` plus the extension-less `.gitignore`, `.gitattributes`, `.env.example` — and any future type a later ticket introduces (`.css`, `.svg`, `.sh`, `Dockerfile`, …) reproduces this exact bug class at that ticket's post-merge DoD run. The catch-all kills the bug class, not one instance; 14 file-adding tickets are queued behind this one.
3. **Future binaries are protected by git's own sniffing**: `text=auto` applies eol conversion only to blobs git's content heuristic classifies as text — a NUL byte, or a high enough proportion of non-printable bytes, within roughly the first 8000 bytes marks a blob binary and exempts it from ALL eol conversion (this is git's documented `core.autocrlf`/`text=auto` detection mechanism). A future PNG/PDF/ZIP/WOFF (all NUL-bearing) is exempt by construction. The known heuristic edge — UTF-16 text files contain NULs and get classified binary — fails **safe** here: such a file is left untouched, never corrupted. This paragraph's substance must be recorded in the Changelog per ticket acceptance item 7.
4. Issue #30's own acceptance explicitly blesses (a) "if justified" — items 1–3 are the justification.

### 2.3 Commit structure and the Changelog append (ticket Deliverable 2 + acceptance 8)

On branch `ticket/ISS-30`, in this exact order:

- **Commit A** — `.gitattributes` only (§2.1). Suggested message: `ISS-30: repo-wide LF materialization rule (* text=auto eol=lf) — fixes CRLF checkout breaking vitest (#30)`.
- **Renormalization gate** — `git add --renormalize .` immediately after commit A, then `git status --porcelain`:
  - **Expected (per §0's 0-CR scan): output is empty → skip commit B entirely.** Do NOT force an empty commit. Capture the exact command + empty result for the Changelog.
  - If non-empty: `git diff --cached --stat`, then `git diff --cached <file>` for **every** listed file. All hunks line-ending-only → **commit B** with message `mechanical: git add --renormalize . — <N> files, line-ending only, no content change`. Any non-eol hunk, or any file whose safety is unclear → **stop before committing**: `git reset` the stage, add a targeted `<path> -text` override to `.gitattributes` (amend commit A), record path + reason in the Changelog (ticket Feedback obligation 2).
- **Commit C (writeback)** — append `## Changelog` to the ticket file, single `v0.1 (2026-07-XX, ISS-30 Builder writeback)` entry containing, at minimum: chosen shape (a) + one-line why; the ordering-does-not-change-`.claude/**`-outcome confirmation (§2.1 bullet 1); the renormalize command + its verbatim (empty) result; the text=auto binary-sniffing heuristic note (§2.2 item 3); baseline red reproduction evidence (§3 step 1); both fresh-materialization proof runs' counts (§3 step 5); binary-scan-still-empty confirmation. Commit C must contain **only** the ticket-file append — no stray renormalization churn (there will be none if the gate was a no-op).

Predicted final branch shape: **two commits (A + C), with commit B documented as skipped-because-empty in the Changelog** — this satisfies acceptance item 8's escape clause. Reviewer should expect exactly this shape.

**Ordering constraint the Builder must not violate**: the fresh-materialization proof (§3 step 5) runs `git reset --hard`, which destroys uncommitted work. Run it only when `git status --porcelain` is empty — i.e. after commit A (and B if any), and **before** drafting the Changelog text of commit C (or commit C first and re-run the proof; either way, never with an uncommitted draft in the tree).

## 3. Test plan (steps mapped to the ticket's acceptance checklist; all commands from the repo root via the Bash tool)

1. **Regression baseline — force the red** (ticket Test-plan 1; today's tree is green per §0, so the failure must be materialized deliberately). On `ticket/ISS-30` before commit A, with `git status --porcelain` empty:
   ```
   rm tests/backup.test.ts .github/scripts/backup.mjs
   git -c core.autocrlf=true checkout -- tests/backup.test.ts .github/scripts/backup.mjs
   tr -dc '\r' < tests/backup.test.ts | wc -c        # expect >0 (issue #30 measured 242; non-zero is the assertion)
   git ls-files --eol tests/backup.test.ts           # expect w/crlf
   corepack pnpm test                                 # expect: FAIL tests/backup.test.ts — SyntaxError: Invalid or unexpected token at 16:1;
                                                      #         Test Files 1 failed | 37 passed (38); Tests 317 passed (317)
   ```
   Record the outputs. Note: `git status` stays clean afterwards (re-cleaned content matches the blob) — the CRLF'd pair cannot pollute commit A. Run the baseline **once**; do not loop.
2. **Commit A** (§2.1). Then prove the rules resolve (acceptance 1 + 2):
   ```
   grep -Fn '* text=auto eol=lf' .gitattributes                      # exactly 1 line
   grep -Fc '.claude/workflows/*.js text eol=lf' .gitattributes      # exactly 1
   grep -Fc '.claude/scripts/*.mjs text eol=lf' .gitattributes       # exactly 1
   git check-attr text eol -- tests/backup.test.ts .github/scripts/backup.mjs app/layout.tsx eslint.config.mjs \
       middleware.ts pnpm-lock.yaml CLAUDE.md .gitattributes .claude/workflows/run-milestone.js .claude/scripts/publish-tickets.mjs
   ```
   Expect: every path `eol: lf`; the two `.claude/**` paths `text: set` (unconditional — unchanged from today), all others `text: auto`.
3. **Renormalization gate** (§2.3; acceptance 6): `git add --renormalize .` → `git status --porcelain` empty (expected) → record; else the non-empty branch of §2.3.
4. *(precondition for step 5)* `git status --porcelain` must be empty; stop any dev-server/watcher processes (a Windows file lock would make `reset --hard` fail loudly).
5. **Fresh-materialization proof, TWICE consecutively** (acceptance 3 + 4 + 5 — the item that fooled three prior sessions; a green authoring tree does not count):
   ```
   cd /c/Users/HoraceHou/project/personal/Groundwork && git rm --cached -r . -q && git reset --hard HEAD
   git status --porcelain                              # expect empty (index+worktree fully rebuilt)
   tr -dc '\r' < tests/backup.test.ts | wc -c          # MUST print 0
   git ls-files --eol tests/backup.test.ts .github/scripts/backup.mjs   # expect w/lf, w/lf
   git ls-files --eol | grep -Ec 'w/crlf|w/mixed'      # expect it to print 0 (grep exits 1 on zero matches — printed 0 IS the pass; today this is 140+1)
   corepack pnpm test                                  # expect exit 0 — 38 files / 333 tests (zero failures is the bar; counts may only grow)
   ```
   Then run the entire block a second time; both iterations must be fully green. Untracked files (`node_modules`, `.env*`) are untouched by this sequence — no reinstall needed.
6. **Binary-safety re-scan** (acceptance 7): `git ls-files | grep -Ei '\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|pdf|zip|gz|db|sqlite|wasm)$'` → empty output / grep exit 1 **is the pass**. Heuristic note goes in the Changelog (§2.3).
7. **Commit C** (writeback, §2.3). Then commit-separation check (acceptance 8): `git log --oneline main..HEAD` → exactly commits A and C (B absent, documented as skipped-empty in the Changelog).
8. **`.claude/**` rules intact** (acceptance 2, again post-everything): the two `grep -F` checks from step 2, plus `git ls-files --eol .claude/workflows/ .claude/scripts/` → all six files still `i/lf w/lf attr/text eol=lf`. Do not write a new test for the Workflow tool's CRLF rejection — out of scope per the ticket.
9. No lint/build run is required: no lintable source file changes (`.gitattributes` is not in eslint's purview) and CI runs the suite + build post-push regardless. The two full-suite runs in step 5 are the gate.

## 4. Risks & edge cases (Reviewer: these are the checks that matter)

- **The false-green trap is the review-critical path.** A green `corepack pnpm test` in the Builder's session proves nothing — that exact observation passed three prior Builder/Reviewer sessions while the bug shipped. The only meaningful evidence is green **immediately after** `git rm --cached -r . -q && git reset --hard HEAD`, twice. Reviewer: re-run the step-5 block yourself in your own fresh checkout of the branch; do not accept transcript output as proof.
- **Re-smudge sufficiency of the teardown command.** `git rm --cached -r .` empties the index, so `git reset --hard HEAD` rebuilds every entry with no cached stat and rewrites all 195 files honoring the new attributes (this is the GitHub-documented line-ending refresh recipe). If, despite `git check-attr` showing `eol: lf`, the CR count is still non-zero after the sequence, first distinguish a wedged sequence from an ineffective rule via the targeted form `rm <file> && git checkout -- <file>` (unconditionally re-smudges). If the rule itself is proven ineffective against this git install, that falsifies the ticket's premise — **stop and escalate per Feedback obligation 1**; do not substitute `.editorconfig` or machine-config edits.
- **Repo-wide blast radius is bounded by the no-op expectation.** The only content-bearing diff allowed is commit A's `.gitattributes` + commit C's ticket append. Reviewer: `git diff main..HEAD --stat` must list exactly those two files; any third file means the renormalization gate found something (§2.3's non-empty branch) and every such hunk must be verifiably eol-only. `pnpm-lock.yaml` showing any hunk is an automatic stop (Feedback obligation 2).
- **`text=auto` misclassification** — theoretical today (zero binaries tracked, §0), fails safe for the known UTF-16 edge (sniffed binary → exempt → untouched, never corrupted). The risk surfaces only when a future ticket adds a real binary; the in-file comment + Changelog note are the documentation trail. No `-text` overrides are needed today.
- **Concurrency / sequencing** — no product concurrency is touched. The pipeline-level analog: this ticket must merge to `main` **before** any of the 14 pending tickets cut a branch (a stale-`.gitattributes` branch would reproduce the bug for its own new files at its own merge). §0 verified none exist; the Builder re-verifies at start and **escalates instead of proceeding** if one appeared (Feedback obligation 3). The writeback must repeat the merge-first scheduling flag for whoever sequences the next milestone batch. Also Windows-specific: no watcher/dev-server may hold file locks during step 5's `reset --hard`.
- **Security-sensitive paths** — none touched: no auth/session/db/route code is in the diff. The security-adjacent property to verify is exactly the diff-surface bound above (a repo-wide mechanism ticket must not smuggle content changes; the 0-CR blob scan + empty renormalize are the mechanical guarantee stored bytes are untouched).
- **Destructive-command safety** — `git reset --hard` discards uncommitted work; `git status --porcelain` empty is a hard precondition before each step-5 iteration (§2.3 ordering constraint). Untracked files survive; tracked-but-uncommitted edits do not.
- **CI (Linux)** — unaffected-to-better: no autocrlf there; `eol=lf` materialization is what CI already had, and the merged content is byte-identical (renormalize no-op). Expect CI green with zero behavior change.
- **Count drift** — if anything lands on `main` between plan and build (nothing is in flight per §0), suite counts may exceed 38/333; zero failures is the bar, per ticket acceptance 4.

## 5. Open questions

1. **Merge-ordering enforcement** — this ticket should merge before any of the 14 pending tickets branch (§4, ticket Feedback obligation 3). The ticket classifies this as an advisory scheduling note, not a blocker; nothing for the Builder to decide. **Decider: Horace / whoever sequences the next milestone batch** (supervised mode: the human confirming merges is already positioned to honor it). Builder's only obligation: repeat the flag in the build report and Changelog.
2. None other. The rule shape is pinned in §2.2 (Builder may deviate to option (b) only with a recorded deviation + in-file justification per the ticket), the commit shape in §2.3, and every acceptance item has a mechanical check in §3.
