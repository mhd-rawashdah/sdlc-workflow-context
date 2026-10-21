#!/usr/bin/env node
/**
 * review-pr.mjs — the deterministic half of the pr-review skill (../SKILL.md, step 3).
 *
 * It scopes itself to the pull request — every commit since the merge-base with the base branch,
 * plus anything still uncommitted — and reports only on lines the PR *added*, so pre-existing code
 * is never blamed on the author. It samples the repository's own habits before judging (how it
 * names its `data-testid` props, which test-file spelling it uses, whether its commits are
 * conventional, which AEM helper and image atom it has) and reports those samples with the findings.
 *
 * It is a scanner, not the review. It covers what a pattern can see: commit messages, authorship
 * marks, `data-testid` coverage, test pairing, unsafe code patterns, comment quality, structure and
 * placement, forks, hand-edited generated files, context or tooling files in the change, checks that
 * were quietly relaxed, dependencies, and the build requirements a scan can rule on — an unneeded
 * `"use client"`, a Storybook-only import reaching product code, a CMS-rendering component with no
 * Universal Editor attributes, a raw `<img>` or an eager embed, a whole-library import, colour
 * literals, and arbitrary values and one-off breakpoints that bypass the token layer. What a scan
 * cannot judge — whether analytics matches the ticket, whether a memo guards anything, whether a new
 * atom duplicates an existing one, whether a client boundary is as small as it could be — is printed
 * as data "for the judgement half", never as a finding. The repository's own typecheck, lint, test
 * and build are not repeated here; the reviewer runs them (VERIFY.md §3).
 *
 * Every finding carries a severity (HIGH / MEDIUM / LOW), an area, a file and line, why it matters
 * and a specific fix. Findings print grouped by the sixteen review categories
 * (../references/review-categories.md), in that order, HIGH first within each, and a category with
 * nothing to report says what was checked so "clean" is distinguishable from "unchecked". After the
 * categories the report lists the "missing areas" — the tests, stories, test ids and AEM attributes
 * the PR was expected to bring and did not. The scanner never raises ENHANCEMENT; that is the
 * judgement half's.
 *
 * Read-only: every git call runs with GIT_OPTIONAL_LOCKS=0, nothing is written to the repository,
 * and the only output is stdout and the optional --json file, which must land outside it.
 *
 * Usage:
 *   node review-pr.mjs --repo <path> --base <ref> [options]
 *
 * Options:
 *   --repo <path>          Required. The checkout holding the pull request branch.
 *   --base <ref>           The branch the PR targets (e.g. origin/develop). Detected when omitted:
 *                          the first of origin/develop, origin/main, origin/master, develop, main,
 *                          master that exists and is not the current branch.
 *   --app <slug>           The app under apps/ the PR belongs to; recorded in the output.
 *   --package <name>       The workspace package under review; recorded in the output.
 *   --context-root <path>  The provisioned context package, for the contamination check. Defaults to
 *                          the package this script ships in, when its context-manifest.json is
 *                          present; the check is reported as skipped when neither is available.
 *   --json <file>          Write the full result as JSON. Must be outside the repository.
 *   --quiet                Suppress the human-readable report; useful with --json.
 *
 * Exit code: 0 when the verdict is READY or READY_WITH_WARNINGS, 1 when NOT_READY (any HIGH
 *            finding), 2 on a usage error.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ATTRIBUTION, ATTRIBUTION_COMMIT, ATTRIBUTION_PROSE, CONVERSATIONAL } from './authorship.mjs'
import { profileRepo, READ_ONLY_GIT_ENV, realPath } from './repo-profile.mjs'

// ── args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const die = (msg) => {
  console.error(`✘ ${msg}`)
  process.exit(2)
}

const REPO = arg('repo')
const BASE_ARG = arg('base')
const APP = arg('app')
const PKG = arg('package')
const CONTEXT_ARG = arg('context-root')
const JSON_OUT = arg('json')
const QUIET = flag('quiet')

if (!REPO) die('--repo is required (the checkout holding the pull request branch).')

// A path that does not exist yet (the --json file) is judged by its nearest existing ancestor.
const realOrAncestor = (p) => {
  let at = resolve(p)
  const tail = []
  while (!fs.existsSync(at) && dirname(at) !== at) {
    tail.unshift(basename(at))
    at = dirname(at)
  }
  return join(realPath(at), ...tail)
}
const isInside = (child, parent) => {
  const rel = relative(realOrAncestor(parent), realOrAncestor(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))
}

// ── profile, and refuse to review the wrong thing ─────────────────────────────

const profile = profileRepo(REPO)
if (profile.problems.length) die(`${REPO} cannot be reviewed: ${profile.problems.join('; ')}`)
if (!profile.git.hasCommits) die('the repository has no commits — there is no pull request to review yet')

const ROOT = profile.path
const DS = profile.designSystem

// The context package this script ships in sits three levels up (skills/pr-review/scripts). It is
// only used when it really is one — a copied script without its package simply skips the check.
const CONTEXT_ROOT = (() => {
  const candidate = CONTEXT_ARG ? resolve(CONTEXT_ARG) : resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  if (!fs.existsSync(join(candidate, 'context-manifest.json'))) {
    if (CONTEXT_ARG) die(`--context-root ${CONTEXT_ARG} holds no context-manifest.json`)
    return null
  }
  if (isInside(candidate, ROOT) || isInside(ROOT, candidate)) die('the context package and the repository under review must not contain one another')
  return candidate
})()

if (JSON_OUT && isInside(JSON_OUT, ROOT)) die(`--json must land outside the repository under review (got ${resolve(JSON_OUT)})`)

// ── shell helpers ─────────────────────────────────────────────────────────────

const git = (...args) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', env: READ_ONLY_GIT_ENV, maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    return e.stdout ?? ''
  }
}
const gitOk = (...args) => {
  try {
    execFileSync('git', ['-C', ROOT, ...args], { stdio: 'ignore', env: READ_ONLY_GIT_ENV })
    return true
  } catch {
    return false
  }
}
const gitLines = (...args) =>
  git(...args)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim())

const read = (rel) => {
  const full = join(ROOT, rel)
  return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null
}
const isDir = (rel) => fs.existsSync(join(ROOT, rel)) && fs.statSync(join(ROOT, rel)).isDirectory()
const listDirs = (rel) => (isDir(rel) ? fs.readdirSync(join(ROOT, rel)).filter((n) => isDir(join(rel, n))) : [])
const listFiles = (rel) => (isDir(rel) ? fs.readdirSync(join(ROOT, rel)).filter((n) => !isDir(join(rel, n))) : [])

// ── the pull request: base, merge-base, commits, changed files ────────────────

const CANDIDATE_BASES = ['origin/develop', 'origin/main', 'origin/master', 'develop', 'main', 'master']
const currentBranch = profile.git.branch
const resolveBase = () => {
  if (BASE_ARG) {
    if (!gitOk('rev-parse', '--verify', '--quiet', `${BASE_ARG}^{commit}`)) die(`--base ${BASE_ARG} is not a commit in this repository`)
    return BASE_ARG
  }
  for (const c of CANDIDATE_BASES) {
    if (c === currentBranch || c.replace(/^origin\//, '') === currentBranch) continue
    if (gitOk('rev-parse', '--verify', '--quiet', `${c}^{commit}`)) return c
  }
  die('no base branch found — pass --base <ref> (the branch the pull request targets)')
}
const BASE = resolveBase()
const MERGE_BASE = git('merge-base', BASE, 'HEAD').trim()
if (!MERGE_BASE) die(`no merge-base between ${BASE} and HEAD — is ${BASE} the right base branch?`)

const commits = git('log', '--format=%H%x1f%an%x1f%s%x1f%b%x1e', `${MERGE_BASE}..HEAD`)
  .split('\x1e')
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const [hash, author, subject, body] = c.split('\x1f')
    return { hash, short: hash.slice(0, 7), author, subject, body: (body ?? '').trim() }
  })

// Tracked changes are the working tree against the merge-base, so uncommitted edits are reviewed
// too — a PR "completed" with a dirty tree is itself a finding, but the edits still get read.
const tracked = gitLines('diff', '--name-status', '--no-renames', MERGE_BASE).map((l) => {
  const [status, ...rest] = l.split('\t')
  return { file: rest.join('\t'), status: status[0] }
})
const untracked = gitLines('ls-files', '-o', '--exclude-standard').map((file) => ({ file, status: 'A', untracked: true }))
const changedAll = [...tracked, ...untracked].filter((c, i, a) => a.findIndex((d) => d.file === c.file) === i)
const changed = changedAll.filter((c) => c.status !== 'D' && fs.existsSync(join(ROOT, c.file)))
const deleted = changedAll.filter((c) => c.status === 'D')
const uncommitted = gitLines('status', '--porcelain').map((l) => l.slice(3).trim())
const statusOf = new Map(changed.map((c) => [c.file, c]))

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx)$/
const STORY_FILE = /\.stories\.(ts|tsx|js|jsx)$/
const PROSE = /\.(md|mdx|txt|json|jsonc|ya?ml|html)$/
const isTest = (f) => TEST_FILE.test(f)
const isStory = (f) => STORY_FILE.test(f)
const isSource = (f) => SOURCE.test(f) && !/\.d\.ts$/.test(f)
const isProductCode = (f) => isSource(f) && !isTest(f) && !isStory(f)

const sourceFiles = changed.map((c) => c.file).filter(isSource)
const proseFiles = changed.map((c) => c.file).filter((f) => PROSE.test(f))

// ── added lines — the PR's own contribution, line by line ─────────────────────
// A finding on a line the PR did not touch blames the author for someone else's code, so every
// line-level check below reads only from this map. An untracked or newly added file is entirely
// the PR's; for a modified file the hunks of a zero-context diff say exactly which lines are new.

const addedCache = new Map()
const addedLines = (file) => {
  if (addedCache.has(file)) return addedCache.get(file)
  const body = read(file)
  const out = new Map()
  if (body === null) return out
  const entry = statusOf.get(file)
  if (!entry || entry.untracked || entry.status === 'A') {
    body.split('\n').forEach((text, i) => out.set(i + 1, text))
  } else {
    let line = 0
    for (const raw of git('diff', '-U0', '--no-color', MERGE_BASE, '--', file).split('\n')) {
      const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
      if (hunk) {
        line = Number(hunk[1])
        continue
      }
      if (raw.startsWith('+++')) continue
      if (raw.startsWith('+')) out.set(line++, raw.slice(1))
    }
  }
  addedCache.set(file, out)
  return out
}
const baseVersion = (file) => {
  const entry = statusOf.get(file)
  if (!entry || entry.untracked || entry.status === 'A') return null
  return git('show', `${MERGE_BASE}:${file}`)
}

// ── comment extraction ────────────────────────────────────────────────────────

const blankLiterals = (line) => line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => ' '.repeat(m.length))

const commentFragments = (body) => {
  const out = []
  let inBlock = false
  body.split('\n').forEach((raw, n) => {
    const scan = inBlock ? raw : blankLiterals(raw)
    let pos = 0
    let text = ''
    let wholeLine = false
    while (pos < scan.length) {
      if (inBlock) {
        const end = scan.indexOf('*/', pos)
        text += end === -1 ? raw.slice(pos) : raw.slice(pos, end)
        wholeLine = true
        pos = end === -1 ? scan.length : end + 2
        inBlock = end !== -1 ? false : inBlock
        continue
      }
      const starts = [
        ['line', scan.indexOf('//', pos)],
        ['block', scan.indexOf('/*', pos)],
        ['html', scan.indexOf('<!--', pos)]
      ].filter(([, i]) => i !== -1)
      if (starts.length === 0) break
      const [kind, at] = starts.sort((a, b) => a[1] - b[1])[0]
      wholeLine = wholeLine || scan.slice(0, at).trim() === '' || /^\s*\{\s*$/.test(scan.slice(0, at))
      if (kind === 'line') {
        text += raw.slice(at + 2)
        pos = scan.length
      } else if (kind === 'block') {
        inBlock = true
        pos = at + 2
      } else {
        const end = scan.indexOf('-->', at)
        text += end === -1 ? raw.slice(at + 4) : raw.slice(at + 4, end)
        pos = end === -1 ? scan.length : end + 3
      }
    }
    if (text.trim()) out.push({ line: n + 1, text: text.trim(), wholeLine })
  })
  return out
}

