# VERIFY.md — engineering verification policy

What must be checked before a change becomes a Draft Pull Request, what counts as evidence, and how
results are reported. Adapted from the App Delivery Toolkit's `VERIFY.md` (§A gate, §B isolation,
§C brand values, §D forks, §F conformance, §G reporting, §I design verification, §J PR readiness).

Skill-specific output contracts live in each `SKILL.md`; this file defines what they share.

---

## 1. Outcomes and evidence

Every check reports exactly one outcome:

| Outcome | Meaning | Required evidence |
| :-- | :-- | :-- |
| `PASSED` | The check **was executed** and met its expectation | The command or procedure run, and its decisive output (exit code, counts, the relevant lines) |
| `FAILED` | The check was executed and did not meet its expectation | The command and the **actual failing output, quoted** — never summarised away |
| `SKIPPED` | Deliberately not executed, for a stated reason: not applicable to this change, out of scope, or it would write where the role may not | The reason, specific to this run ("no `.css` changed", "reviewer is read-only; generator writes files") |
| `NOT_VERIFIED` | Should have been checked but could not be: tool missing, environment failure, error before a result, insufficient evidence | What was attempted and why no result exists |

Rules:

1. **A check that was not executed is never `PASSED`.** Not when it "obviously" would pass, not when
   another agent says it passed, not when it passed in an earlier round on different code.
2. A claim without evidence is `NOT_VERIFIED`. An implementer's report is a set of claims; a reviewer
   re-derives what it can and reports its own outcomes.
3. "0 matches" is meaningful only next to "N files scanned". An empty scan input is `NOT_VERIFIED`, not
   `PASSED`.
4. An outcome is about **this** code at **this** commit. Re-run after every change that could affect it.
5. A `SKIPPED` gate that is mandatory for the change type (§4) blocks PR creation exactly like `FAILED`.

## 2. Scope — what changed

The unit under verification is **every commit since the merge-base with the base branch, plus
anything uncommitted**:

```bash
export GIT_OPTIONAL_LOCKS=0
MERGE_BASE=$(git -C "$TARGET_REPO" merge-base "origin/$BASE_BRANCH" HEAD)

# tracked changes (committed + uncommitted) against the merge-base, plus untracked files
{ git -C "$TARGET_REPO" diff --name-only "$MERGE_BASE"
  git -C "$TARGET_REPO" ls-files -o --exclude-standard
} | sort -u > "$REPORTS_DIR/changed-files.txt"

wc -l < "$REPORTS_DIR/changed-files.txt"     # print it — see the rules below
git -C "$TARGET_REPO" diff --stat "$MERGE_BASE"
git -C "$TARGET_REPO" diff "$MERGE_BASE"     # read the diff itself, not only the file list
```

- `git diff … HEAD` alone misses untracked files — almost everything new is untracked until the
  Orchestrator commits. Always include `ls-files -o --exclude-standard`.
- **An empty list after implementation work is a failure of the check**, not a pass: find out why.
- Line-level review findings are raised only on lines the change **added** (`git diff -U0
  "$MERGE_BASE"` hunks; every line of a new file). Pre-existing code is never blamed on the change.
- Every changed file must be explained by the ticket. Unrelated files, generated files edited by
  hand, other apps' files, lockfile churn without a manifest change, and context or tooling files
  (`HARNESS.md` §8) are findings.

## 3. Commands — use the repository's own

**Never invent a command.** Take commands from the target's `package.json` scripts, task-runner
config and CI workflows. If a command does not exist there, the check is `NOT_VERIFIED` with that
reason — do not substitute a guess.

### 3.1 Target: `dgcl-dgs-dc-xt` (measured; re-check the scripts before running)

Run from `"$TARGET_REPO"`.

| Purpose | Whole workspace | One package | Notes |
| :-- | :-- | :-- | :-- |
| Install | `pnpm install --frozen-lockfile` | — | Plain `pnpm install` only when the change itself edits a manifest; a frozen install failing on a change that touched no manifest is a finding |
| Typecheck | `pnpm check-types` | `pnpm --filter @workspace/ui check-types` · `pnpm --filter dco check-types` (`next typegen && tsc --noEmit`) | Also run by the `pre-commit` hook |
| Lint | `pnpm lint` | `pnpm --filter @workspace/ui lint` · `pnpm --filter dco lint` | Zero tolerance: `--max-warnings=0` |
| Test | `pnpm test` | `pnpm --filter @workspace/ui test` · `pnpm --filter dco test` | Turbo `test` depends on `^build`; `pre-push` runs lint + test |
| Coverage (CI) | `pnpm test:coverage` | — | What CI runs |
| Build | `pnpm build:dco` | — | Needs AEM, or `ALLOW_BUILD_WITHOUT_AEM=true` in the environment; without either it is `NOT_VERIFIED`, never `PASSED` |
| Storybook build | `pnpm --filter @workspace/ui build-storybook` | — | Writes `packages/ui/storybook-static/`; implementers only |
| Storybook dev | `pnpm storybook` (port 6006) | — | For rendered verification |
| Token drift | `pnpm build:tokens` then `git diff --exit-code packages/ui/src/styles/tokens packages/ui/src/constants/breakpoints.ts packages/ui/src/constants/tokens.ts` | — | Run only when `design/tokens/**` or the generator changed. **Writes files**: implementers only; reviewers report `SKIPPED` and rely on CI |
| Format | `pnpm format` | — | Writes files; implementers only, and only on files they changed |

