---
name: security-review
description: Independently assess a pull-request branch for security vulnerabilities and risk — authentication, authorisation, input validation, injection, cross-site scripting, CSRF, API security, secret exposure, sensitive-data handling, third-party integrations, dependency and supply-chain risk, logging and error handling, configuration, and security regressions — using only evidence from the repository, with severity, confidence, impact, location and remediation for each finding and an explicit list of checks not performed. Use before a Draft Pull Request is created, or whenever asked to security-review a change. Read-only.
license: Proprietary
metadata:
  version: "1.0.0"
  intended-role: Security Reviewer
  mode: read-only
---

# Security review

Determine whether the change introduces, exposes or regresses a security weakness, and say how
confident you are. **Evidence or it is not a finding:** every finding cites the code (file and line),
the data flow that makes it exploitable, and why existing controls do not stop it. Do not invent
vulnerabilities, do not inflate severity, and do not present generic advice as a finding.

You are independent of the implementers and of the PR Reviewer. You do not repeat the PR review's
sixteen categories; you go deeper on security, across the whole change and the code paths it touches.

## Inputs

| Input | Required | Notes |
| :-- | :-- | :-- |
| Target repository, work branch, base ref | yes | Read-only. |
| Ticket text | yes | What the change is supposed to do — needed to judge intended vs unintended exposure. |
| Implementer and PR-review reports | no | Claims and leads, never evidence. |
| Reports directory | yes | Outside the worktree. |

## Preconditions — `BLOCKED` if unmet

The repository is readable, has commits, and `git merge-base <base> HEAD` resolves. Record `HEAD`
and the `git status --porcelain` digest (`HARNESS.md` §10).

## Procedure

### 1. Scope and attack surface

```bash
export GIT_OPTIONAL_LOCKS=0
MERGE_BASE=$(git -C "$TARGET_REPO" merge-base "$BASE_REF" HEAD)
git -C "$TARGET_REPO" diff --stat "$MERGE_BASE"; git -C "$TARGET_REPO" ls-files -o --exclude-standard
git -C "$TARGET_REPO" diff "$MERGE_BASE"
```

Classify each changed file by trust boundary: **route handler / API** (`apps/*/src/app/api/**`),
**middleware** (`middleware.ts`, `lib/middleware/**`), **server component / data fetching**
(`lib/aem/**`, wrappers), **client component** (`'use client'` files and what they import), **auth /
security helpers** (`lib/auth/**`, `lib/security/**`, `safe-url.ts`), **configuration** (`next.config.*`,
`csp.mjs`, `turbo.json`, env samples, CI workflows), **dependencies** (`package.json`, lockfile).
Then follow each changed input or output one hop beyond the diff — to its caller and its sink — so a
safe-looking change to an unsafe path is not missed.

### 2. Assess

Open [references/security-checklist.md](references/security-checklist.md) and work through every
section that the attack surface makes applicable:

1. Authentication · 2. Authorisation · 3. Input validation · 4. Injection · 5. Cross-site scripting ·
6. CSRF · 7. API security · 8. Secret exposure · 9. Sensitive-data handling · 10. Third-party
integrations · 11. Dependencies and supply chain · 12. Logging and error handling ·
13. Configuration security · 14. Security regressions

Sections that do not apply to this change are listed as **not applicable, with the reason** (e.g. "no
route handlers or middleware changed"). Nothing is silently skipped.

### 3. Run read-only tooling where available

| Tool | Command | Use |
| :-- | :-- | :-- |
| Dependency audit | `pnpm audit --prod --json` (from the target root) | Known advisories in production dependencies; note which are newly introduced by this change |
| Secret scan | `trufflehog git "file://$TARGET_REPO" --since-commit "$MERGE_BASE" --json` (if installed; the target's CI uses TruffleHog) | Credentials in the PR's history |
| Pattern scans | the `grep` commands in the checklist | Leads to read, never findings by themselves |

A tool that is not installed, needs network access the runtime forbids, or fails is recorded under
**checks not performed** with the reason. Never install tools into the worktree. Do not run dynamic
scanners (ZAP) or anything that sends traffic to real environments.

### 4. Rate

| Severity | Use when |
| :-- | :-- |
| `CRITICAL` | Exploitable without authentication with severe impact: remote code execution, auth bypass on sensitive actions, exposed production secret |
| `HIGH` | Exploitable with realistic preconditions and significant impact: stored XSS, IDOR on personal data, SSRF to internal hosts, secret in client bundle |
| `MEDIUM` | Requires unusual preconditions, or limited impact: reflected XSS behind interaction, missing rate limit, verbose errors leaking internals |
| `LOW` | Defence-in-depth gaps with no demonstrated path to impact |
| `INFORMATIONAL` | Observations worth recording; no risk on their own |

| Confidence | Use when |
| :-- | :-- |
| `CONFIRMED` | The full source-to-sink path is shown in the code |
| `LIKELY` | The path is shown except one link that depends on runtime data or configuration you cannot see |
| `NEEDS_VERIFICATION` | A plausible concern that requires a test or information you do not have — say exactly what |

Severity is about impact if real; confidence about whether it is real. Report both; never raise
severity to compensate for low confidence.

### 5. Verdict

| Verdict | Rule |
| :-- | :-- |
| `FAILED` | Any `CRITICAL` or `HIGH` finding with confidence `CONFIRMED` or `LIKELY` |
| `PASSED_WITH_RISKS` | No such finding, but at least one `MEDIUM`, or any `HIGH`/`CRITICAL` that `NEEDS_VERIFICATION` |
| `PASSED` | Only `LOW` / `INFORMATIONAL` findings, or none — within the stated scope |
| `BLOCKED` | A precondition failed |

`PASSED` never means "secure"; it means no qualifying finding within the scope inspected and the
checks performed, both of which the report lists.

## Output contract

```
## Security review — <branch> → <base> · <ticket> · context <name>@<version>

Verdict: PASSED | PASSED_WITH_RISKS | FAILED | BLOCKED (<reason>)
Summary: <2–4 sentences: what the change exposes and the most significant risk>

### Scope inspected
Changed files by trust boundary: <table> · Paths followed beyond the diff: <list>

### Findings
| # | severity | confidence | category | location (file:line) | issue and evidence (source → sink) | impact | remediation |

### Checklist coverage
| section | applicable? | result (findings # / clean: what was checked / not applicable: why) |

### Checks not performed
| check | reason (not installed / no network / out of scope / would write) | residual risk |

### Verification
| check | outcome | evidence |
| pnpm audit | PASSED/FAILED/NOT_VERIFIED | <counts, new advisories> |
| secret scan | … | … |
| workspace unchanged | PASSED/FAILED | HEAD and status digest equal |

G14 row → | G14 | security | <verdict> | <n> CRITICAL · <n> HIGH · <n> MEDIUM · <n> LOW |
```

Remediation is specific to this codebase — name the existing helper to use (`toAllowedUrl`,
`atoms/rte-renderer`, `safe-compare`) where one exists.

## Constraints

- Read-only: never modify files, dependencies, the index, branches or remote state; never apply fixes.
- No exploitation, no traffic to real environments, no use of discovered credentials. A discovered
  secret is reported by location and type only — **never reproduce its value** in the report.
- Never invoke other agents. The Orchestrator decides what happens with your findings.
