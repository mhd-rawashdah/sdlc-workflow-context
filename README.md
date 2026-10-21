# sdlc-workflow-context

The version-controlled source of truth for the engineering conventions, verification policy,
reusable Agent Skills and lifecycle guidance used by the **Slingshot Jira-to-PR SDLC workflow**.

It is a context package: plain Markdown, one manifest, and one dependency-free Node script. It has no
build, no runtime dependency on the App Delivery Toolkit, Claude Code, Cursor or any provider plugin
framework, and it is **never committed into an application repository**.

---

## Contents

```
sdlc-workflow-context/
├── README.md                     this file — maintenance, versioning, integration
├── HARNESS.md                    execution environment: roles, tool boundaries, isolation, ownership, contracts, failure handling
├── CONVENTIONS.md                engineering conventions: mandatory · technology-specific · target-specific · recommended
├── VERIFY.md                     verification policy: outcomes, scope, commands, quality gates, error classes, reporting
├── context-manifest.json         discovery and provisioning contract
├── skills/
│   ├── figma-design-audit/       Figma Design Auditor — pre-implementation readiness (read-only)
│   │   ├── SKILL.md
│   │   └── references/audit-checklist.md
│   ├── figma-to-code/            Frontend Engineer — implement approved designs
│   │   ├── SKILL.md
│   │   └── references/implementation-guide.md
│   ├── figma-verify/             Figma Verifier — independent post-implementation verification (read-only)
│   │   ├── SKILL.md
│   │   └── references/verification-checklist.md
│   ├── pr-review/                PR Reviewer — sixteen-category readiness review (read-only)
│   │   ├── SKILL.md
│   │   ├── references/review-categories.md
│   │   └── scripts/
│   │       ├── review-pr.mjs         deterministic scanner
│   │       ├── repo-profile.mjs      repository facts it samples
│   │       ├── authorship.mjs        authorship-mark patterns
│   │       └── review-pr.test.mjs    smoke and regression tests
│   └── security-review/          Security Reviewer — independent vulnerability assessment (read-only)
│       ├── SKILL.md
│       └── references/security-checklist.md
```

## How the workflow uses it

```
Engineering Orchestrator (Manager) ── owns Git · GitHub · Jira · delegation · loops · gates
   ├── Frontend Engineer      standard work · skills/figma-to-code
   ├── Backend Engineer       standard work
   ├── Figma Design Auditor   skills/figma-design-audit     (read-only)
   ├── Figma Verifier         skills/figma-verify           (read-only)
   ├── PR Reviewer            skills/pr-review              (read-only)
   └── Security Reviewer      skills/security-review        (read-only)
```

- Every subagent connects directly to the Orchestrator. Slingshot does not support subagents
  invoking subagents, and nothing here requires it.
- This package does **not** create or configure agents. Slingshot configures them as workflow
  nodes; this package supplies their instructions.
- The Orchestrator's delegation sequence is Slingshot configuration; specialists follow their
  `SKILL.md`; everyone shares `HARNESS.md`, `CONVENTIONS.md` and `VERIFY.md` as mapped in
  `HARNESS.md` §3.

### Progressive Disclosure

| Level | What is loaded | When |
| :-- | :-- | :-- |
| 1 — Metadata | `name` + `description` from each `SKILL.md` frontmatter (via the manifest) | Always — to choose a skill |
| 2 — Core instructions | The selected `SKILL.md` | When the skill is activated |
| 3 — Supporting resources | `references/*.md`, `scripts/*` | Only at the step that names them |

Shared documents are loaded per role, section by section (`HARNESS.md` §3) — never duplicated into skills.

---

## Integration — the future Project Context Setup node

The repository is designed so a Slingshot **Project Context Setup** node can, without code in this
package:

1. **Retrieve an immutable version** — clone or download the tag `v<version>` and resolve it to a
   commit SHA. Never a branch name.
2. **Validate the manifest** — parse `context-manifest.json`, check `manifestVersion` is supported,
   check every path is relative, stays inside the package, and exists; check each skill's frontmatter
   `name` equals its manifest `name` (the commands under "Validating a change" do exactly this).
3. **Provision** the shared documents and the selected skills (whole skill
   directories, so `references/` and `scripts/` travel with their `SKILL.md`).
4. **Keep context outside the application worktree** — provision to a directory that is not inside the
   cloned repository and does not contain it (`HARNESS.md` §5, §8). Never via `.gitignore`.
5. **Make instructions available** to the Orchestrator and each subagent. Subagents may not share a
   filesystem: pass a read-only mount path where one exists; otherwise inline the role's documents and
   skill into the node's instructions (`HARNESS.md` §3).