// ── component folders, in the change set and across the repo ─────────────────

const COMPONENT_ROOTS = [
  ...(DS?.components ? [DS.components] : []),
  ...profile.apps.map((a) => join(a.dir, 'src', 'components')).filter(isDir)
]
const inDesignSystem = (f) => Boolean(DS?.components) && (f === DS.components || f.startsWith(`${DS.components}/`))
const appOf = (f) => profile.apps.find((a) => f === a.dir || f.startsWith(`${a.dir}/`))?.slug ?? null
const underComponentRoot = (f) => COMPONENT_ROOTS.some((r) => f.startsWith(`${r}/`))

const walkComponents = (relDir, visit, depth = 1) => {
  for (const name of listDirs(relDir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const rel = join(relDir, name)
    const files = listFiles(rel)
    if (files.some((f) => /^index\.tsx?$/.test(f))) visit(rel, name, files, depth)
    walkComponents(rel, visit, depth + 1)
  }
}

// The folder a changed file belongs to: the nearest ancestor holding an index.tsx, inside one of
// the component roots. Files outside those roots have no folder and are reviewed on their own.
const folderOf = (f) => {
  if (!underComponentRoot(f)) return null
  let dir = dirname(f)
  while (dir && dir !== '.' && underComponentRoot(dir)) {
    if (listFiles(dir).some((n) => /^index\.tsx?$/.test(n))) return dir
    dir = dirname(dir)
  }
  return null
}

const changedFolders = new Map()
for (const { file } of changed) {
  const folder = folderOf(file)
  if (!folder) continue
  if (!changedFolders.has(folder)) changedFolders.set(folder, { folder, name: basename(folder), files: [], isNew: false })
  changedFolders.get(folder).files.push(file)
}
for (const entry of changedFolders.values()) {
  const index = listFiles(entry.folder).find((n) => /^index\.tsx?$/.test(n))
  const indexRel = join(entry.folder, index)
  entry.index = indexRel
  entry.isNew = statusOf.get(indexRel)?.status === 'A' || Boolean(statusOf.get(indexRel)?.untracked)
  entry.all = listFiles(entry.folder).map((n) => join(entry.folder, n))
}

// ── sampled conventions — the repo's own habits, not this package's ───────────

const TESTID_PROP = /\b(testId|dataTestId|testID|data-testid|dataTestid)\b\??\s*:/
const TESTID_HELPER = /\b([a-zA-Z_]\w*)\(\s*(?:props\.)?(?:testId|dataTestId)\s*,/

const sampleTestIds = () => {
  const s = { sampled: 0, withTestId: 0, viaProp: 0, viaLiteral: 0, props: {}, helpers: {}, testsSampled: 0, testsByTestId: 0 }
  for (const root of COMPONENT_ROOTS)
    walkComponents(root, (rel, _name, files) => {
      const index = read(join(rel, files.find((f) => /^index\.tsx?$/.test(f))))
      if (index === null) return
      s.sampled++
      const types = files.filter((f) => /^types?\.ts$/.test(f)).map((f) => read(join(rel, f)) ?? '').join('\n')
      if (/data-testid/.test(index)) {
        s.withTestId++
        const prop = `${index}\n${types}`.match(TESTID_PROP)?.[1]
        if (prop) {
          s.viaProp++
          s.props[prop] = (s.props[prop] ?? 0) + 1
        } else s.viaLiteral++
        for (const m of index.matchAll(new RegExp(TESTID_HELPER.source, 'g'))) s.helpers[m[1]] = (s.helpers[m[1]] ?? 0) + 1
      }
      const test = files.find((f) => TEST_FILE.test(f))
      if (test) {
        s.testsSampled++
        if (/ByTestId\(/.test(read(join(rel, test)) ?? '')) s.testsByTestId++
      }
    })
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0] ?? null
  const coverage = s.sampled ? s.withTestId / s.sampled : 0
  return {
    ...s,
    coverage,
    // Established means a missing attribute is a defect (high); emerging means medium; none means
    // the repo has no habit for the review to hold the PR to, and the finding (low) says so.
    strength: s.sampled >= 5 && coverage >= 0.6 ? 'established' : s.sampled >= 2 && coverage >= 0.3 ? 'emerging' : 'none',
    prop: top(s.props)?.[0] ?? null,
    helper: (top(s.helpers) ?? [null, 0])[1] >= 3 ? top(s.helpers)[0] : null,
    propDriven: s.withTestId ? s.viaProp / s.withTestId >= 0.6 : false,
    testsUseTestId: s.testsSampled ? s.testsByTestId / s.testsSampled >= 0.6 : false
  }
}
const testIds = sampleTestIds()

const sampleReadonlyProps = () => {
  let files = 0
  let readonlyFiles = 0
  for (const root of COMPONENT_ROOTS)
    walkComponents(root, (rel, _n, list) => {
      for (const f of list.filter((n) => /^types?\.ts$/.test(n))) {
        const body = read(join(rel, f)) ?? ''
        if (!/^\s+\w+\??:/m.test(body)) continue
        files++
        if (/^\s+readonly\s+\w+/m.test(body)) readonlyFiles++
      }
    })
  return { files, readonlyFiles, expected: files >= 5 && readonlyFiles / files >= 0.6 }
}
const readonlyProps = sampleReadonlyProps()

const CONVENTIONAL_SUBJECT = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?!?: \S/
const sampleCommitStyle = () => {
  const subjects = gitLines('log', '-n', '50', '--format=%s', BASE).filter((s) => !/^Merge /.test(s))
  const conventional = subjects.filter((s) => CONVENTIONAL_SUBJECT.test(s)).length
  return { sampled: subjects.length, conventional, expected: subjects.length >= 10 && conventional / subjects.length >= 0.6 }
}
const commitStyle = sampleCommitStyle()

// The Universal Editor attributes are spread from a helper (CONVENTIONS.md §12); the review holds
// a new CMS-rendering component to the helper this repo actually has, not to a prescribed name.
const AEM_HELPER = /\b(getAem\w*Attributes|aemAttributes|getUeAttributes|getUniversalEditorAttributes)\s*\(/g
const sampleAem = () => {
  const s = { sampled: 0, withAttributes: 0, helpers: {} }
  for (const root of COMPONENT_ROOTS)
    walkComponents(root, (rel, _name, files) => {
      const index = read(join(rel, files.find((f) => /^index\.tsx?$/.test(f))))
      if (index === null) return
      s.sampled++
      const usesHelper = [...index.matchAll(AEM_HELPER)]
      if (usesHelper.length || /data-aue-/.test(index)) s.withAttributes++
      for (const m of usesHelper) s.helpers[m[1]] = (s.helpers[m[1]] ?? 0) + 1
    })
  const top = Object.entries(s.helpers).sort((a, b) => b[1] - a[1])[0] ?? null
  return { ...s, helper: top?.[0] ?? null }
}
const aem = sampleAem()

// The image atom every picture is meant to go through (§13.6) — named by the repo, not by us.
// A name alone is not enough — `image-count` is a badge — so the atom must render an image itself.
const imageAtom = (() => {
  if (!DS?.components) return null
  const renders = listDirs(join(DS.components, 'atoms')).filter((n) => {
    const index = read(join(DS.components, 'atoms', n, 'index.tsx'))
    return /(picture|image|img)/i.test(n) && index !== null && /<picture\b|<img\b|from\s+['"]next\/image['"]/.test(index)
  })
  return renders.find((n) => /picture/i.test(n)) ?? renders[0] ?? null
})()

// ── findings ──────────────────────────────────────────────────────────────────
// Each check carries its own "why" and "fix" so the report explains every row the same way, and
// a finding is a place plus a message. Severity follows ../references/review-categories.md: HIGH
// must not merge, MEDIUM should be fixed or explicitly accepted, LOW is the author's call.

const HIGH = 'HIGH'
const MEDIUM = 'MEDIUM'
const LOW = 'LOW'

const CHECKS = {
  'commit:attribution': {
    why: 'Commit messages are part of the delivered history; a vendor name, session link or tool trailer there is an authorship mark (CONVENTIONS.md §1.5).',
    fix: 'Reword or amend the commit (`git commit --amend` / interactive rebase) so the message describes the change and nothing else.'
  },
  'commit:style': {
    why: 'The base branch uses Conventional Commit subjects; a subject in another shape breaks changelog tooling and reads as foreign history.',
    fix: 'Rewrite the subject as `<type>(<scope>): <summary>` — e.g. `feat(booking-card): add loading state`.'
  },
  'commit:uncommitted': {
    why: 'Uncommitted edits are not in the pull request. Reviewing a branch that differs from the working tree reviews the wrong thing.',
    fix: 'Commit the edits onto the branch, or stash them, before opening the PR.'
  },
  'authorship:code': {
    why: 'Product code says nothing about how it was produced (CONVENTIONS.md §1.5). An authorship mark in a comment or a document ships to the client.',
    fix: 'Delete the mark. If the comment says nothing else, delete the comment.'
  },
  'authorship:conversational': {
    why: 'A comment written as a message to a reader ("I have added…", "let me know") is not a comment explaining code; it reads as pasted assistant output.',
    fix: 'Rewrite it as a why-comment in the team\'s voice, or remove it — CONVENTIONS.md §1.4.'
  },
  'testid:missing': {
    why: 'QA and end-to-end tests locate elements by `data-testid`. A component without one cannot be targeted without brittle selectors.',
    fix: 'Follow the sampled convention: accept the `testId` prop, set `data-testid` on the root, and suffix sub-elements with the helper where one exists.'
  },
  'testid:prop-name': {
    why: 'Two spellings of the same prop across components mean every consumer has to check which one applies.',
    fix: 'Rename the prop to the sampled form so callers and tests stay uniform.'
  },
  'testid:interactive': {
    why: 'An interactive element without a test id is the one testers most need to reach — buttons, links and inputs are what end-to-end tests click.',
    fix: 'Pass a suffixed id to each interactive element (`data-testid={helper(testId, "cta")}` or the repo\'s equivalent).'
  },
  'testid:literal-shared': {
    why: 'A hard-coded `data-testid` on a shared component collides the moment the component renders twice on a page.',
    fix: 'Take the id from a `testId` prop with a sensible default rather than a fixed literal.'
  },
  'testid:default': {
    why: 'A defaulted `testId` renders the same `data-testid` on every instance, so automation cannot tell two of them apart, and every snapshot carries an id nobody asked for (CONVENTIONS.md §10.2).',
    fix: 'Remove the default; render `data-testid` only when the caller passes `testId`.'
  },
  'testid:helper': {
    why: 'The repo builds sub-element ids through a helper; string-concatenating them by hand drifts from that pattern and skips its undefined-handling.',
    fix: 'Use the sampled helper for every derived id.'
  },
  'testid:tests': {
    why: 'The repo\'s tests locate elements by test id; a test that does not is either asserting less or relying on text that will change.',
    fix: 'Query by `getByTestId` for structure and by role/text for behaviour, matching the sibling tests.'
  },
  'tests:missing': {
    why: 'A component without a test file has no proof that it renders, its variants apply, or its accessibility holds — and the gate cannot fail on what does not exist.',
    fix: 'Add the test file the sampled convention names, covering render, each variant/state, and an accessibility assertion.'
  },
  'tests:untouched': {
    why: 'Behaviour changed but no test did. Either the tests never covered that behaviour, or they now pass by accident.',
    fix: 'Extend the existing test file with a case per changed behaviour; if nothing observable changed, say so in the PR description.'
  },
  'tests:module': {
    why: 'A new module with exported functions and no test is untested logic that the component tests reach only incidentally.',
    fix: 'Add a sibling `<name>.test.ts` covering the exported functions, or fold the logic into the component it serves.'
  },
  'tests:only': {
    why: '`.only` silently disables every other test in the file — the gate passes while covering almost nothing.',
    fix: 'Remove `.only`.'
  },
  'tests:skip': {
    why: 'A skipped test is a check that no longer runs. VERIFY.md §6 forbids passing the gate by skipping.',
    fix: 'Un-skip it and fix the cause, or delete it with a reason in the PR description.'
  },
  'tests:empty': {
    why: 'A test file with no test cases satisfies "a test exists" while proving nothing.',
    fix: 'Add at least a render test and one per variant or state.'
  },
  'security:eval': {
    why: 'Dynamic code execution turns any string that reaches it into code — a classic injection vector.',
    fix: 'Replace with a lookup table, `JSON.parse`, or an explicit function map.'
  },
  'security:html': {
    why: 'Writing raw HTML into the DOM renders whatever markup is in the string; with CMS-sourced content that is stored XSS.',
    fix: 'Render through React elements, or sanitise the string with an allow-list sanitiser and document where it originates.'
  },
  'security:dangerous-html': {
    why: '`dangerouslySetInnerHTML` bypasses React\'s escaping. It is safe only for content that is sanitised or authored by the team.',
    fix: 'Confirm the source is trusted or sanitised, name it in a comment, or replace with a rich-text renderer.'
  },
  'security:blank-target': {
    why: 'A `target="_blank"` link without `rel="noopener"` hands the opened page a reference to this window (reverse tabnabbing).',
    fix: 'Add `rel="noopener noreferrer"`, or use the repo\'s link atom which sets it.'
  },
  'security:javascript-href': {
    why: '`javascript:` URLs execute code on click and are blocked by strict CSP.',
    fix: 'Use an `onClick` handler and a `<button>`, or a real URL.'
  },
  'security:secret': {
    why: 'A credential in source is a credential in every clone, every CI log and every build artefact.',
    fix: 'Move it to an environment variable or the secrets manager, rotate the exposed value, and purge it from history if it was committed.'
  },
  'security:env-file': {
    why: 'A committed `.env` file publishes whatever it holds to everyone with repository access.',
    fix: 'Remove it from the PR, add it to `.gitignore`, and commit a `.env.example` with placeholder values instead.'
  },
  'security:public-secret': {
    why: '`NEXT_PUBLIC_*` variables are inlined into the browser bundle; a secret named that way is public by construction.',
    fix: 'Read the value server-side only and drop the `NEXT_PUBLIC_` prefix.'
  },
  'security:env-in-shared': {
    why: 'The design system is presentational and brand-neutral (CONVENTIONS.md §2.1). Reading `process.env` there couples every app to one environment shape, and a component that renders on the client can carry the value into the browser bundle.',
    fix: 'Read the value in the app and pass it down as a prop; for a public value, reuse the design system\'s existing public getter rather than adding a new read.'
  },
  'security:http': {
    why: 'A plain-HTTP URL from an HTTPS page is mixed content — blocked by browsers, or a downgrade for the user.',
    fix: 'Use `https://`, or a relative URL.'
  },
  'security:open-redirect': {
    why: 'Assigning a non-literal value to `location` sends the user wherever that value says; when it comes from a query string or CMS data it is an open redirect.',
    fix: 'Allow-list the destinations (or require a relative path) before navigating, and use the router rather than `window.location`.'
  },
  'security:postmessage-wildcard': {
    why: '`postMessage` with a `*` target origin delivers the payload to any window that holds a reference to this one, including a malicious opener.',
    fix: 'Pass the exact target origin, and check `event.origin` in the matching listener.'
  },
  'security:storage-secret': {
    why: 'Tokens and secrets in `localStorage`/`sessionStorage` are readable by any script on the origin — one XSS and the session is gone.',
    fix: 'Keep the credential in an `HttpOnly` cookie set by the server, or in memory for the lifetime of the page.'
  },
  'quality:debugger': {
    why: 'A `debugger` statement halts the browser for every user with devtools open.',
    fix: 'Remove it.'
  },
  'quality:console': {
    why: 'Debug output in product code reaches the browser console of every user and often leaks data shapes.',
    fix: 'Remove it, or route it through the repo\'s logger if one exists.'
  },
  'quality:any': {
    why: '`any` switches the type checker off for everything it touches; VERIFY.md §6 treats widening to `any` as relaxing the check, not fixing the cause.',
    fix: 'Give it the real type, `unknown` with narrowing, or a generic.'
  },
  'quality:ts-ignore': {
    why: 'Suppressing a type error hides a real mismatch; `@ts-nocheck` hides all of them.',
    fix: 'Fix the type. If suppression is genuinely required, use `@ts-expect-error` with the reason on the same line.'
  },
  'quality:eslint-disable': {
    why: 'Lint is zero-tolerance in this repo (`--max-warnings=0`); a disable comment is a failure the gate can no longer see (VERIFY.md §6).',
    fix: 'Fix the reported issue. If the rule is genuinely wrong here, say why on the same line and keep it to that one line.'
  },
  'quality:empty-catch': {
    why: 'An empty catch swallows the error and the evidence of it; failures then surface somewhere unrelated.',
    fix: 'Handle it, rethrow it, or at minimum record why ignoring it is correct.'
  },
  'quality:inline-style': {
    why: 'Styling is Tailwind utilities off the semantic token layer — not inline styles or CSS modules (CONVENTIONS.md §6). Inline values cannot be rebranded.',
    fix: 'Express it as utilities on semantic tokens; for genuinely dynamic values use a CSS variable set from the value.'
  },
  'quality:index-key': {
    why: 'An array index as a React key makes reordering, insertion and deletion re-use the wrong element state.',
    fix: 'Key by a stable id from the data.'
  },
  'quality:non-null': {
    why: 'Each `!` asserts something the types could not prove; several in one change usually mean the types are wrong, not the checker.',
    fix: 'Narrow with a guard, or fix the type so the value cannot be null there.'
  },
  'quality:merge-marker': {
    why: 'A conflict marker in source will not compile, and one in prose ships garbage.',
    fix: 'Resolve the conflict and remove the markers.'
  },
  'quality:readonly-props': {
    why: 'This repo declares props `readonly` (CONVENTIONS.md §5); a props type without it is the one consumers can mutate.',
    fix: 'Mark each prop `readonly` and take `Readonly<Props>` in the component signature.'
  },
  'quality:long-file': {
    why: 'A very long component file usually holds several components or a block of logic that belongs in a hook or util.',
    fix: 'Split it along the seams the code already has — sub-components, hooks, or a `lib/` module with its own tests.'
  },
  'comments:banner': {
    why: 'Section-divider comments add nothing the structure does not already say (CONVENTIONS.md §1.4).',
    fix: 'Delete the banner; if the file needs sections, it needs splitting.'
  },
  'comments:commented-code': {
    why: 'Commented-out code is history the version control already keeps, and it rots.',
    fix: 'Delete it. `git log` remembers.'
  },
  'comments:history': {
    why: 'A comment describing what the code used to do explains nothing about what it does now (CONVENTIONS.md §1.4).',
    fix: 'Remove it; the change description belongs in the commit message.'
  },
  'comments:paraphrase': {
    why: 'A comment that restates the line below it is noise that goes stale the first time the line changes (CONVENTIONS.md §1.4).',
    fix: 'Remove it, or replace it with the reason the line exists if that is not obvious.'
  },
  'comments:jsdoc-echo': {
    why: 'A JSDoc that repeats the prop\'s name adds a line to read and nothing to learn.',
    fix: 'Remove it, or state the constraint the name cannot: units, allowed range, what happens when absent.'
  },
  'comments:todo': {
    why: 'A bare TODO/FIXME/HACK has no owner and no scope; it is either work for this PR or a ticket, and the comment does not say which.',
    fix: 'Do it now, or convert it to the prescribed `TODO(<scope>): …` form with a ticket reference.'
  },
  'comments:density': {
    why: 'A file commented far more heavily than its siblings usually explains *what* rather than *why* (CONVENTIONS.md §1.4).',
    fix: 'Read each comment against §12.1: keep hacks, outside constraints, deviations and dense logic; delete the rest.'
  },
  'structure:naming': {
    why: 'Component folders are kebab-case (CONVENTIONS.md §4); a folder in another case breaks imports on case-sensitive filesystems and the repo\'s own tooling.',
    fix: 'Rename the folder and its imports.'
  },
  'structure:file-set': {
    why: 'The repo uses one spelling for this file (sampled from its components); a second form means siblings disagree about where to look.',
    fix: 'Rename to the sampled form.'
  },
  'structure:story': {
    why: 'Shared presentational components carry a Storybook story (CONVENTIONS.md §11) — it is how design reviews the component and how the Figma Verifier renders it.',
    fix: 'Add the story file the sampled convention names, with one story per variant and state.'
  },
  'structure:placement': {
    why: 'The design system holds presentational components; data fetching, env and routing belong in the app (CONVENTIONS.md §2.1).',
    fix: 'Move the data binding into an `apps/<slug>` router or wrapper and keep the shared component prop-driven.'
  },
  'structure:layer': {
    why: 'Dependency direction is atoms → composites → blocks → templates, with layouts below them (CONVENTIONS.md §3.1); an upward import creates a cycle waiting to happen.',
    fix: 'Move the shared piece down a layer, or lift the importing component up.'
  },
  'structure:stray': {
    why: 'Editor, OS and build artefacts have no place in the repository and get in every future diff.',
    fix: 'Remove the file from the PR and add its pattern to `.gitignore`.'
  },
  'structure:tooling': {
    why: 'Agent settings, skill files, context manifests and run reports never enter an application repository (CONVENTIONS.md §1.9, HARNESS.md §8).',
    fix: 'Remove the file from the PR (`git rm --cached <file>`); it belongs in the provisioned context or the reports directory.'
  },
  'structure:context': {
    why: 'The file is byte-identical to a file of the context package — engineering context was committed into the application, where it would drift from the pinned version and ship with the product (HARNESS.md §8).',
    fix: 'Remove the file from the PR (`git rm --cached <file>`). Context is provisioned outside the worktree for every run.'
  },
  'structure:fork': {
    why: 'A new component folder named like a copy of an existing one (`-v2`, `-copy`, `-new`, `-alt`, `-old`) is a fork; the two then drift and every fix has to land twice (CONVENTIONS.md §1.1).',
    fix: 'Express the difference as a named variant or prop on the existing component and delete the copy.'
  },
  'structure:generated': {
    why: 'The file carries a "generated — do not edit" banner. A hand edit is overwritten on the next generator run, and CI drift checks fail on it (CONVENTIONS.md §1.2).',
    fix: 'Edit the generator\'s source (e.g. the token export) and re-run the generator; confirm the PR also changes that source.'
  },
  'structure:large-file': {
    why: 'A large binary in git stays in every clone for ever, and design assets usually belong in the asset pipeline or CMS.',
    fix: 'Serve it from the CMS/CDN, optimise it, or confirm it genuinely belongs in source.'
  },
  'structure:config': {
    why: 'A change to build, lint, test or CI configuration affects every package and every future PR, and can hide a relaxed check.',
    fix: 'Call it out in the PR description with the reason; the reviewer should read the diff in full.'
  },
  'relaxed:lint': {
    why: 'Removing `--max-warnings=0` or loosening lint config lets the gate pass on code it used to reject (VERIFY.md §6).',
    fix: 'Restore the strict setting and fix the warnings it reports.'
  },
  'relaxed:strict': {
    why: 'Turning off `strict` (or a strict flag) disables type checks across the whole package.',
    fix: 'Restore the flag and fix the errors it surfaces.'
  },
  'deps:added': {
    why: 'A new dependency is code the team did not write, with its own licence, size and update cadence — reviewers should see it named.',
    fix: 'State in the PR description why it is needed and what was considered instead.'
  },
  'deps:unpinned': {
    why: 'A `latest` or `*` range installs whatever is current at install time, so two clones can build different code.',
    fix: 'Pin a caret or exact version.'
  },
  'deps:lockfile': {
    why: '`pnpm install --frozen-lockfile` fails when `package.json` and the lockfile disagree — CI will not pass.',
    fix: 'Run `pnpm install` and commit the updated `pnpm-lock.yaml`.'
  },
  'client:unneeded': {
    why: '`"use client"` moves the file and everything it imports into the browser bundle and out of server rendering; a file with no state, effect, handler, ref or browser API gains nothing from it (CONVENTIONS.md §5.1).',
    fix: 'Remove the directive. If something in the file genuinely needs the client, name it in the PR description; if only one element does, split that element into its own client file and keep the rest on the server.'
  },
  'client:page': {
    why: 'A page, layout or template marked `"use client"` turns the whole route into a client tree — every child loses server rendering and data access (CONVENTIONS.md §5.1).',
    fix: 'Remove the directive from the route file and move the interactive part into a small client component the page renders.'
  },
  'storybook:leak': {
    why: 'Mocks, fixtures and story assets exist for Storybook and tests. Imported from product code they ship to every user, and a change made for a story then changes production.',
    fix: 'Import real data or props instead; if the module is genuinely shared, move it out of the stories/mocks folder and drop the Storybook naming.'
  },
  'aem:missing': {
    why: 'A component that renders CMS content needs the Universal Editor `data-aue-*` attributes on each editable element so inline editing can be switched on later without a rewrite (CONVENTIONS.md §12).',
    fix: 'Spread the target\'s AEM helper onto each editable element, passing the content fragment\'s field name so `data-aue-prop` matches the CMS model. A purely presentational atom that receives plain strings is exempt — say so in the PR description.'
  },
  'aem:literal': {
    why: 'This repo derives its `data-aue-*` attributes through a helper; a hand-written set drifts from the CMS model and skips the helper\'s type handling (CONVENTIONS.md §12).',
    fix: 'Replace the literal attributes with a spread of the sampled helper, keyed by the CMS field name.'
  },
  'performance:raw-img': {
    why: 'A raw `<img>` serves the full-size asset with no responsive sizes, no lazy loading and no media-pipeline formats (CONVENTIONS.md §5.2).',
    fix: 'Render it through the repo\'s image atom (or `next/image` where no atom exists) with explicit dimensions; mark below-the-fold images lazy and prioritise the largest above-the-fold one.'
  },
  'performance:eager-embed': {
    why: 'An `<iframe>` without `loading="lazy"` loads a third-party document during the initial render, competing with the page\'s own content (CONVENTIONS.md §5.2).',
    fix: 'Add `loading="lazy"`, or render the embed with `next/dynamic` behind a click or an intersection observer when it is below the fold.'
  },
  'performance:whole-library': {
    why: 'Importing a whole utility or icon library pulls every export into the bundle for the handful that are used (CONVENTIONS.md §5.2).',
    fix: 'Import the specific function or icon by path or named export (`lodash/debounce`, `import { Search } from \'lucide-react\'`), or use the repo\'s own helper.'
  },
  'tokens:arbitrary': {
    why: 'A hard-coded size, spacing or type value bypasses the design tokens the theme is built on; it cannot be rebranded, does not scale with the type ramp and drifts from the siblings (CONVENTIONS.md §6).',
    fix: 'Use the token utility for that value (`text-body-lg`, `gap-4`, `rounded-md` or the repo\'s named scale). If no token exists, add one to the token source rather than the component, and say so in the PR description.'
  },
  'tokens:colour': {
    why: 'A hex, `rgb()` or `hsl()` literal or an arbitrary colour utility bypasses the semantic colour tier: it cannot follow the theme, the surface tone or a future rebrand (CONVENTIONS.md §6).',
    fix: 'Use the semantic utility for that role (`bg-surface-*`, `text-text-*`, `border-border-*`). If no token exists, it is a design question — raise it rather than hard-coding.'
  },
  'tokens:breakpoint': {
    why: 'A one-off breakpoint makes this component change layout at a width nothing else on the page uses; responsive behaviour must follow the theme\'s named screens (CONVENTIONS.md §7).',
    fix: 'Use the named breakpoint (`md:`, `lg:`, or the repo\'s screen names); if the design genuinely needs a new one, add it to the theme, not the component.'
  }
}

// The check prefix names the area the report groups by. Two areas get their own summary after the
// severity tables: `security`, because a reader looks for it first, and the checks that mean
// something the PR was expected to bring is absent — those are the "missing areas".
const AREAS = {
  commit: 'commits',
  authorship: 'ai-language',
  testid: 'test-ids',
  tests: 'tests',
  security: 'security',
  quality: 'quality',
  comments: 'comments',
  structure: 'structure',
  relaxed: 'standards',
  deps: 'dependencies',
  client: 'client-boundary',
  storybook: 'storybook',
  aem: 'aem',
  performance: 'performance',
  tokens: 'tokens'
}
// The sixteen review categories (../references/review-categories.md), in report order. Every area — the scanner's and the
// judgement half's — belongs to exactly one, so the reviewer's report and this output group alike.
const CATEGORIES = [
  { key: 'performance', title: 'Performance', areas: ['performance'] },
  { key: 'security', title: 'Security-related code observations', areas: ['security'] },
  { key: 'reusability', title: 'Reusability (atoms and blocks)', areas: ['reusability'] },
  { key: 'tokens', title: 'Design token usage', areas: ['tokens'] },
  { key: 'storybook', title: 'Storybook assets', areas: ['storybook'] },
  { key: 'tests', title: 'Test coverage', areas: ['tests'] },
  { key: 'aem', title: 'AEM attributes', areas: ['aem'] },
  { key: 'analytics', title: 'Analytics', areas: ['analytics'] },
  { key: 'test-ids', title: 'Test IDs', areas: ['test-ids'] },
  { key: 'client-boundary', title: '"use client" restrictions', areas: ['client-boundary'] },
  { key: 'quality', title: 'Code quality and best practices', areas: ['quality', 'standards', 'dependencies', 'correctness', 'best-practices', 'house-style'] },
  { key: 'structure', title: 'Structure and placement', areas: ['structure'] },
  { key: 'comments', title: 'Comments', areas: ['comments'] },
  { key: 'ai-language', title: 'AI-related language', areas: ['ai-language'] },
  { key: 'commits', title: 'Commits and working tree', areas: ['commits'] },
  { key: 'accessibility', title: 'Accessibility and i18n', areas: ['accessibility', 'i18n'] }
]
const categoryOf = (area) => CATEGORIES.find((c) => c.areas.includes(area))?.key ?? 'quality'
const MISSING = {
  'testid:missing': 'data-testid',
  'testid:interactive': 'data-testid',
  'testid:tests': 'test by id',
  'tests:missing': 'test file',
  'tests:untouched': 'test cases',
  'tests:module': 'module test',
  'tests:empty': 'test cases',
  'structure:story': 'story',
  'aem:missing': 'aem attributes'
}
const areaOf = (check) => AREAS[check.split(':')[0]]
const SECURITY_SCANNED = Object.keys(CHECKS)
  .filter((c) => c.startsWith('security:'))
  .map((c) => c.slice('security:'.length))

const findings = []
const report = (severity, check, file, line, message, detail = null) => {
  if (!CHECKS[check]) throw new Error(`unknown check ${check}`)
  const area = areaOf(check)
  findings.push({ severity, area, category: categoryOf(area), check, file, line, message, detail, missing: MISSING[check] ?? null })
}

// Facts the judgement half needs and no pattern can rule on — printed as data, never as findings.
const forJudgement = { analytics: [], clientFiles: [], memoisation: [], newAtoms: [], blocksWithoutAtoms: [], existingAtoms: [] }

const eachAdded = (files, fn) => {
  for (const f of files) for (const [line, text] of addedLines(f)) fn(f, line, text)
}

// ── 1. commits and working tree ───────────────────────────────────────────────

for (const c of commits) {
  const full = `${c.subject}\n${c.body}`
  const marked = full.split('\n').find((l) => ATTRIBUTION_COMMIT.test(l))
  if (marked) report(HIGH, 'commit:attribution', `commit ${c.short}`, null, `"${c.subject}" carries an authorship mark`, marked.trim().slice(0, 100))
  if (commitStyle.expected && !CONVENTIONAL_SUBJECT.test(c.subject) && !/^(Merge|Revert) /.test(c.subject))
    report(MEDIUM, 'commit:style', `commit ${c.short}`, null, `subject is not a Conventional Commit: "${c.subject}"`)
}
if (uncommitted.length)
  report(MEDIUM, 'commit:uncommitted', '(working tree)', null, `${uncommitted.length} uncommitted change(s) are not in the pull request`, uncommitted.slice(0, 10).join(', '))

// ── 2. authorship and conversational phrasing in what the PR added ────────────

for (const f of sourceFiles) {
  const added = addedLines(f)
  const body = read(f)
  if (body === null) continue
  for (const { line, text } of commentFragments(body)) {
    if (!added.has(line)) continue
    const mark = text.match(ATTRIBUTION)
    if (mark) report(HIGH, 'authorship:code', f, line, `authorship mark in a comment: "${text.slice(0, 90)}"`)
    else if (CONVERSATIONAL.test(text)) report(MEDIUM, 'authorship:conversational', f, line, `conversational phrasing in a comment: "${text.slice(0, 90)}"`)
  }
}
eachAdded(proseFiles, (f, line, text) => {
  if (ATTRIBUTION_PROSE.test(text)) report(HIGH, 'authorship:code', f, line, `authorship mark: "${text.trim().slice(0, 90)}"`)
  else if (/\.mdx?$/.test(f) && CONVERSATIONAL.test(text)) report(MEDIUM, 'authorship:conversational', f, line, `conversational phrasing: "${text.trim().slice(0, 90)}"`)
})

// ── 3. data-testid, against the sampled convention ────────────────────────────

const INTERACTIVE_TAG = /<(button|a|input|select|textarea|form|Button|Link|Input|Select|Checkbox|Radio|Switch|Toggle)\b/g
const openingTag = (body, at) => {
  let depth = 0
  for (let i = at; i < body.length; i++) {
    const ch = body[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return body.slice(at, i + 1)
  }
  return body.slice(at)
}
const lineAt = (body, at) => body.slice(0, at).split('\n').length

const missingSeverity = testIds.strength === 'established' ? HIGH : testIds.strength === 'emerging' ? MEDIUM : LOW

for (const entry of changedFolders.values()) {
  const index = read(entry.index)
  if (index === null || !statusOf.has(entry.index)) continue
  const added = addedLines(entry.index)
  const types = entry.all.filter((f) => /\/types?\.ts$/.test(f)).map((f) => read(f) ?? '').join('\n')
  const declared = `${index}\n${types}`.match(TESTID_PROP)?.[1] ?? null
  const hasTestId = /data-testid/.test(index)
  const shared = inDesignSystem(entry.index)

  if (!hasTestId && (entry.isNew || added.size >= 10)) {
    const note = testIds.strength === 'none' ? 'the repo shows no data-testid habit yet — adopt one with the design system' : `${Math.round(testIds.coverage * 100)}% of ${testIds.sampled} sampled components carry one`
    report(missingSeverity, 'testid:missing', entry.index, null, `${entry.name} sets no data-testid (${note})`)
    continue
  }
  if (hasTestId && testIds.prop && declared && declared !== testIds.prop && testIds.propDriven)
    report(MEDIUM, 'testid:prop-name', entry.index, null, `prop is \`${declared}\`; the repo's sampled form is \`${testIds.prop}\` (${testIds.props[testIds.prop]} of ${testIds.viaProp})`)
  if (hasTestId && shared && !declared && testIds.propDriven)
    report(LOW, 'testid:literal-shared', entry.index, null, `${entry.name} is shared and hard-codes its data-testid rather than taking \`${testIds.prop ?? 'testId'}\``)
  if (hasTestId && testIds.helper && !index.includes(`${testIds.helper}(`) && /data-testid=\{`\$\{[^}]*(testId|dataTestId)[^}]*\}-/.test(index))
    report(LOW, 'testid:helper', entry.index, null, `sub-element ids are concatenated by hand; the repo uses \`${testIds.helper}()\``)

  if (testIds.strength !== 'none') {
    const untagged = []
    for (const m of index.matchAll(INTERACTIVE_TAG)) {
      const tag = openingTag(index, m.index)
      const line = lineAt(index, m.index)
      if (!added.has(line)) continue
      if (/data-testid|testId|dataTestId|\{\.\.\./.test(tag)) continue
      untagged.push(`${line}: <${m[1]}>`)
    }
    if (untagged.length)
      report(testIds.strength === 'established' ? MEDIUM : LOW, 'testid:interactive', entry.index, Number(untagged[0].split(':')[0]), `${untagged.length} interactive element(s) added without a test id`, untagged.slice(0, 8).join(' · '))
  }

  // Prettier spaces a default value (`testId = 'x'`) and never a JSX attribute (`testId="x"`), so the
  // spacing tells a defaulted prop from a caller passing one.
  for (const f of entry.files.filter(isProductCode))
    for (const [line, text] of addedLines(f))
      if (/\b(testId|dataTestId)\s+=\s+['"`]/.test(text)) report(MEDIUM, 'testid:default', f, line, `\`${text.trim().slice(0, 60)}\` gives the test id a default value`)

  const testFile = entry.all.find(isTest)
  if (testFile && statusOf.has(testFile) && testIds.testsUseTestId && !/ByTestId\(/.test(read(testFile) ?? ''))
    report(LOW, 'testid:tests', testFile, null, `${entry.name}'s tests never query by test id; ${testIds.testsByTestId} of ${testIds.testsSampled} sampled test files do`)
}

// ── 4. tests ──────────────────────────────────────────────────────────────────

const sampledTestName = (name) => {
  const form = profile.conventions?.test?.form ?? 'index.test.tsx'
  return form.replace('<name>', name)
}
const behaviourFiles = /\/(index\.tsx?|variants?\.ts|[^/]+\.tsx)$/

// The test that owns a source file: `<stem>.test.tsx` when the folder splits its tests that way,
// otherwise the folder's index test, otherwise whichever test file it has.
const testFor = (entry, source) => {
  const tests = entry.all.filter(isTest)
  const stem = basename(source).replace(/\.[jt]sx?$/, '')
  return (
    tests.find((t) => basename(t).startsWith(`${stem}.`)) ??
    tests.find((t) => /^index\./.test(basename(t))) ??
    tests[0]
  )
}

for (const entry of changedFolders.values()) {
  const behaviour = entry.files.filter((f) => behaviourFiles.test(f) && !isTest(f) && !isStory(f))
  if (!entry.all.some(isTest)) {
    if (behaviour.length) report(entry.isNew ? HIGH : MEDIUM, 'tests:missing', entry.folder, null, `${entry.name} has no test file (expected \`${sampledTestName(entry.name)}\`)`)
    continue
  }
  if (behaviour.length && !entry.files.some(isTest))
    report(MEDIUM, 'tests:untouched', testFor(entry, behaviour[0]), null, `${entry.name} changed (${behaviour.map((n) => basename(n)).join(', ')}) but its tests did not`)
}

// Non-component modules: lib/, utils/, hooks/ with exports and no sibling test.
const MODULE_DIR = /\/(lib|utils?|hooks?|helpers?|services?)\//
for (const f of sourceFiles) {
  if (!isProductCode(f) || folderOf(f) || !MODULE_DIR.test(f) || /\.d\.ts$/.test(f)) continue
  const body = read(f) ?? ''
  if (!/^export\s+(const|function|async function|class)\s/m.test(body)) continue
  const stem = f.replace(/\.(ts|tsx|js|jsx)$/, '')
  const dir = dirname(f)
  const hasTest =
    ['test', 'spec'].some((k) => ['ts', 'tsx', 'js'].some((ext) => fs.existsSync(join(ROOT, `${stem}.${k}.${ext}`)))) ||
    listFiles(join(dir, '__tests__')).some((n) => n.startsWith(basename(stem)))
  if (!hasTest) {
    const isNew = statusOf.get(f)?.status === 'A' || statusOf.get(f)?.untracked
    report(isNew ? MEDIUM : LOW, 'tests:module', f, null, `${isNew ? 'new' : 'modified'} module exports functions and has no test`)
  }
}

for (const f of sourceFiles.filter(isTest)) {
  const body = read(f) ?? ''
  const added = addedLines(f)
  body.split('\n').forEach((text, i) => {
    const line = i + 1
    if (!added.has(line)) return
    if (/\b(it|test|describe)\.only\s*\(/.test(text)) report(HIGH, 'tests:only', f, line, '`.only` leaves every other test in the file unrun')
    if (/\b(it|test|describe)\.skip\s*\(|\bx(it|test|describe)\s*\(/.test(text)) report(MEDIUM, 'tests:skip', f, line, 'skipped test')
  })
  if (!/\b(it|test)\s*(\.\w+)?\s*\(/.test(body)) report(MEDIUM, 'tests:empty', f, null, 'test file declares no test cases')
}

// ── 5. security ───────────────────────────────────────────────────────────────

const SECRET_ASSIGN = /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*['"`][A-Za-z0-9_\-/+=.]{12,}['"`]/i
const SECRET_SHAPE = /\b(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/
const isClientFile = (f) => /^(['"])use client\1/m.test(read(f) ?? '')
// A sanitiser imported in the same file turns `dangerouslySetInnerHTML` from a question into a
// configuration to read; the finding stays, one level down, and names the library.
const SANITISER = /from\s+['"](sanitize-html|dompurify|isomorphic-dompurify|xss)['"]/

for (const { file: f } of changed) {
  if (/(^|\/)\.env(\.[^.]+)?$/.test(f) && !/\.(example|sample|template)$/.test(f))
    report(HIGH, 'security:env-file', f, null, 'environment file committed')
}

eachAdded(sourceFiles, (f, line, text) => {
  const test = isTest(f) || isStory(f)
  const code = blankLiterals(text)
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(code)) report(HIGH, 'security:eval', f, line, 'dynamic code execution')
  if (/\.(innerHTML|outerHTML)\s*=|\bdocument\.write\s*\(/.test(code)) report(HIGH, 'security:html', f, line, 'raw HTML written to the DOM')
  if (/dangerouslySetInnerHTML\s*[=:]/.test(code) && !test) {
    const sanitiser = SANITISER.exec(read(f) ?? '')?.[1]
    report(
      sanitiser ? LOW : MEDIUM,
      'security:dangerous-html',
      f,
      line,
      sanitiser
        ? `dangerouslySetInnerHTML — sanitised through \`${sanitiser}\` in this file; confirm its allow-list covers tags, attributes and schemes`
        : 'dangerouslySetInnerHTML — confirm the source is sanitised or trusted'
    )
  }
  if (/href\s*=\s*(\{\s*)?['"`]javascript:/i.test(text))
    report(test ? LOW : HIGH, 'security:javascript-href', f, line, test ? '`javascript:` URL in a test — confirm it is a fixture the test expects to be stripped' : '`javascript:` URL')
  if (/target\s*=\s*["'{]\s*['"]?_blank/.test(text) && !test) {
    const body = read(f) ?? ''
    const at = body.split('\n').slice(0, line - 1).join('\n').length + text.indexOf('target')
    const tagStart = body.lastIndexOf('<', at)
    if (tagStart !== -1 && !/\brel\s*=/.test(openingTag(body, tagStart))) report(MEDIUM, 'security:blank-target', f, line, 'target="_blank" without rel="noopener"')
  }
  if (SECRET_ASSIGN.test(text) || SECRET_SHAPE.test(text)) report(test ? MEDIUM : HIGH, 'security:secret', f, line, `credential-shaped literal${test ? ' in a test — confirm it is a fake' : ''}`)
  if (/NEXT_PUBLIC_[A-Z0-9_]*(SECRET|KEY|TOKEN|PASSWORD)/.test(text)) report(HIGH, 'security:public-secret', f, line, 'secret-named NEXT_PUBLIC_ variable is inlined into the browser bundle')
  if (/\bprocess\.env\b/.test(code) && inDesignSystem(f) && !test)
    report(
      /NEXT_PUBLIC_/.test(text) ? LOW : MEDIUM,
      'security:env-in-shared',
      f,
      line,
      /NEXT_PUBLIC_/.test(text) ? 'public process.env value read inside the design system' : 'non-public process.env value read inside the design system'
    )
  if (/\bprocess\.env\b/.test(code) && !inDesignSystem(f) && !test && isClientFile(f) && !/NEXT_PUBLIC_/.test(text))
    report(MEDIUM, 'security:env-in-shared', f, line, 'process.env read in a client component — only NEXT_PUBLIC_ values exist there')
  if (/['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\$\{)/.test(text) && !test) report(MEDIUM, 'security:http', f, line, 'plain-HTTP URL')
  if (/\b(window\.|document\.)?location(\.href)?\s*=\s*(?!['"`])[\w.[]/.test(code) && !/\blocation\.hash\b/.test(code) && !test)
    report(MEDIUM, 'security:open-redirect', f, line, 'navigation to a computed URL — confirm the destination is allow-listed')
  if (/\.postMessage\s*\([^)]*,\s*['"`]\*['"`]/.test(text)) report(HIGH, 'security:postmessage-wildcard', f, line, 'postMessage to `*`')
  if (/\b(localStorage|sessionStorage)\.setItem\s*\(\s*['"`][^'"`]*(token|secret|password|jwt|session|credential)/i.test(text) && !test)
    report(MEDIUM, 'security:storage-secret', f, line, 'credential written to web storage')
  if (/\bdebugger\b/.test(code)) report(HIGH, 'quality:debugger', f, line, '`debugger` statement')
  if (/\bconsole\.(log|debug|info|table|dir)\s*\(/.test(code) && !test) report(MEDIUM, 'quality:console', f, line, 'console output left in')
  if (/(:\s*any\b|\bas\s+any\b|<any>|Array<any>|any\[\])/.test(code) && !/\/\/.*any/.test(text)) report(MEDIUM, 'quality:any', f, line, '`any`')
  if (/@ts-(ignore|nocheck)\b/.test(text)) report(MEDIUM, 'quality:ts-ignore', f, line, text.trim().slice(0, 60))
  if (/@ts-expect-error\s*$/.test(text)) report(LOW, 'quality:ts-ignore', f, line, '`@ts-expect-error` without a reason')
  if (/eslint-disable/.test(text)) report(MEDIUM, 'quality:eslint-disable', f, line, text.trim().slice(0, 80))
  if (/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(code)) report(MEDIUM, 'quality:empty-catch', f, line, 'empty catch block')
  if (/\bstyle=\{\{/.test(code) && !test) report(MEDIUM, 'quality:inline-style', f, line, 'inline style object')
  if (/\.module\.(css|scss)['"]/.test(text)) report(MEDIUM, 'quality:inline-style', f, line, 'CSS module import')
  if (/\bkey=\{\s*(i|idx|index)\s*\}/.test(code)) report(LOW, 'quality:index-key', f, line, 'array index used as a React key')
  if (/^(<{7}|={7}|>{7})( |$)/.test(text)) report(HIGH, 'quality:merge-marker', f, line, 'merge conflict marker')
})
eachAdded(proseFiles, (f, line, text) => {
  if (/^(<{7}|={7}|>{7})( |$)/.test(text)) report(HIGH, 'quality:merge-marker', f, line, 'merge conflict marker')
  if (SECRET_SHAPE.test(text) || (SECRET_ASSIGN.test(text) && !/example|sample|placeholder|xxx|<[^>]+>/i.test(text)))
    report(HIGH, 'security:secret', f, line, 'credential-shaped literal')
})

// Several non-null assertions in one change usually mean wrong types rather than a careful author.
for (const f of sourceFiles.filter(isProductCode)) {
  let count = 0
  let first = null
  for (const [line, text] of addedLines(f)) {
    const n = (blankLiterals(text).match(/[\w\])]!(?=[.\[(;,)\s]|$)/g) ?? []).filter(() => !/!==?/.test(text)).length
    if (n && first === null) first = line
    count += n
  }
  if (count > 3) report(LOW, 'quality:non-null', f, first, `${count} non-null assertions added`)
  const body = read(f) ?? ''
  const lines = body.split('\n').length
  if (lines > 400 && addedLines(f).size > 100) report(LOW, 'quality:long-file', f, null, `${lines} lines`)
}

// readonly props, where the repo declares them
if (readonlyProps.expected)
  for (const f of sourceFiles) {
    if (!/\/types?\.ts$/.test(f) || !folderOf(f)) continue
    const body = read(f) ?? ''
    const added = addedLines(f)
    const members = [...body.matchAll(/^\s+(readonly\s+)?(\w+)\??\s*:/gm)].filter((m) => added.has(lineAt(body, m.index)))
    if (members.length >= 2 && !members.some((m) => m[1]))
      report(MEDIUM, 'quality:readonly-props', f, lineAt(body, members[0].index), `${members.length} props added without \`readonly\` (${readonlyProps.readonlyFiles} of ${readonlyProps.files} sampled type files use it)`)
  }

// ── 6. comments — quality, on added comment lines only ────────────────────────

const BANNER = /^[=\-_*#~]{4,}|^[=\-*#]+\s*[\w ]+\s*[=\-*#]+$/
const CODEISH_COMMENT = /^(const|let|var|import|export|return|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|else\b|try\b|catch\b|\}\s*\)?;?$|<\/?[A-Za-z][\w.]*[\s>/]|[\w.]+\([^)]*\);?$|[\w.]+\s*=\s*[^=].*;$|await\s|\w+\.\w+\(.*\)\s*;?$)/
const HISTORY = /^(was|previously|old(er)?|used to|before|changed (from|to)|updated (to|from)|removed|renamed|moved from|refactored|migrated)\b/i
const TODO = /\b(TODO|FIXME|XXX|HACK)\b(?!\([a-z0-9-]+\))/

const identTokens = (s) =>
  new Set(
    (s.match(/[A-Za-z_$][\w$]*/g) ?? [])
      .flatMap((w) => w.split(/(?=[A-Z])|_/))
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 4)
  )

for (const f of sourceFiles) {
  const body = read(f)
  if (body === null) continue
  const lines = body.split('\n')
  const added = addedLines(f)
  const fragments = commentFragments(body).filter((c) => added.has(c.line))
  if (!fragments.length) continue

  let run = []
  const flushRun = () => {
    if (run.length >= 2) report(MEDIUM, 'comments:commented-code', f, run[0].line, `${run.length} lines of commented-out code`)
    else if (run.length === 1) report(LOW, 'comments:commented-code', f, run[0].line, `commented-out code: "${run[0].text.slice(0, 60)}"`)
    run = []
  }
  let prev = null
  for (const c of fragments) {
    if (prev !== null && c.line !== prev + 1) flushRun()
    prev = c.line
    if (c.wholeLine && CODEISH_COMMENT.test(c.text) && !/^(https?:|\w+:\/\/)/.test(c.text)) {
      run.push(c)
      continue
    }
    flushRun()
    if (BANNER.test(c.text)) report(LOW, 'comments:banner', f, c.line, `banner comment: "${c.text.slice(0, 60)}"`)
    if (HISTORY.test(c.text)) report(LOW, 'comments:history', f, c.line, `history note: "${c.text.slice(0, 70)}"`)
    if (TODO.test(c.text)) report(LOW, 'comments:todo', f, c.line, `"${c.text.slice(0, 70)}"`)
    // Paraphrase: a short comment whose words are mostly the identifiers of the line below it.
    const next = lines[c.line] ?? ''
    const words = c.text.split(/\s+/).filter(Boolean)
    const isPropLine = /^\s+(?:readonly\s+)?\w+\??\s*:/.test(next)
    if (c.wholeLine && !isPropLine && !c.text.startsWith('*') && words.length >= 2 && words.length <= 8 && next.trim() && !/^\s*(\/\/|\/\*|\*)/.test(next)) {
      const ct = identTokens(c.text)
      const nt = identTokens(next)
      const shared = [...ct].filter((w) => nt.has(w)).length
      if (ct.size >= 2 && shared / ct.size >= 0.6)
        report(LOW, 'comments:paraphrase', f, c.line, `"${c.text.slice(0, 60)}" restates the next line`)
    }
    // JSDoc that only echoes the prop it documents.
    const jsdoc = c.text.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '')
    const propMatch = next.match(/^\s+(?:readonly\s+)?(\w+)\??\s*:/)
    if (propMatch && /^\s*\/\*\*/.test(lines[c.line - 1] ?? '') && jsdoc.split(/\s+/).length <= 5) {
      const pt = identTokens(propMatch[1])
      const ct = identTokens(jsdoc)
      if (ct.size && [...ct].every((w) => pt.has(w))) report(LOW, 'comments:jsdoc-echo', f, c.line, `"${jsdoc}" repeats \`${propMatch[1]}\``)
    }
  }
  flushRun()

  const addedCode = [...added.values()].filter((t) => t.trim()).length
  if (fragments.length >= 5 && addedCode && fragments.length / addedCode > 0.15 && !isTest(f))
    report(LOW, 'comments:density', f, fragments[0].line, `${fragments.length} comment lines in ${addedCode} added lines`)
}

// ── 7. structure and placement ────────────────────────────────────────────────

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
const DATA_BINDING = /\bfetch\s*\(|\bprocess\.env\b|from\s+['"]next\/(navigation|headers)['"]|from\s+['"][^'"]*\/lib\/aem|\buseRouter\s*\(|\bcookies\s*\(\)|\bheaders\s*\(\)/
const LAYERS = ['atoms', 'composites', 'blocks', 'layouts', 'templates']
const layerOf = (f) => {
  if (!DS?.components || !inDesignSystem(f)) return null
  const seg = f.slice(DS.components.length + 1).split('/')[0]
  return LAYERS.includes(seg) ? seg : null
}

for (const entry of changedFolders.values()) {
  if (!entry.isNew) continue
  if (!KEBAB.test(entry.name)) report(MEDIUM, 'structure:naming', entry.folder, null, `folder \`${entry.name}\` is not kebab-case`)
  const conv = profile.conventions ?? {}
  const check = (kind, re, label) => {
    const c = conv[kind]
    const names = entry.all.map((n) => basename(n)).filter((n) => re.test(n))
    if (!c || c.mixed || !names.length || conv.confidence === 'none') return
    const expected = c.form.replace('<name>', entry.name)
    // A folder may hold extra test files beside the conventional one (`carousel-drag.test.tsx` next
    // to `index.test.tsx`); only a folder with no file in the sampled form is out of step.
    const present = names[0]
    if (!names.includes(expected)) report(MEDIUM, 'structure:file-set', join(entry.folder, present), null, `${label} is \`${present}\`; the repo's sampled form is \`${expected}\` (${c.seen}/${c.total})`)
  }
  check('types', /^types?\.ts$/, 'types file')
  check('test', /\.test\.tsx?$/, 'test file')
  check('story', /\.stories\.tsx?$/, 'story file')
  if (inDesignSystem(entry.index) && !entry.all.some(isStory) && conv.story && conv.confidence !== 'none')
    report(MEDIUM, 'structure:story', entry.folder, null, `${entry.name} is a shared component with no story (expected \`${conv.story.form.replace('<name>', entry.name)}\`)`)
}

for (const f of sourceFiles.filter(isProductCode)) {
  const added = addedLines(f)
  const body = read(f) ?? ''
  if (inDesignSystem(f)) {
    body.split('\n').forEach((text, i) => {
      if (added.has(i + 1) && DATA_BINDING.test(blankLiterals(text)) && !/process\.env/.test(text))
        report(MEDIUM, 'structure:placement', f, i + 1, `data binding in the design system: "${text.trim().slice(0, 70)}"`)
    })
  }
  const layer = layerOf(f)
  if (layer) {
    const above = LAYERS.slice(LAYERS.indexOf(layer) + 1)
    body.split('\n').forEach((text, i) => {
      if (!added.has(i + 1)) return
      const m = text.match(/from\s+['"]([^'"]+)['"]/)
      if (!m) return
      const hit = above.find((l) => new RegExp(`(^|/)${l}(/|$)`).test(m[1]))
      if (hit) report(HIGH, 'structure:layer', f, i + 1, `${layer} imports from ${hit}: \`${m[1]}\``)
    })
  }
}

const FORK_NAME = /^(.+?)-(copy|clone|v\d+|new|alt|old|backup|tmp)$/
for (const entry of changedFolders.values()) {
  if (!entry.isNew) continue
  const m = entry.name.match(FORK_NAME)
  if (!m) continue
  const original = join(dirname(entry.folder), m[1])
  report(isDir(original) ? HIGH : MEDIUM, 'structure:fork', entry.folder, null, isDir(original) ? `new folder \`${entry.name}\` sits beside \`${m[1]}\`` : `new folder \`${entry.name}\` is named like a copy`)
}

// A generated file changed by hand is the problem; a generated file changed together with the source
// its generator reads (an export under design/, the generator under scripts/) is a regeneration to
// confirm. The banner is how a file says it is generated.
const GENERATED_BANNER = /GENERATED FILE|DO NOT EDIT|@generated\b|auto-generated/i
const isGenerated = (f) => GENERATED_BANNER.test((read(f) ?? '').split('\n').slice(0, 15).join('\n'))
const generatorInputChanged = changed.some(({ file: f }) => /^(design|scripts)\//.test(f) && !isGenerated(f))
for (const { file: f, status } of changed) {
  if (status === 'A' || !isGenerated(f)) continue
  report(generatorInputChanged ? LOW : MEDIUM, 'structure:generated', f, null, generatorInputChanged ? 'generated file changed — confirm it was produced by its generator from the changed source' : 'generated file changed with no change to a generator input')
}

// Context contamination: a changed file whose content is byte-identical to a file of the provisioned
// context package. Compared by content, because the application may legitimately own a file with
// the same name (this target has its own CONVENTIONS.md).
const sha256 = (abs) => createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
const contextHashes = (() => {
  if (!CONTEXT_ROOT) return null
  const out = new Set()
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue
      const abs = join(dir, name)
      const st = fs.statSync(abs)
      if (st.isDirectory()) walk(abs)
      else if (st.isFile() && st.size > 0) out.add(sha256(abs))
    }
  }
  walk(CONTEXT_ROOT)
  return out
})()
if (contextHashes)
  for (const { file: f } of changed) {
    const abs = join(ROOT, f)
    if (fs.statSync(abs).size > 0 && contextHashes.has(sha256(abs))) report(HIGH, 'structure:context', f, null, 'identical to a file of the context package')
  }

const STRAY = /(^|\/)(\.DS_Store|Thumbs\.db|.*\.(log|orig|rej|swp|swo|tmp|bak))$|(^|\/)(node_modules|coverage|dist|\.next|\.turbo|out|build|storybook-static)\//
const TOOLING = /^(\.claude|\.cursor|reports)\/|(^|\/)\.(claude|cursor)\/|(^|\/)(SKILL\.md|context-manifest\.json)$/
const CONFIG = /(^|\/)(package\.json|pnpm-workspace\.yaml|turbo\.json|tsconfig[^/]*\.json|eslint\.config\.[cm]?js|\.eslintrc[^/]*|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|postcss\.config\.[cm]?js|tailwind\.config\.[cm]?[jt]s|\.github\/.*|\.gitlab-ci\.yml|Dockerfile|\.npmrc)$/

// A package.json whose only change is a dependency block is reported by `deps:added`; flagging it
// as a configuration change too would say the same thing twice.
const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const depsOnlyChange = (f) => {
  if (!/(^|\/)package\.json$/.test(f)) return false
  const strip = (raw) => {
    const o = JSON.parse(raw)
    for (const k of DEP_KEYS) delete o[k]
    return JSON.stringify(o)
  }
  try {
    const before = baseVersion(f)
    return before !== null && strip(before) === strip(read(f) ?? 'null')
  } catch {
    return false
  }
}

for (const { file: f } of changed) {
  if (STRAY.test(f)) report(HIGH, 'structure:stray', f, null, 'artefact committed')
  if (TOOLING.test(f)) report(HIGH, 'structure:tooling', f, null, 'agent, skill or context file in an application repository')
  const size = fs.statSync(join(ROOT, f)).size
  if (size > 1024 * 1024) report(MEDIUM, 'structure:large-file', f, null, `${(size / 1024 / 1024).toFixed(1)} MB`)
  if (CONFIG.test(f) && !depsOnlyChange(f)) report(LOW, 'structure:config', f, null, 'build/lint/test/CI configuration changed')
}

// ── 8. §13 build requirements a scan can see ──────────────────────────────────

// "use client" — needed only by a file that itself holds state, an effect, a handler, a ref, a
// context provider or a browser API (§13.7). Custom hooks count: `useAnything(` is a hook call.
const CLIENT_NEEDS = /\buse[A-Z]\w*\s*\(|\bon[A-Z]\w*\s*=|\b(window|document|navigator|localStorage|sessionStorage|IntersectionObserver|ResizeObserver|MutationObserver|requestAnimationFrame|matchMedia)\b|\bcreateContext\s*\(|\.Provider\b|\bforwardRef\s*\(/
const ROUTE_FILE = /(^|\/)(page|layout|template|error|loading|not-found|default)\.[jt]sx?$/
const USE_CLIENT = /^\s*(['"])use client\1\s*;?\s*$/

for (const f of sourceFiles.filter(isProductCode)) {
  const added = addedLines(f)
  const directiveLine = [...added].find(([, text]) => USE_CLIENT.test(text))?.[0]
  if (!directiveLine) continue
  forJudgement.clientFiles.push(f)
  const body = read(f) ?? ''
  // Literals are blanked line by line: across a joined file, an apostrophe in one comment would pair
  // with the next one and blank every hook call in between.
  const rest = body
    .split('\n')
    .filter((l) => !USE_CLIENT.test(l))
    .map(blankLiterals)
    .join('\n')
  if (ROUTE_FILE.test(f)) report(MEDIUM, 'client:page', f, directiveLine, `"use client" on a route file (${basename(f)})`)
  else if (!CLIENT_NEEDS.test(rest)) report(MEDIUM, 'client:unneeded', f, directiveLine, '"use client" in a file with no hook, handler, ref, provider or browser API — confirm it is needed')
}

// Storybook-only material reaching product code.
const STORYBOOK_SPEC = /\.stories(\.[jt]sx?)?$|(^|\/)(__mocks__|mocks?|__fixtures__|fixtures?|stories|storybook|\.storybook|story-data|mock-data)(\/|$)|\.(mock|mocks|fixture|fixtures|stories)\.[jt]sx?$|^@storybook\/|^storybook(\/|$)/
const IMPORT_SPEC = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/
const inStorybookLand = (f) => /(^|\/)(\.storybook|stories|__mocks__|__fixtures__|mocks|fixtures)\//.test(f)
eachAdded(sourceFiles.filter((f) => isProductCode(f) && !inStorybookLand(f)), (f, line, text) => {
  const spec = text.match(IMPORT_SPEC)?.[1]
  if (spec && STORYBOOK_SPEC.test(spec)) report(MEDIUM, 'storybook:leak', f, line, `product code imports Storybook-only material: \`${spec}\``)
})

// AEM attributes on new CMS-rendering components — every layer but atoms (§13.2).
for (const entry of changedFolders.values()) {
  const layer = layerOf(entry.index)
  if (!entry.isNew || layer === 'atoms') continue
  const bodies = entry.all.filter(isProductCode).map((f) => read(f) ?? '').join('\n')
  const helperRe = aem.helper ? new RegExp(`\\b${aem.helper}\\s*\\(`) : null
  if (/data-aue-/.test(bodies) || (helperRe && helperRe.test(bodies))) continue
  const note = aem.helper
    ? `${aem.withAttributes} of ${aem.sampled} sampled components spread \`${aem.helper}()\``
    : 'no AEM attribute helper found in this repo — adopt one with the design system'
  report(aem.helper ? MEDIUM : LOW, 'aem:missing', entry.index, null, `${entry.name} (${layer ?? 'app component'}) carries no Universal Editor attributes (${note})`)
}
if (aem.helper)
  eachAdded(sourceFiles.filter(isProductCode), (f, line, text) => {
    if (/\bdata-aue-\w+\s*=/.test(text)) report(LOW, 'aem:literal', f, line, `hand-written \`data-aue-*\` attribute; the repo derives them through \`${aem.helper}()\``)
  })

// Performance: raw images, eager embeds, whole-library imports; memoisation listed for judgement.
const WHOLE_LIBRARY = /\bfrom\s+['"](lodash|underscore|moment|ramda)['"]|\bimport\s+\*\s+as\s+\w+\s+from\s+['"](lucide-react|react-icons(\/\w+)?|@mui\/icons-material|@heroicons\/react(\/\w+)?|@tabler\/icons-react|date-fns|lodash(-es)?)['"]/
eachAdded(sourceFiles.filter(isProductCode), (f, line, text) => {
  const code = blankLiterals(text)
  if (/<img\b/.test(code))
    report(imageAtom ? MEDIUM : LOW, 'performance:raw-img', f, line, imageAtom ? `raw \`<img>\`; the repo's image atom is \`atoms/${imageAtom}\`` : 'raw `<img>` and no image atom found — use `next/image` with `loading="lazy"` below the fold')
  if (/<iframe\b/.test(code)) {
    const body = read(f) ?? ''
    const at = body.split('\n').slice(0, line - 1).join('\n').length + text.indexOf('<iframe')
    if (at >= 0 && !/\bloading\s*=/.test(openingTag(body, at))) report(MEDIUM, 'performance:eager-embed', f, line, '`<iframe>` without `loading="lazy"`')
  }
  const lib = text.match(WHOLE_LIBRARY)
  if (lib) report(LOW, 'performance:whole-library', f, line, `whole-library import: \`${lib[1] ?? lib[2]}\``)
  if (/\b(useMemo|useCallback|React\.memo|memo)\s*\(/.test(code)) forJudgement.memoisation.push(`${f}:${line}`)
})

// Tokens: colour literals, arbitrary values and one-off breakpoints.
const ARBITRARY = /(?:^|[\s'"`])(?:[a-z-]+:)*(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|w|h|size|min-w|max-w|min-h|max-h|inset|top|right|bottom|left|z|rounded(?:-[a-z]+)?|text|font|leading|tracking|indent)-\[([^\]]+)\]/g
const TYPE_PREFIX = /^(text|font|leading|tracking)$/
const isTokenValue = (v) => /^(var\(|--|theme\()/.test(v) || /^#|^rgb|^hsl/.test(v)
const BREAKPOINT = /(?:^|[\s'"`])(?:min|max)-\[[^\]]+\]:/
eachAdded(sourceFiles.filter(isProductCode), (f, line, text) => {
  let hit = null
  for (const m of text.matchAll(ARBITRARY)) {
    if (isTokenValue(m[2])) continue
    if (!hit || (TYPE_PREFIX.test(m[1]) && !TYPE_PREFIX.test(hit[1]))) hit = m
  }
  if (hit) report(TYPE_PREFIX.test(hit[1]) ? MEDIUM : LOW, 'tokens:arbitrary', f, line, `hard-coded ${TYPE_PREFIX.test(hit[1]) ? 'typography' : 'spacing/size'} value \`${hit[1]}-[${hit[2]}]\``)
  if (BREAKPOINT.test(text)) report(MEDIUM, 'tokens:breakpoint', f, line, 'one-off breakpoint')
})
for (const { file: f } of changed) {
  if (!/\.(css|scss)$/.test(f)) continue
  for (const [line, text] of addedLines(f))
    if (/@media[^{]*\(\s*(min|max)-width\s*:\s*\d/.test(text)) report(MEDIUM, 'tokens:breakpoint', f, line, `raw media query: "${text.trim().slice(0, 60)}"`)
}

// Colour literals. Token sources and generated token CSS are where colours are supposed to live, so
// they are not scanned; everything else the PR added is.
const COLOUR_UTILITY = /\b[a-z][\w-]*-\[(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/
const QUOTED_HEX = /(['"`])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\1/
const COLOUR_FN = /\b(rgba?|hsla?)\(\s*\d/
const CSS_COLOUR = /:[^;{]*(#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\()/
const isTokenSource = (f) => /(^|\/)(styles\/tokens|design\/tokens)\//.test(f) || isGenerated(f)
eachAdded(sourceFiles.filter((f) => isProductCode(f) && !isTokenSource(f)), (f, line, text) => {
  const hit = text.match(COLOUR_UTILITY)?.[0] ?? text.match(QUOTED_HEX)?.[0] ?? text.match(COLOUR_FN)?.[0]
  if (hit) report(MEDIUM, 'tokens:colour', f, line, `colour literal \`${hit}\``)
})
for (const { file: f } of changed) {
  if (!/\.(css|scss)$/.test(f) || isTokenSource(f)) continue
  for (const [line, text] of addedLines(f)) {
    if (/^\s*--[\w-]+\s*:/.test(text)) continue
    const hit = text.match(CSS_COLOUR)
    if (hit) report(MEDIUM, 'tokens:colour', f, line, `colour literal in CSS: "${text.trim().slice(0, 60)}"`)
  }
}

// Analytics and reusability: no pattern can rule on these — the ticket and the atom inventory can.
const ANALYTICS = /\b(trackEvent|pushToDataLayer|getAnalyticsButtonProps|dataLayer\.push|gtag|fbq|analytics\.(track|page|identify)|useAnalytics|data-(analytics|gtm|tracking|track)(-[\w-]+)?)\b|from\s+['"][^'"]*analytics['"]/
eachAdded(sourceFiles.filter(isProductCode), (f, line, text) => {
  if (ANALYTICS.test(text)) forJudgement.analytics.push({ file: f, line, text: text.trim().slice(0, 90) })
})
if (DS?.components) forJudgement.existingAtoms = listDirs(join(DS.components, 'atoms')).filter((n) => !changedFolders.has(join(DS.components, 'atoms', n)) || !changedFolders.get(join(DS.components, 'atoms', n)).isNew)
for (const entry of changedFolders.values()) {
  if (!entry.isNew) continue
  const layer = layerOf(entry.index)
  if (layer === 'atoms') forJudgement.newAtoms.push(entry.folder)
  else if (layer && layer !== 'atoms') {
    const body = read(entry.index) ?? ''
    if (!/from\s+['"][^'"]*\/atoms\//.test(body) && !/from\s+['"]@[\w-]+\/ui['"]/.test(body)) forJudgement.blocksWithoutAtoms.push(entry.folder)
  }
}

// ── 9. relaxed checks and dependencies ────────────────────────────────────────

const parseJson = (s) => {
  try {
    return s === null ? null : JSON.parse(s)
  } catch {
    return null
  }
}

for (const { file: f } of changed) {
  if (!/(^|\/)package\.json$/.test(f)) continue
  const now = parseJson(read(f))
  const before = parseJson(baseVersion(f))
  if (!now) continue
  const lintBefore = before?.scripts?.lint ?? ''
  const lintNow = now.scripts?.lint ?? ''
  if (/--max-warnings[= ]0\b/.test(lintBefore) && !/--max-warnings[= ]0\b/.test(lintNow))
    report(HIGH, 'relaxed:lint', f, null, `lint script lost \`--max-warnings=0\`: "${lintNow}"`)
  else if (/--max-warnings[= ]([1-9]\d*)/.test(lintNow) && !/--max-warnings[= ]([1-9]\d*)/.test(lintBefore))
    report(HIGH, 'relaxed:lint', f, null, `lint script now tolerates warnings: "${lintNow}"`)
  for (const kind of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(now[kind] ?? {})) {
      if (before?.[kind]?.[name] === range) continue
      if (!before?.[kind]?.[name]) report(LOW, 'deps:added', f, null, `${kind}: ${name}@${range}`)
      if (/^(\*|latest|x)$/.test(String(range))) report(MEDIUM, 'deps:unpinned', f, null, `${name}@${range}`)
    }
  }
}
const depsChanged = changed.some(({ file: f }) => {
  if (!/(^|\/)package\.json$/.test(f)) return false
  const now = parseJson(read(f))
  const before = parseJson(baseVersion(f))
  const deps = (p) => JSON.stringify([p?.dependencies, p?.devDependencies, p?.peerDependencies, p?.optionalDependencies])
  return before !== null && now !== null && deps(now) !== deps(before)
})
const lockChanged = changed.some(({ file: f }) => f === 'pnpm-lock.yaml')
if (depsChanged && !lockChanged) report(HIGH, 'deps:lockfile', 'pnpm-lock.yaml', null, 'dependencies changed but the lockfile did not')

for (const { file: f } of changed) {
  if (!/tsconfig[^/]*\.json$/.test(f)) continue
  const now = parseJson((read(f) ?? '').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))
  const before = parseJson((baseVersion(f) ?? '').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))
  const co = (p) => p?.compilerOptions ?? {}
  for (const k of ['strict', 'strictNullChecks', 'noImplicitAny', 'noUnusedLocals', 'noUnusedParameters'])
    if (co(before)[k] === true && co(now)[k] === false) report(HIGH, 'relaxed:strict', f, null, `\`${k}\` turned off`)
  if (before === null && co(now).strict === false) report(HIGH, 'relaxed:strict', f, null, 'new tsconfig with `strict: false`')
}
for (const { file: f } of changed) {
  if (!/eslint\.config\.[cm]?js$|\.eslintrc/.test(f)) continue
  const now = read(f) ?? ''
  const before = baseVersion(f) ?? ''
  const offs = (s) => (s.match(/['"]off['"]|:\s*0\b/g) ?? []).length
  if (before && offs(now) > offs(before)) report(MEDIUM, 'relaxed:lint', f, null, `${offs(now) - offs(before)} more rule(s) turned off than on ${BASE}`)
}

// ── verdict and output ────────────────────────────────────────────────────────

const SEVERITIES = [HIGH, MEDIUM, LOW]
const order = { [HIGH]: 0, [MEDIUM]: 1, [LOW]: 2 }
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
const counts = { [HIGH]: 0, [MEDIUM]: 0, [LOW]: 0 }
for (const f of findings) counts[f.severity]++
const verdict = counts[HIGH] ? 'NOT_READY' : counts[MEDIUM] ? 'READY_WITH_WARNINGS' : 'READY'
const tally = `${counts[HIGH]} HIGH · ${counts[MEDIUM]} MEDIUM · ${counts[LOW]} LOW`

const securityFindings = findings.filter((x) => x.area === 'security')
const checksIn = (cat) => Object.keys(CHECKS).filter((c) => cat.areas.includes(areaOf(c))).map((c) => c.split(':')[1])
// Missing areas are grouped by the folder (or file) they belong to, so the reader sees "this
// component lacks a test, a story and a root test id" as one entry rather than three rows.
const missingAreas = (() => {
  const byPlace = new Map()
  for (const x of findings.filter((y) => y.missing)) {
    const place = isDir(x.file) ? x.file : (folderOf(x.file) ?? x.file)
    if (!byPlace.has(place)) byPlace.set(place, [])
    byPlace.get(place).push(x)
  }
  return [...byPlace.entries()].map(([place, items]) => ({ place, items }))
})()
const areaCounts = {}
for (const x of findings) {
  areaCounts[x.area] ??= { [HIGH]: 0, [MEDIUM]: 0, [LOW]: 0 }
  areaCounts[x.area][x.severity]++
}
const categoryCounts = {}
for (const c of CATEGORIES) categoryCounts[c.key] = { [HIGH]: 0, [MEDIUM]: 0, [LOW]: 0 }
for (const x of findings) categoryCounts[x.category][x.severity]++

const conventionSummary = {
  testId: {
    strength: testIds.strength,
    coverage: `${testIds.withTestId}/${testIds.sampled}`,
    prop: testIds.prop,
    helper: testIds.helper,
    propDriven: testIds.propDriven,
    testsByTestId: `${testIds.testsByTestId}/${testIds.testsSampled}`
  },
  readonlyProps: `${readonlyProps.readonlyFiles}/${readonlyProps.files}${readonlyProps.expected ? ' (expected)' : ''}`,
  commits: `${commitStyle.conventional}/${commitStyle.sampled} conventional on ${BASE}${commitStyle.expected ? ' (expected)' : ''}`,
  aem: { helper: aem.helper, coverage: `${aem.withAttributes}/${aem.sampled}` },
  imageAtom,
  files: profile.conventions
}

if (!QUIET) {
  const short = (ref) => git('rev-parse', '--short', ref).trim()
  console.log(`\nPR readiness — ${ROOT}`)
  console.log(`  branch ${currentBranch} @ ${profile.git.head}  ·  base ${BASE} @ ${short(BASE)}  ·  merge-base ${short(MERGE_BASE)}`)
  console.log(
    `  ${commits.length} commit(s) · ${changed.length} changed file(s)` +
      (deleted.length ? ` · ${deleted.length} deleted` : '') +
      (uncommitted.length ? ` · ${uncommitted.length} uncommitted` : '') +
      ` · ${sourceFiles.length} source · ${changedFolders.size} component folder(s)` +
      (APP ? ` · app ${APP}` : '') +
      (PKG ? ` · package ${PKG}` : '') +
      '\n'
  )
  console.log('  Sampled from this repository (the review holds the PR to these habits):')
  console.log(
    `    data-testid   ${testIds.strength} — ${conventionSummary.testId.coverage} components carry one` +
      (testIds.prop ? ` · prop \`${testIds.prop}\`` : '') +
      (testIds.helper ? ` · helper \`${testIds.helper}()\`` : '') +
      ` · tests by id ${conventionSummary.testId.testsByTestId}`
  )
  console.log(`    readonly props ${conventionSummary.readonlyProps}`)
  console.log(`    commits       ${conventionSummary.commits}`)
  console.log(`    aem           ${aem.helper ? `\`${aem.helper}()\` — ${conventionSummary.aem.coverage} components carry attributes` : 'no helper found'}`)
  console.log(`    image atom    ${imageAtom ? `atoms/${imageAtom}` : 'none found'}`)
  const conv = profile.conventions
  if (conv?.sampled)
    console.log(`    files         test ${conv.test?.form ?? '—'} · story ${conv.story?.form ?? '—'} · types ${conv.types?.form ?? '—'} (${conv.sampled} sampled, ${conv.confidence})`)
  console.log('')

  const whereOf = (x) => (x.line ? `${x.file}:${x.line}` : x.file)
  // Grouped by the §J categories, in their fixed order, high first inside each. A category with
  // nothing to report names the checks that ran, so the reader can tell "clean" from "unchecked".
  const JUDGEMENT_ONLY = {
    reusability: 'no scanner check — the judgement half reads the new atoms and the atom inventory listed below',
    analytics: 'no scanner check — the judgement half compares the call sites listed below with the ticket',
    accessibility: 'no scanner check — the judgement half reads the diff for keyboard, screen-reader, locale and RTL paths'
  }
  for (const cat of CATEGORIES) {
    const rows = findings.filter((x) => x.category === cat.key)
    const c = categoryCounts[cat.key]
    console.log(`  ${cat.title.toUpperCase()} (${rows.length}${rows.length ? ` — ${c[HIGH]} HIGH · ${c[MEDIUM]} MEDIUM · ${c[LOW]} LOW` : ''})`)
    if (!rows.length) {
      const checks = checksIn(cat)
      console.log(`    no issues — ${checks.length ? `scanned added lines for: ${checks.join(', ')}` : JUDGEMENT_ONLY[cat.key] ?? 'nothing to scan'}`)
    }
    for (const x of rows) {
      console.log(`    • ${x.severity.padEnd(7)} ${whereOf(x)}  [${x.area} · ${x.check}]`)
      console.log(`        ${x.message}`)
      if (x.detail) console.log(`        ${x.detail}`)
      console.log(`        why: ${CHECKS[x.check].why}`)
      console.log(`        fix: ${CHECKS[x.check].fix}`)
    }
    console.log('')
  }

  console.log(`  MISSING AREAS (${missingAreas.reduce((n, m) => n + m.items.length, 0)})`)
  if (!missingAreas.length) console.log('    none — every changed component brought its test, story and test ids per the sampled convention')
  for (const m of missingAreas) {
    console.log(`    • ${m.place}`)
    for (const x of m.items) console.log(`        ${x.severity.padEnd(7)} ${x.missing.padEnd(11)} ${x.message}${x.line ? ` (${x.file}:${x.line})` : ''}`)
  }
  console.log('')

  console.log('  FOR THE JUDGEMENT HALF (data, not findings)')
  console.log(`    analytics call sites   ${forJudgement.analytics.length ? '' : 'none added — any analytics the ticket asks for is missing; if it asks for none, this is correct'}`)
  for (const a of forJudgement.analytics) console.log(`        ${a.file}:${a.line}  ${a.text}`)
  console.log(`    "use client" added in  ${forJudgement.clientFiles.length ? forJudgement.clientFiles.join(', ') : 'no file'}`)
  console.log(`    memoisation added at   ${forJudgement.memoisation.length ? forJudgement.memoisation.join(', ') : 'nowhere'}`)
  console.log(`    new atoms              ${forJudgement.newAtoms.length ? forJudgement.newAtoms.join(', ') : 'none'}`)
  if (forJudgement.newAtoms.length) console.log(`    existing atoms         ${forJudgement.existingAtoms.join(', ') || 'none'}`)
  console.log(`    new non-atoms importing no atom  ${forJudgement.blocksWithoutAtoms.length ? forJudgement.blocksWithoutAtoms.join(', ') : 'none'}`)
  console.log('')

  console.log('  By category')
  for (const cat of CATEGORIES) {
    const c = categoryCounts[cat.key]
    if (c[HIGH] + c[MEDIUM] + c[LOW]) console.log(`    ${cat.title.padEnd(34)} ${c[HIGH]} HIGH · ${c[MEDIUM]} MEDIUM · ${c[LOW]} LOW`)
  }
  if (!findings.length) console.log('    no findings')
  console.log('')

  console.log(`  Context contamination check: ${contextHashes ? `ran against ${contextHashes.size} context files` : 'SKIPPED — no context package found (pass --context-root)'}`)
  console.log(`  Verdict: ${verdict}  (${tally})`)
  console.log(`  scanner row → | pr scan (review-pr.mjs) | ${verdict} | ${tally} over ${changed.length} files, ${commits.length} commits |\n`)
  console.log('  This is the deterministic half. Run the repository\'s own typecheck, lint, tests and build')
  console.log('  (VERIFY.md §3), and read the diff for what no pattern can see.\n')
}

if (JSON_OUT) {
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        repo: ROOT,
        branch: currentBranch,
        head: git('rev-parse', 'HEAD').trim(),
        base: BASE,
        mergeBase: MERGE_BASE,
        app: APP ?? null,
        package: PKG ?? null,
        commits,
        changed: changedAll,
        uncommitted,
        conventions: conventionSummary,
        counts,
        areas: areaCounts,
        categories: CATEGORIES.map((c) => ({ ...c, counts: categoryCounts[c.key], scanned: checksIn(c) })),
        forJudgement,
        verdict,
        contextCheck: contextHashes ? { ran: true, contextRoot: CONTEXT_ROOT, files: contextHashes.size } : { ran: false, reason: 'no context package found' },
        security: { scanned: SECURITY_SCANNED, findings: securityFindings.map((x) => ({ ...x, why: CHECKS[x.check].why, fix: CHECKS[x.check].fix })) },
        missing: missingAreas.map((m) => ({ place: m.place, items: m.items.map((x) => ({ ...x, why: CHECKS[x.check].why, fix: CHECKS[x.check].fix })) })),
        findings: findings.map((x) => ({ ...x, why: CHECKS[x.check].why, fix: CHECKS[x.check].fix }))
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
  if (!QUIET) console.log(`  JSON written to ${JSON_OUT}\n`)
}

process.exit(counts[HIGH] ? 1 : 0)