### 3.2 Read-only roles

Reviewers may run commands that do not write into the worktree: `check-types`, `lint` (without
`--fix`), `test` (Jest writes only to `coverage/`, which is git-ignored — confirm with `git status`
afterwards). Anything that writes tracked files is `SKIPPED` for them with that reason. The read-only
proof in `HARNESS.md` §10 applies.

## 4. Quality gates

Gate applicability: **F** = frontend change, **B** = backend change, **D** = ticket has Figma links,
**A** = always. "Blocking" means a `FAILED` (or a mandatory `SKIPPED` / `NOT_VERIFIED`) result
prevents Draft PR creation by the Engineering Orchestrator.

| # | Gate | Applies | Evidence required | Owner | Blocking |
| :-- | :-- | :-- | :-- | :-- | :-- |
| G1 | **Acceptance criteria coverage** | A | Each criterion → `MET` (with the code location and the named test that proves it) / `NOT_MET` (reason) / `CONFLICT` (with the design or another criterion) | Implementer; re-checked by Figma Verifier (D) and PR Reviewer | Yes, any `NOT_MET` without an accepted reason |
| G2 | **Change scope** | A | §2 file list and diff read; every file explained; no protected, generated-by-hand, unrelated or context files | Implementer; PR Reviewer | Yes |
| G3 | **Type check** | F, B | Command + exit code 0 | Implementer; Orchestrator before commit | Yes |
| G4 | **Lint** | F, B | Command + `0 errors, 0 warnings` | Implementer; Orchestrator before commit | Yes |
| G5 | **Tests** | F, B | Command + pass/fail counts; new/changed behaviour has named tests | Implementer | Yes |
| G6 | **Build** | F, B | Command + success, or `NOT_VERIFIED` with the missing prerequisite | Implementer | Yes when the environment allows it; `NOT_VERIFIED` is recorded in the PR |
| G7 | **Component conventions & Storybook** | F | File set, placement, layer direction, story per state, a11y panel noted (`CONVENTIONS.md` §3, §4, §11) | Implementer; PR Reviewer | Yes for missing tests/stories on new components |
| G8 | **Design token consistency** | F | §4.1 scans over the changed files with counts; semantic tier used | Implementer; Figma Verifier; PR Reviewer | Yes |
| G9 | **Figma fidelity** | D | `skills/figma-verify` result `PASSED` (tier stated) | Figma Verifier only — never the implementer | Yes |
| G10 | **Accessibility** | F | Semantic elements, keyboard path, names/alt, focus; tests for keyboard operation | Implementer; PR Reviewer | Yes for unreachable or unlabelled interactive elements |
| G11 | **Responsive behaviour** | F | Named breakpoints only; checked at every breakpoint (Storybook viewport) or `NOT_VERIFIED` | Implementer; Figma Verifier (D) | Yes for one-off breakpoints |
| G12 | **RTL & localisation** | F | Logical utilities, no hard-coded direction or copy; an Arabic test/story | Implementer; PR Reviewer | Yes for LTR-only layout |
| G13 | **Architecture & reuse** | A | Inventory searched; atoms created/reused listed; no forks; dependency direction respected | Implementer; PR Reviewer | Yes for forks and upward imports |
| G14 | **Security** | A | `skills/security-review` verdict with scope and checks performed | Security Reviewer | Yes on `FAILED` |
| G15 | **PR review** | A | `skills/pr-review` verdict with all sixteen categories | PR Reviewer | Yes on `NOT_READY` |
| G16 | **Context isolation** | A | `HARNESS.md` §8 contamination check output empty | Orchestrator, before every commit | Yes |
| G17 | **PR readiness** | A | All applicable gates above recorded; open questions listed; context version recorded | Orchestrator | — (aggregate) |

### 4.1 Design-token scans (G8)

Run over the changed source files from §2, and report the file count with the result:

```bash
grep -E '\.(ts|tsx|css)$' "$REPORTS_DIR/changed-files.txt" \
  | grep -vE '(^|/)styles/tokens/|constants/(breakpoints|tokens)\.ts$|\.(test|stories)\.tsx?$' \
  > "$REPORTS_DIR/scan-files.txt"
wc -l < "$REPORTS_DIR/scan-files.txt"

cd "$TARGET_REPO"
xargs -r grep -nHE '#[0-9a-fA-F]{3,8}\b'                    < "$REPORTS_DIR/scan-files.txt"   # hex literals
xargs -r grep -nHE '\b(rgba?|hsla?)\('                      < "$REPORTS_DIR/scan-files.txt"   # raw colour functions
xargs -r grep -nHoE '[a-z-]+-\[[^]]+\]:?'                   < "$REPORTS_DIR/scan-files.txt" \
  | grep -vE '\]:$|(data|aria|has|not|supports|group|peer)-\['                                   # arbitrary values (variant selectors excluded)
xargs -r grep -nHE '(min|max)-\[[^]]+\]:|@media[^{]*width'  < "$REPORTS_DIR/scan-files.txt"   # one-off breakpoints
xargs -r grep -nHE 'style=\{\{'                             < "$REPORTS_DIR/scan-files.txt"   # inline style objects
```