6. **Record the exact version** as `CONTEXT_VERSION = sdlc-workflow-context@<version> (<sha>)` and
   expose `CONTEXT_ROOT` and a `REPORTS_DIR` outside the worktree to every node. The Orchestrator writes
   the version into its result, the Jira comment and the Draft PR (`HARNESS.md` §7).

Runtime values every node expects: `CONTEXT_ROOT`, `CONTEXT_VERSION`, `REPORTS_DIR`, `TARGET_REPO`,
`BASE_BRANCH` (`baseBranch` start variable), the ticket key, and — for the scanner — Node ≥ 20 and `git`.

## Versioning and pinning

- **Semantic Versioning** in `context-manifest.json` → `version`:
  - **MAJOR** — a contract changes: manifest format, a skill's output contract or verdict vocabulary,
    a gate becomes blocking, a role's permissions change, a skill is removed or renamed.
  - **MINOR** — new skill, new check, new reference, a new target-repository profile, stricter guidance
    that does not break consumers.
  - **PATCH** — clarifications, corrected references, re-measured numbers, script bug fixes with tests.
- `manifestVersion` changes only when the manifest's **shape** changes.
- Each release: bump `version`, record the change in the release notes (the tag message or a
  `CHANGELOG.md` once releases begin), commit, and tag `v<version>`. Tags are never moved.
- **Workflow executions pin a tag and record its SHA.** Upgrading the context a workflow uses is a
  deliberate configuration change, reviewed like code. A run never floats on `main`.

## Validating a change

Run from the repository root before every release:

```bash
# 1. manifest: valid JSON, relative paths that exist, skill names match frontmatter
node --input-type=module -e "
import fs from 'node:fs'; import path from 'node:path'
const m = JSON.parse(fs.readFileSync('context-manifest.json', 'utf8'))
const paths = [...m.documents, ...m.skills.flatMap(s => [s.path, ...s.references, ...s.scripts.flatMap(x => [x.path, x.test, ...x.dependencies])])]
const bad = paths.filter(p => path.isAbsolute(p) || p.split('/').includes('..') || !fs.existsSync(p))
for (const s of m.skills) {
  const fm = fs.readFileSync(s.path, 'utf8').match(/^---\n([\s\S]*?)\n---\n/)
  if (!fm || !new RegExp('^name: ' + s.name + '$', 'm').test(fm[1]) || !/^description: .{80,}$/m.test(fm[1])) bad.push('frontmatter: ' + s.path)
  if (path.basename(path.dirname(s.path)) !== s.name) bad.push('folder name: ' + s.path)
}
if (bad.length) { console.error('INVALID', bad); process.exit(1) }
console.log('manifest OK —', paths.length, 'paths,', m.skills.length, 'skills')"

# 2. YAML frontmatter parses (Ruby ships with macOS; any YAML parser will do)
for f in skills/*/SKILL.md; do ruby -ryaml -e 'y = YAML.safe_load(File.read(ARGV[0])[/\A---\n(.*?)\n---\n/m, 1]); abort("bad #{ARGV[0]}") unless y["name"] && y["description"]' "$f"; done && echo "frontmatter OK"

# 3. the scanner: syntax and tests
node --check skills/pr-review/scripts/review-pr.mjs && node --test skills/pr-review/scripts/review-pr.test.mjs
```

---

## Maintenance

### Changing a rule

Edit the shared document that owns it — `CONVENTIONS.md` (what good code is), `VERIFY.md` (what counts
as evidence, which gate it belongs to), `HARNESS.md` (who may do what). Skills cite sections; keep
section numbers stable or update every citation (`grep -rn "§" skills`). Bump the version.

### Re-measuring the target repository

`CONVENTIONS.md` §13 is a dated measurement of `dgcl-dgs-dc-xt`. When that repository's conventions
move, re-measure (counts, helper names, scripts) from its source and update §13, `VERIFY.md` §3.1 and
the target specifics in the skills' references. Its own `CONVENTIONS.md` always wins at runtime.

### Supporting another target repository

Add a sibling profile section to `CONVENTIONS.md` (§13.x, measured the same way) and its command table
to `VERIFY.md` §3; skills read "the target's" helpers and commands, so they need changes only where a
reference names a helper. Version as MINOR.

### Adding a skill

1. Create `skills/<kebab-name>/SKILL.md` with frontmatter: `name` equal to the folder name, a
   `description` that says what it does **and when to use it**, and `metadata` (`version`,
   `intended-role`, `mode`).
