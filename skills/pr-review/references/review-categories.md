# PR review — the sixteen categories

The methodology behind `../SKILL.md` step 5. Each category lists what the scanner
(`../scripts/review-pr.mjs`) checks mechanically, what the reviewer judges from the diff, and the
default severities. Categories 1–10 read back the build requirements of `CONVENTIONS.md` from the
finished branch; 11–16 are general engineering standards. **Every category is reported, in this
order**, with findings or a statement of what was checked.

Severity reference: `HIGH` must fix before merge · `MEDIUM` fix or explicitly accept in the PR
description · `LOW` author's call · `ENHANCEMENT` optional, never counted in the verdict. Where the
target repository is stricter than a default below (this target forbids arbitrary Tailwind values
outright), apply the stricter severity and say why.

---

## 1. Performance

**Scanner:** `performance:raw-img` (raw `<img>` where the repository has an image atom — the atom is
detected by what it renders), `performance:eager-embed` (`<iframe>` without `loading`),
`performance:whole-library`; lists memoisation sites for judgement.

**Judge:** state held higher than used; new object/array literals passed to memoised children; a
context value recreated each render; each memo — measurable work or reflex? Heavy or below-the-fold
media, maps, embeds and widgets not behind `next/dynamic`/`loading="lazy"`; the largest above-the-fold
image not prioritised; oversized assets committed; a client-only dependency in a file that could stay
on the server. A raw `<img>` with a stated, valid reason (e.g. the atom's preset crop) is kept and
annotated, one level down.

Defaults: whole page client-rendered for one handler, or an eager full-size hero on every route →
`HIGH`; raw `<img>` / eager iframe → `MEDIUM`; whole-library import → `LOW`; a memo that could go →
`ENHANCEMENT`.

## 2. Security-related code observations

**Scanner:** `security:eval`, `security:html` (`innerHTML`/`outerHTML`/`document.write`),
`security:dangerous-html` (lower when a sanitiser is imported in the file), `security:javascript-href`,
`security:blank-target`, `security:secret` (credential-shaped literals and key shapes),
`security:env-file`, `security:public-secret` (secret-named `NEXT_PUBLIC_*`), `security:env-in-shared`,
`security:http`, `security:open-redirect`, `security:postmessage-wildcard`, `security:storage-secret`.

**Judge:** is every `dangerouslySetInnerHTML` source sanitised through the repository's renderer
(`atoms/rte-renderer`)? Does a CMS or user string reach the DOM unescaped another way? Is a URL from
CMS data or a query string validated before becoming an `href`, `src` or redirect? Is a `process.env`
read server-only? Does an error leak a stack or internal URL?

This category is **never blank**: when clean, list the patterns scanned and what was checked in
context. It records observations; the Security Reviewer performs the full assessment — reference its
report rather than duplicating it.

Defaults: credential in source, unsanitised CMS/user HTML, `eval`, `javascript:` URL, `postMessage`
to `*`, secret in client code → `HIGH`; `dangerouslySetInnerHTML` unconfirmed, `target="_blank"`
without `rel`, computed redirect, token in web storage, plain HTTP → `MEDIUM`.

## 3. Component reusability and atomic design

**Scanner:** lists new atoms beside the existing atom inventory and new non-atoms that import no atom.

**Judge:** does an existing atom already cover a new one (a variant would have done)? Does a block
build inline a badge, tag, caption, rating or icon button another block also needs (an atom in
waiting)? Is UI logic duplicated across files in the diff? Is a composite used by only one block
(belongs in that block)? Does the dependency direction hold?

Defaults: a second copy of an existing component (fork) → `HIGH`; inline element that should be an
atom, new atom duplicating one → `MEDIUM`; a refactor that would let two blocks share an atom →
`ENHANCEMENT`.

## 4. Design token usage

**Scanner:** `tokens:colour` (hex/`rgb()`/`hsl()` literals and arbitrary colour utilities outside token
sources), `tokens:arbitrary` (arbitrary spacing/size/type values), `tokens:breakpoint` (one-off
breakpoints and raw media queries), `quality:inline-style`.

**Judge:** does a token exist under a name the author did not find? Semantic tier used rather than
palette or primitives? Type styles as composite `type-*` utilities, never size + family by hand?
`hover-supported:hover:` rather than bare `hover:` (target rule)?

Defaults: colour literal, hard-coded typography, one-off breakpoint, inline style → `MEDIUM`; other
arbitrary values → `LOW` by default, `MEDIUM` in this target.

## 5. Storybook completeness

**Scanner:** `storybook:leak` (product code importing `.stories`, `mocks/`, `fixtures/`, `.storybook/`,
`@storybook/*`), `structure:story` (shared component with no story).

**Judge:** a story per meaningful state and variant; long content; both locales; blocks on both
surface tones; story `title` by layer; fixtures not read at runtime by components or wrappers;
story-only defaults not shipped.

Defaults: Storybook material imported by product code, shared component with no story → `MEDIUM`;
missing state story → `LOW`; a story that would document a tested state → `ENHANCEMENT`.

## 6. Test coverage

**Scanner:** `tests:missing`, `tests:untouched` (behaviour changed, tests did not), `tests:module`,
`tests:only`, `tests:skip`, `tests:empty`.

**Judge:** each acceptance criterion has a **named** test; each state and variant; loading, error,
empty, disabled, keyboard, Arabic/RTL; a test that passes without proving its name; a util whose test
still asserts old behaviour. Unit tests assert on roles and text (target rule), not classes.

Defaults: `.only`, new component with no test where the repository tests everything → `HIGH`;
missing tests for changed behaviour, unexplained skip → `MEDIUM`.

## 7. AEM attributes (where applicable)

**Scanner:** `aem:missing` (new non-atom component with no Universal Editor attributes, judged against
the sampled helper), `aem:literal` (hand-written `data-aue-*`).

**Judge:** every authorable element (heading, copy, CTA, image, list items, containers) carries
attributes via the block's `aem.ts` / `getAemDataAttributes` with the content-fragment **field name**;
new components registered in `AllowedComponent`; atoms with plain strings exempt (say so). Not
applicable to non-CMS repositories or non-CMS components — state that.

Defaults: missing attributes where a helper exists → `MEDIUM`; no helper in the repository → `LOW`
("adopt one"); hand-written set → `LOW`.

## 8. Analytics requirements

**Scanner:** lists every analytics call site the PR added (data, not findings).

**Judge — say which situation applied:**
- *Ticket specifies analytics:* each event/data-layer push/attribute implemented exactly as written,
  through `@workspace/analytics`, and tested. Anything missing or different → `MEDIUM`.
- *Ticket silent:* every added call site is unrequested instrumentation → `MEDIUM`.
- *No ticket text supplied:* every call site listed as unverifiable → `MEDIUM`, fix "attach the ticket
  or remove the call".

## 9. Test IDs

**Scanner:** `testid:missing` (severity from the sampled habit: established ≥ 60 % of ≥ 5 components
→ `HIGH`, emerging ≥ 30 % → `MEDIUM`, none → `LOW`), `testid:interactive`, `testid:prop-name`,
`testid:literal-shared`, `testid:default`, `testid:helper`, `testid:tests`.

**Judge:** ids on the elements automation drives (the `<input>`, not its wrapper), stable and unique
per instance, derived with `testIdPart()`, **no default value, nothing rendered when absent**, none on
decorative atoms (target rules); supported suffixes listed in the `testId` doc comment.

Defaults: defaulted `testId`, wrong prop name → `MEDIUM`; hand-concatenated ids → `LOW`.

## 10. Client/server component boundaries

**Scanner:** `client:page` (`"use client"` on a route file), `client:unneeded` (directive in a file with
no hook call, handler, browser API, context or ref); lists every file gaining the directive.

**Judge:** does *this file* need the client? If only one element does, name the element to split out
and the sibling file name the repository would use. App wrappers that carry section marks are never
client. A route file or folder index with the directive is a finding whatever it contains.

Defaults: whole route client-rendered → `HIGH`; unneeded directive → `MEDIUM`; boundary larger than
needed → `MEDIUM` or `ENHANCEMENT` by size.

## 11. Code quality

**Scanner:** `quality:any`, `quality:ts-ignore`, `quality:eslint-disable`, `quality:console`,
`quality:debugger`, `quality:empty-catch`, `quality:index-key`, `quality:non-null`,
`quality:merge-marker`, `quality:readonly-props` (only where the repository uses `readonly`
members), `quality:long-file`, `relaxed:lint`, `relaxed:strict`, `deps:added`, `deps:unpinned`,
`deps:lockfile`.

**Judge:** correctness and edge cases (empty arrays, `undefined` props, error paths); effects doing
derived state's job; hooks called conditionally; prop drilling; naming; error handling; house style
against the neighbouring files; maintainability (would the next engineer understand it?).

Defaults: relaxed lint/strict, merge marker, `debugger`, lockfile out of step → `HIGH`; `any`,
suppression, `console`, empty catch → `MEDIUM`; index keys, non-null clusters, long files → `LOW`.

## 12. Structure and placement

**Scanner:** `structure:naming` (kebab-case), `structure:file-set` (sampled spellings),
`structure:placement` (data binding in the design system), `structure:layer` (upward imports),
`structure:fork`, `structure:generated` (hand-edited generated files), `structure:stray`,
`structure:tooling`, `structure:context` (byte-identical copies of context files),
`structure:large-file`, `structure:config`.

**Judge:** fixed five-file layout for new components (target rule); presentational vs wrapper split;
is a "shared" component brand-neutral? Does the change belong in this package at all?

Defaults: upward layer import, fork beside its original, tooling/context file, stray artefact → `HIGH`;
naming, file set, placement, generated file changed without its source → `MEDIUM`; config change →
`LOW` (read it in full).

## 13. Comments and documentation quality

**Scanner:** `comments:banner`, `comments:commented-code`, `comments:history`, `comments:paraphrase`,
`comments:jsdoc-echo`, `comments:todo` (bare, without the prescribed `TODO(<scope>)` form),
`comments:density`.

**Judge:** does each added comment say *why* (`CONVENTIONS.md` §1.4)? A dense file can be earned
(worked examples, `/** */` prop docs that Storybook reads); a sparse comment can still be noise. Are
READMEs accurate for the new behaviour? Inherited comments are not the PR's.

Defaults: commented-out code (≥ 2 lines) → `MEDIUM`; banners, paraphrase, history, bare TODO,
density → `LOW`.

## 14. AI-generated artefacts and inappropriate language

**Scanner:** `authorship:code` (marks in comments and prose), `authorship:conversational`,
`commit:attribution`.

**Judge:** anything the patterns missed in code, tests, stories, READMEs, commit messages and the PR
description: vendor or model names, session links, "as an assistant", emoji signatures, paragraphs
that read as a chat reply, placeholder or filler text, hallucinated references (imports, helpers or
docs that do not exist), unprofessional or offensive language.

Defaults: authorship mark anywhere → `HIGH`; conversational phrasing → `MEDIUM`.

## 15. Commit quality

**Scanner:** `commit:style` (non-Conventional subject on a Conventional base), `commit:attribution`,
`commit:uncommitted`.

**Judge:** commits that bundle unrelated changes; subjects that describe the wrong thing; fixups that
should be squashed (this target squash-merges to development — note, don't block); scope matches the
package touched.

Defaults: attribution trailer → `HIGH`; non-Conventional subject, uncommitted edits → `MEDIUM`.

## 16. Accessibility and internationalisation

**Scanner:** none — judgement only.

**Judge:** semantic elements; keyboard reachability and operation; visible focus and focus
management; accessible names; `alt` from CMS fields; reduced motion; the second locale and RTL —
logical utilities, mirrored icons, no hard-coded copy or direction; Arabic tests and stories.

Defaults: unreachable or unnamed interactive element, LTR-only layout → `HIGH` in bilingual
repositories; missing Arabic test/story, missing focus style → `MEDIUM`.

---

## Missing areas

A **view**, not extra findings: group by the folder that lacks something (test file, story, test
cases, test ids, AEM attributes, a state the ticket asks for, a locale, a keyboard path). Every row
also sits in its category and counts once.

## Fix classes

The Orchestrator presents the numbered recommendations to the developer, who selects which to apply;
nothing is applied without a selected number, and a `HIGH` severity is not consent. Classify each:

| Class | Applied by an engineer only when its number is selected | Examples |
| :-- | :-- | :-- |
| `MAY_APPLY` | Mechanical, reversible | Remove an authorship mark, conversational comment, banner, commented-out code; remove `console.log`, `debugger`, `.only`; add `rel="noopener noreferrer"`; add `loading="lazy"` to a below-the-fold iframe; remove an unused Storybook import; un-skip a test |
| `SHOW_FIRST` | Selected **and** the exact change shown to the developer before applying | Rewrite a comment to say why; rename `dataTestId` → `testId` (list callers); add `data-testid`s; replace `any` with a real type; replace an arbitrary value with a token utility; remove an unneeded `"use client"` |
| `DEVELOPER_ONLY` | Never applied by the workflow; the item says what the developer does | Rewrite or amend a commit; add or change tests (give name and assertion); add AEM attributes (field names are the developer's); add/remove analytics; split a client boundary, move files, extract an atom; replace a raw `<img>` with the image atom; change `package.json`, lockfile, lint, TypeScript or CI config; `git rm --cached` a tracked stray/context file; anything that changes rendered output or behaviour |

Enhancements are not in the list; they stay in the report.
