/**
 * Smoke test for review-pr.mjs: builds throwaway git repositories in the OS temp directory, runs the
 * scanner against them, and checks the verdict, the findings, the exit codes and that the scanner
 * left the repository exactly as it found it.
 *
 *   node --test skills/pr-review/scripts/review-pr.test.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'review-pr.mjs')
const CONTEXT_ROOT = resolve(HERE, '../../..')

const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  })

const write = (repo, rel, body) => {
  fs.mkdirSync(dirname(join(repo, rel)), { recursive: true })
  fs.writeFileSync(join(repo, rel), body)
}

const ATOM = {
  'index.tsx': `import { cn } from '../../../lib/utils'\nimport type { TagProps } from './type'\nimport { tagVariants } from './variants'\n\nexport const Tag = ({ label, className, testId }: Readonly<TagProps>) => (\n  <span data-testid={testId} className={cn(tagVariants(), className)}>\n    {label}\n  </span>\n)\n`,
  'type.ts': `export interface TagProps {\n  readonly label: string\n  readonly className?: string\n  readonly testId?: string\n}\n`,
  'variants.ts': `import { cva } from 'class-variance-authority'\n\nexport const tagVariants = cva('type-tags-02-regular px-md text-text-on-primary-100')\n`,
  'index.test.tsx': `import { render, screen } from '@testing-library/react'\nimport { Tag } from './index'\n\ndescribe('Tag', () => {\n  it('renders its label', () => {\n    render(<Tag label="New" testId="tag" />)\n    expect(screen.getByTestId('tag')).toHaveTextContent('New')\n  })\n})\n`,
  'ui.stories.tsx': `import { Tag } from './index'\n\nexport default { title: 'Atoms/Tag', component: Tag }\nexport const Default = { args: { label: 'New' } }\n`
}

const makeBaseRepo = () => {
  const repo = fs.mkdtempSync(join(tmpdir(), 'review-pr-fixture-'))
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, 'package.json', JSON.stringify({ name: 'fixture', private: true, scripts: { lint: 'eslint . --max-warnings=0' } }, null, 2) + '\n')
  write(repo, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n')
  write(repo, 'packages/ui/package.json', JSON.stringify({ name: '@workspace/ui' }) + '\n')
  write(repo, 'packages/ui/src/styles/theme.css', "@import './tokens/semantic.css';\n")
  write(repo, 'packages/ui/src/styles/tokens/semantic.css', '/* GENERATED FILE — DO NOT EDIT. */\n:root { --color-surface-primary-100: #123456; }\n')
  write(repo, 'packages/ui/src/lib/utils.ts', 'export const cn = (...c: string[]) => c.join(\' \')\n')
  for (const name of ['tag', 'badge', 'label', 'chip', 'pill', 'button'])
    for (const [file, body] of Object.entries(ATOM)) write(repo, `packages/ui/src/components/atoms/${name}/${file}`, body)
  write(repo, 'apps/web/package.json', JSON.stringify({ name: 'web' }) + '\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'chore: initial workspace')
  for (let i = 0; i < 10; i++) git(repo, 'commit', '-q', '--allow-empty', '-m', `chore(repo): baseline ${i}`)
  return repo
}

const snapshot = (repo) => ({
  head: git(repo, 'rev-parse', 'HEAD').trim(),
  status: git(repo, 'status', '--porcelain'),
  index: fs.statSync(join(repo, '.git', 'index')).mtimeMs
})

const run = (repo, extra = []) => {
  const out = join(fs.mkdtempSync(join(tmpdir(), 'review-pr-out-')), 'result.json')
  const res = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--base', 'main', '--context-root', CONTEXT_ROOT, '--json', out, '--quiet', ...extra], { encoding: 'utf8' })
  return { ...res, json: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null }
}

test('flags a pull request that breaks the conventions, and leaves the repository untouched', () => {
  const repo = makeBaseRepo()
  git(repo, 'switch', '-q', '-c', 'feat/promo')
  write(repo, 'packages/ui/src/components/blocks/promo/index.tsx', [
    "'use client'",
    '',
    "export const Promo = ({ title, testId = 'promo' }: { title: string; testId?: string }) => {",
    "  const value = eval('1 + 1')",
    '  return <section data-testid={testId} className="bg-[#ff0000] p-md">{title}{value}</section>',
    '}',
    ''
  ].join('\n'))
  write(repo, 'SKILL.md', '---\nname: stray\ndescription: stray\n---\n')
  fs.copyFileSync(join(CONTEXT_ROOT, 'HARNESS.md'), join(repo, 'docs-harness.md'))
  for (const [file, body] of Object.entries(ATOM)) write(repo, `packages/ui/src/components/atoms/tag-copy/${file}`, body)
  write(repo, 'packages/ui/src/styles/tokens/semantic.css', '/* GENERATED FILE — DO NOT EDIT. */\n:root { --color-surface-primary-100: #654321; }\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'updated stuff')

  const before = snapshot(repo)
  const { status, json, stderr } = run(repo)
  const after = snapshot(repo)

  assert.equal(status, 1, `expected exit 1 (NOT_READY); stderr: ${stderr}`)
  assert.equal(json.verdict, 'NOT_READY')
  const checks = new Set(json.findings.map((f) => f.check))
  for (const expected of [
    'security:eval',
    'tokens:colour',
    'client:unneeded',
    'testid:default',
    'tests:missing',
    'structure:story',
    'structure:tooling',
    'structure:context',
    'structure:fork',
    'structure:generated',
    'commit:style'
  ])
    assert.ok(checks.has(expected), `missing finding ${expected}; got ${[...checks].join(', ')}`)
  assert.ok(json.findings.every((f) => ['HIGH', 'MEDIUM', 'LOW'].includes(f.severity)))
  assert.equal(json.categories.length, 16)
  assert.equal(json.contextCheck.ran, true)
  assert.deepEqual(after, before, 'the scanner changed the repository')
})

test('passes a pull request that follows the conventions', () => {
  const repo = makeBaseRepo()
  git(repo, 'switch', '-q', '-c', 'feat/status')
  for (const [file, body] of Object.entries(ATOM))
    write(repo, `packages/ui/src/components/atoms/status/${file}`, body.replaceAll('Tag', 'Status').replaceAll('tag', 'status'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'feat(ui): add the status atom')

  const { status, json, stderr } = run(repo)
  assert.equal(status, 0, `expected exit 0; stderr: ${stderr}`)
  assert.notEqual(json.verdict, 'NOT_READY')
  assert.equal(json.counts.HIGH, 0, JSON.stringify(json.findings, null, 2))
})

test('does not repeat the false positives found on a real repository', () => {
  const repo = makeBaseRepo()
  write(repo, 'packages/ui/src/components/atoms/image-count/index.tsx', 'export const ImageCount = ({ n }: { n: number }) => <span>{n}</span>\n')
  write(repo, 'packages/ui/src/components/atoms/responsive-picture/index.tsx', 'export const ResponsivePicture = ({ src }: { src: string }) => <picture><img src={src} alt="" /></picture>\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'chore(ui): add image atoms')
  git(repo, 'switch', '-q', '-c', 'feat/header')
  for (const [file, body] of Object.entries(ATOM)) write(repo, `packages/ui/src/components/blocks/header/${file}`, body.replaceAll('Tag', 'Header').replaceAll('tag', 'header'))
  write(repo, 'packages/ui/src/components/blocks/header/drag.test.tsx', "it('drags', () => {})\n")
  write(repo, 'packages/ui/src/components/blocks/header/listing-header.tsx', [
    "'use client'",
    '',
    "// The editor's toolbar needs the edit mode; it's read on the client.",
    "import { useEditMode } from './use-edit-mode'",
    '',
    'export const ListingHeader = () => {',
    '  const mode = useEditMode()',
    '  return <img src="/logo.svg" alt="" data-mode={mode} />',
    '}',
    ''
  ].join('\n'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'feat(ui): add the header block')

  const { json } = run(repo)
  const checks = json.findings.map((f) => f.check)
  assert.ok(!checks.includes('client:unneeded'), 'a hook call after an apostrophe in a comment was missed')
  assert.ok(!checks.includes('structure:file-set'), 'an extra test file beside index.test.tsx was flagged')
  assert.equal(json.conventions.imageAtom, 'responsive-picture')
  assert.match(json.findings.find((f) => f.check === 'performance:raw-img').message, /responsive-picture/)
})

test('refuses usage errors with exit code 2', () => {
  const repo = makeBaseRepo()
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2)
  const inside = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--base', 'main', '--json', join(repo, 'out.json')], { encoding: 'utf8' })
  assert.equal(inside.status, 2)
  assert.match(inside.stderr, /outside the repository/)
  assert.equal(fs.existsSync(join(repo, 'out.json')), false)
})