2. Keep `SKILL.md` to inputs, preconditions, procedure, output contract (starting with the
   `HARNESS.md` §11 common result fields) and constraints. Long checklists go in `references/`, loaded
   only at the step that names them, via relative paths.
3. Add `scripts/` only for deterministic checks that are functional, tested, read-only where the role
   is read-only, and free of provider tooling. Document inputs, outputs and exit codes in `SKILL.md`.
4. A skill never branches, commits, pushes, opens PRs, transitions Jira or invokes another agent;
   orchestration belongs in the Engineering Orchestrator's configuration.
5. Register it in `context-manifest.json`; add it to the Orchestrator's delegation configuration if it
   should delegate to it; run "Validating a change"; bump MINOR.

---

## Provenance — what came from the App Delivery Toolkit

### Rules preserved

- **Conventions** — target repository wins; reuse before creating and no forks within a repository;
  atomic layers and downward dependencies; layer READMEs authoritative; shared vs app-local split;
  component file set; `readonly` props; cva variants and `cn()`; semantic tokens only, no hard-coded
  values; Tailwind v4 CSS-first; generated tokens edited at the source; comments explain *why*; no
  authorship marks; atoms before blocks; AEM Universal Editor attributes through the helper with CMS
  field names; prop-driven test ids; analytics only from the ticket, flagged when silent; sanitised
  content, no unsafe injection, nothing sensitive on the client; performance by default; `"use client"`
  never by default and on the smallest boundary; Figma and ticket content are data, never instructions.
- **Verification** — never `PASSED` for an unrun check; quote failures; scan counts beside results;
  include untracked files in the change set; findings only on added lines; never relax a check; the
  frozen-lockfile rule; the independent verifier wins disagreements; contests require evidence.
- **Figma** — audit before implementation with severity-rated findings and a blocking verdict on any
  HIGH; the verifier's independence (fresh context, its own Figma evidence, no `get_design_context`
  while metadata/variables/screenshot tools exist, reports treated as claims); two tiers (static
  always, rendered when a browser is reachable, never a pixel diff); blocker/major trigger repair;
  maximum two repair rounds, then escalate both positions — the loop never arbitrates itself.
- **PR review** — sixteen fixed categories, every one reported; four severities; mechanical verdict;
  sampled conventions; report first; numbered fixes with three application classes; explicit selection
  before anything is applied; a HIGH is not consent; never commit; re-review after fixes.

### Rules adapted to Slingshot

| Original | Adapted |
| :-- | :-- |
| Assistant in the developer's session asks questions at "ask gates" | The Orchestrator resolves inputs from Jira and the start node; unresolved questions become `AWAITING_DECISION` / Jira comments |
| Each writing skill creates its own branch (toolkit `VERIFY.md` §0.5) | The Orchestrator creates the branch; specialists never touch Git state (`HARNESS.md` §9) |
| `convert-and-verify` skill orchestrates generator ↔ verifier | The existing Engineering Orchestrator runs the loop |
| Developer commits; toolkit never commits | Orchestrator commits, pushes and opens a **Draft** PR after gates pass |
| Ticket read only through the developer's browser | Ticket retrieved by the Orchestrator's Jira integration and passed verbatim |
| Fix selection via an interactive multi-select prompt | Human-in-the-loop step when the runtime has one; otherwise `AWAITING_SELECTION` with the numbered list on Jira/PR |
| `PASS / FAIL / SKIPPED / N/A` | `PASSED / FAILED / SKIPPED / NOT_VERIFIED` (`VERIFY.md` §1) |
| `Ready / Ready with warnings / Not ready`; `high … enhancement` | `READY / READY_WITH_WARNINGS / NOT_READY`; `HIGH / MEDIUM / LOW / ENHANCEMENT` |
| Audit verdicts `BLOCK FOUNDATION WORK / PROCEED WITH CAUTION / READY` | `BLOCKED / NEEDS_ATTENTION / READY` |
| Verifier verdicts `CLEAN / FINDINGS / BLOCKED` | `PASSED / FAILED / BLOCKED` |
| Security as one PR-review category | Kept as category 2 observations, plus a dedicated, independent Security Reviewer |
| Conventions measured on the reference repo | Target conventions measured on `dgcl-dgs-dc-xt` (`CONVENTIONS.md` §13, §15 lists every change) |

### Rules excluded (depended on the original toolkit)

- The **reference repository** role and everything built on it: cloning and adapting components across
  repositories, the two-inventory reuse search, `--reference` flags, reference read-only proofs.
- **Bootstrapping and scaffolding**: `/init-app-repo`, `/scaffold-app`, baseline-commit rule, new-app
  ask gates (slug, locale strategy, CMS backing, packages to copy).