Expected: no matches. Each legitimate exception (an SVG `currentColor` fallback, a CSS variable
fallback that is itself a token value) is listed explicitly, never passed over.

## 5. Error classification

Every `FAILED` and `NOT_VERIFIED` carries one classification so the Orchestrator can route it:

| Class | Meaning | Evidence | Routed to |
| :-- | :-- | :-- | :-- |
| `CODE_DEFECT` | Caused by the change: compile, type, lint, test or build failure in changed code | Failing output naming changed files/lines | The implementer who made the change (routine fix) |
| `PRE_EXISTING` | Fails identically without the change | The same failure on the merge-base, or a failing location outside the changed files with no dependency on them | Recorded; not the ticket's to fix unless in scope |
| `ENVIRONMENT` | Toolchain, credentials, network, missing service (AEM), disk | The environment error message | Orchestrator (environment setup); one retry |
| `DEPENDENCY` | Install/resolution failure, lockfile mismatch, vulnerable package | Package-manager output | Implementer if the change edited manifests; else Orchestrator |
| `TOOLING` | A required tool or integration absent or broken (Figma MCP, browser, scanner) | What was probed | Orchestrator; dependent checks stay `NOT_VERIFIED` |
| `FLAKY` | Passes and fails on identical code | Two runs with different outcomes | Recorded; never used to dismiss a failure seen once without the second run |
| `REQUIREMENT_GAP` | Ticket ambiguous, contradictory or missing a criterion | The criterion text | Orchestrator → Jira / human |
| `DESIGN_GAP` | Design missing a state, token, breakpoint or locale | The Figma node | Orchestrator → design / human |
| `SECURITY` | A confirmed security finding | `skills/security-review` finding | Orchestrator → human approval |
| `CONTEXT_CONTAMINATION` | Context/tooling files in the change | `HARNESS.md` §8 output | Orchestrator; commit blocked |

## 6. Never relax a check

Do not make a check pass by weakening it: no `eslint-disable`, no `any`, no `@ts-ignore`, no skipped
or `.only` tests, no raised `--max-warnings`, no lowered thresholds, no `--no-verify`, no deleting the
failing test, no re-running an unfrozen install to satisfy a frozen one. Fix the cause or report the
failure, classified (§5). A reviewer that finds a relaxed check reports it as `HIGH`.

## 7. Reporting format

Every role ends with a verification block. The skill's own contract adds its fields.

```
## Verification — <role> · <ticket> · round <n> · context <name>@<version> (<sha>)

| Gate | Check                 | Outcome      | Evidence                                              |
| ---- | --------------------- | ------------ | ----------------------------------------------------- |
| G3   | check-types           | PASSED       | pnpm --filter @workspace/ui check-types → exit 0       |
| G4   | lint                  | PASSED       | pnpm --filter @workspace/ui lint → 0 errors, 0 warnings |
| G5   | test                  | FAILED       | 41 passed, 1 failed — quoted below · CODE_DEFECT       |
| G6   | build                 | NOT_VERIFIED | pnpm build:dco: AEM unreachable, ALLOW_BUILD_WITHOUT_AEM unset · ENVIRONMENT |
| G8   | token scans           | PASSED       | 0 matches in 9 files scanned                          |
| G9   | figma fidelity        | SKIPPED      | not the implementer's to verify — Figma Verifier owns G9 |

### Failures (verbatim)
<quoted output for every FAILED row>

### Acceptance criteria
- [x] AC-1 <text> — MET: <file:line>, test "<name>"
- [ ] AC-2 <text> — NOT_MET: <reason>

### Files changed
Branch: <work-branch> from origin/<base> @ <merge-base sha>
<git status --porcelain, verbatim>
```

Rules: every row has an outcome from §1 and its evidence; every `FAILED` is quoted in full; any
unmet criterion is stated at the top of the response as well as in the table; a row is never
deleted to make the table look better — corrected, re-run, or left failing.

## 8. Independence of verification

- Verification that approves a result is performed by a role that did not produce it: the Frontend
  Engineer never approves its own Figma fidelity (G9); the PR and Security Reviewers never review
  changes they made (they make none).
- Independent roles derive their own picture from primary evidence — Figma via MCP, the code via the
  diff, the ticket text — and treat other agents' reports as claims.
- Findings are contested only with evidence (a Figma variable, a token definition, a sibling
  convention, a quoted requirement). An unevidenced objection is not a contest; the finding stands.
- The same defect gets the same severity in every round. Severity is never lowered to converge.

## 9. Where reports go

All reports, findings files, JSON and screenshots go to `REPORTS_DIR`, outside the worktree
(`HARNESS.md` §8). Reports can contain client design detail; they are never committed anywhere.
