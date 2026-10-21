/**
 * repo-profile.mjs — the facts review-pr.mjs needs about the repository under review, derived from
 * the repository itself and never asserted.
 *
 * Identity is established by shape rather than by name: the design-system package is the workspace
 * package that holds `src/components` (preferring one with a Tailwind `src/styles/theme.css`, then
 * the conventional name `ui`); apps are `apps/<slug>` folders with a `package.json`. A repository
 * with neither — a single-package service, say — still profiles: the component checks simply have
 * nothing to look at, and the profile says so in `notes`.
 *
 * Every git call runs with GIT_OPTIONAL_LOCKS=0 so that even `status` does not refresh the index:
 * the reviewer must leave the worktree byte-for-byte as it found it.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'

const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile()
const readJson = (p) => {
  try {
    return isFile(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
  } catch {
    return null
  }
}
const listDirs = (p) => (isDir(p) ? fs.readdirSync(p).filter((n) => isDir(join(p, n))).sort() : [])

export const READ_ONLY_GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }

const gitIn = (root) => (...args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: READ_ONLY_GIT_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024
    })
  } catch {
    return null
  }
}

const findDesignSystem = (root) => {
  const candidates = listDirs(join(root, 'packages'))
    .map((pkg) => ({ pkg, dir: join('packages', pkg) }))
    .filter((c) => isDir(join(root, c.dir, 'src/components')))
  if (!candidates.length) return null
  const themed = candidates.filter((c) => isFile(join(root, c.dir, 'src/styles/theme.css')))
  const pool = themed.length ? themed : candidates
  const chosen = pool.find((c) => c.pkg === 'ui') ?? pool[0]
  const components = join(chosen.dir, 'src/components')
  return {
    package: chosen.dir,
    name: readJson(join(root, chosen.dir, 'package.json'))?.name ?? null,
    components,
    styles: isDir(join(root, chosen.dir, 'src/styles')) ? join(chosen.dir, 'src/styles') : null,
    layers: listDirs(join(root, components))
  }
}

const findApps = (root) =>
  listDirs(join(root, 'apps'))
    .filter((slug) => isFile(join(root, 'apps', slug, 'package.json')))
    .map((slug) => ({ slug, dir: join('apps', slug) }))

// File-name forms are sampled, not prescribed: a repository split between two spellings is reported
// as `mixed` so that either form conforms, and a nearly empty one reports low confidence instead of
// enshrining its only component as house style.
const sampleConventions = (root, ds) => {
  const empty = { sampled: 0, confidence: 'none', test: null, story: null, types: null, variants: null }
  if (!ds?.components) return empty
  const tally = { test: {}, story: {}, types: {}, variants: {} }
  const bump = (kind, form) => {
    if (form) tally[kind][form] = (tally[kind][form] ?? 0) + 1
  }
  let sampled = 0
  const walk = (relDir) => {
    for (const name of listDirs(join(root, relDir))) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const rel = join(relDir, name)
      const files = fs.readdirSync(join(root, rel))
      if (files.some((f) => /^index\.tsx?$/.test(f))) {
        sampled++
        const shape = (f, kind) => (f === undefined ? undefined : f === `index.${kind}` ? `index.${kind}` : f === `${name}.${kind}` ? `<name>.${kind}` : f)
        bump('test', shape(files.find((f) => /\.test\.tsx?$/.test(f)), 'test.tsx'))
        bump('story', shape(files.find((f) => /\.stories\.tsx?$/.test(f)), 'stories.tsx'))
        bump('types', files.find((f) => /^types?\.ts$/.test(f)))
        bump('variants', files.find((f) => /^variants?\.ts$/.test(f)))
      }
      walk(rel)
    }
  }
  walk(ds.components)
  const dominant = (kind) => {
    const entries = Object.entries(tally[kind]).sort((a, b) => b[1] - a[1])
    if (!entries.length) return null
    const [form, seen] = entries[0]
    const runnerUp = entries[1]?.[1] ?? 0
    return { form, seen, total: entries.reduce((n, [, k]) => n + k, 0), mixed: runnerUp / seen >= 0.6 }
  }
  return {
    sampled,
    confidence: sampled >= 5 ? 'high' : sampled >= 2 ? 'low' : 'none',
    test: dominant('test'),
    story: dominant('story'),
    types: dominant('types'),
    variants: dominant('variants')
  }
}

// Symlinked locations (macOS /var → /private/var, mounted workspaces) make the same directory answer
// to two paths, and git reports the real one. Every comparison is made between real paths.
export const realPath = (p) => {
  try {
    return fs.realpathSync(resolve(p))
  } catch {
    return resolve(p)
  }
}

export const profileRepo = (path) => {
  const problems = []
  const notes = []
  if (!isDir(resolve(path))) return { path: resolve(path), problems: ['path does not exist'], notes }
  const root = realPath(path)

  const git = gitIn(root)
  const toplevel = (git('rev-parse', '--show-toplevel') ?? '').trim()
  const isRepo = Boolean(toplevel) && realPath(toplevel) === root
  const head = isRepo ? (git('rev-parse', '--short', 'HEAD') ?? '').trim() || null : null
  if (!isRepo) problems.push('not the top level of a git repository')

  const designSystem = findDesignSystem(root)
  const apps = findApps(root)
  if (!designSystem) notes.push('no design-system package (packages/*/src/components) — component checks have nothing to inspect')
  if (!apps.length) notes.push('no apps/* packages found')

  return {
    path: root,
    rootPackageName: readJson(join(root, 'package.json'))?.name ?? null,
    designSystem,
    apps,
    conventions: sampleConventions(root, designSystem),
    git: {
      isRepo,
      hasCommits: head !== null,
      head,
      branch: isRepo ? (git('rev-parse', '--abbrev-ref', 'HEAD') ?? '').trim() || null : null
    },
    problems,
    notes
  }
}