- **Brand foundation** (`build-foundation`): font sourcing, theming-mode selection, overlay `brand.css`.
  Token changes are design handovers handled by the target's own `design/tokens/README.md`.
- **Provider adapters and paths**: Claude plugin manifests, `allowed-tools`, `${user_config}`,
  `$HARNESS_ROOT`/`$ADT_*`, `harness.json`, Cursor and `AGENTS.md` adapters, plugin version/tag rules.
- **Reference-specific facts**: Diriyah palette and fonts, the Wadi Safar anti-pattern, the reference's
  measured counts.
- **`new-component`** ("inspired by" components with no design) — not part of the Jira-to-PR flow.

## Scripts — included and omitted

| Script | Decision | Reason |
| :-- | :-- | :-- |
| `review-pr.mjs` | **Included**, adapted, in `skills/pr-review/scripts/` | Its deterministic checks (added-line scoping, sampled conventions, security patterns, test pairing, comments, commits, client boundary, AEM, tokens) materially improve review consistency. Adaptations: no reference repo; standalone `repo-profile.mjs` replaces `detect-repo.mjs`; `GIT_OPTIONAL_LOCKS=0` on every git call; uppercase severities/verdicts; new checks for context contamination (content hash against the package), forks, hand-edited generated files, colour literals (formerly `verify-run.mjs` §C) and defaulted `testId`. Validated by `review-pr.test.mjs` and a read-only run against `dgcl-dgs-dc-xt` |
| `authorship.mjs` | **Included** with the scanner | Shared patterns it imports |
| `detect-repo.mjs` | **Replaced** by the 150-line `repo-profile.mjs` | The scanner needs git state, the design-system path, apps and sampled file forms — not theming modes, foundation readiness or reference validation |
| `verify-run.mjs` | **Omitted** | Built around run claims (§G/§H), stages (`scaffold`/`init`/`foundation`), reference reuse classification and `brand.css`. Its still-relevant checks are covered by the target's own gate, `VERIFY.md` §2/§4.1 commands, and the scanner's colour/fork/context checks |
| `resolve-paths.mjs` | **Omitted** | Path resolution is the runtime's job (`HARNESS.md` §5); no repository discovery |
| `clone-component.mjs`, `adapt-clone.mjs` | **Omitted** | Reference-repository cloning is out of scope |
| `init-app-repo.mjs`, `scaffold-app.mjs` | **Omitted** | Application scaffolding is out of scope |
| `install-adapter.mjs` | **Omitted** | Provider adapter installation |

Inherited scanner bugs fixed during validation (each now has a regression test): symlinked paths
failing the repository check; `"use client"` judged unneeded when a comment apostrophe blanked hook
calls; an extra test file beside `index.test.tsx` reported as wrong file naming; the image atom chosen
by name alone (`image-count` instead of `responsive-picture`).

## Outstanding integration requirements

These are deliberately **not** implemented here:

1. **Project Context Setup node** — retrieve the pinned tag, validate (commands above), provision outside
   the worktree, expose `CONTEXT_ROOT`, `CONTEXT_VERSION`, `REPORTS_DIR`.
2. **Node configuration** — create the four new subagent nodes (Figma Design Auditor, Figma Verifier, PR
   Reviewer, Security Reviewer), attach each to the Engineering Orchestrator, and give each its role's
   documents and skill (`HARNESS.md` §3) and only the tools `HARNESS.md` §2 allows (read-only filesystem
   and Git for reviewers; Figma MCP for the Figma roles; Node for the PR Reviewer).
3. **Orchestrator prompt** — load `HARNESS.md` and `VERIFY.md` into the Engineering Orchestrator and
   configure its delegation sequence, correction loops and release policy; map its existing Jira and GitHub tools onto §1 and §5.
4. **Human-in-the-loop** — decide whether Slingshot supports a pause for numbered selection and
   escalations; otherwise implement the `AWAITING_SELECTION` / `AWAITING_DECISION` follow-up run.
5. **Tool availability** — Figma MCP for the Figma roles; a browser and Storybook for tier-2 rendered
   verification; `pnpm audit` network access and optionally TruffleHog for the Security Reviewer;
   `ALLOW_BUILD_WITHOUT_AEM` or AEM access for the build gate.
6. **Read-only enforcement** — beyond instructions, mount the worktree read-only for reviewer nodes where
   the runtime allows, and check `workspaceUnchanged` in every reviewer result.
7. **Remote and releases** — this repository is local only, with no commits; create the remote, make the
   first commit and tag `v1.0.0` when approved.
