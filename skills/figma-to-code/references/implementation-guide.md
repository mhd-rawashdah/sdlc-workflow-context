# Figma to code — implementation guide

Detailed guidance for `../SKILL.md` steps 3–5. Rules are from `CONVENTIONS.md`; the specifics are
the target repository's (`CONVENTIONS.md` §13, measured from `dgcl-dgs-dc-xt`). **Re-read the
repository's own `CONVENTIONS.md` and the layer README before relying on any specific below** — the
repository wins where it has moved on.

---

## 1. Inventory search

```bash
cd "$TARGET_REPO"
find packages/ui/src/components -name index.tsx | sort            # whole inventory, nested families included
grep -rl "<Keyword>" packages/ui/src/components --include=index.tsx # by behaviour or name
ls packages/types/src/blocks                                       # CMS models that already exist
ls apps/dco/src/components/blocks                                  # existing wrappers
```

Read the candidates, not just their names. For each design element record one of:

| Decision | When | What you write |
| :-- | :-- | :-- |
| Reuse as-is | Existing component renders it from props/tokens | Nothing in the component |
| Add a variant/prop | Structure or behaviour genuinely differs | A named `cva` variant (additive), its story, its test |
| Create new | Nothing serves, after the search | A new folder from `atoms/placeholder/` |

A design element that nearly matches an existing atom is a variant, never a sibling copy.

## 2. Placement

| Element | Goes to |
| :-- | :-- |
| An authorable page section (one AEM content-fragment model) | `packages/ui/src/components/blocks/<name>/` + app wrapper `apps/dco/src/components/blocks/<name>-wrapper/` |
| A grouping reused by ≥ 2 blocks, no AEM types | `composites/` (one consumer → keep it inside the block folder) |
| An indivisible primitive (button, tag, badge, label, icon button) | `atoms/` |
| Pure positioning: spacing, grid, background | `layouts/` |
| A whole page assembly | `templates/` (app-level templates in `apps/dco/src/components/templates/`) |

Two answers fit → choose the lower layer. Dependency direction is down only; `hooks/`, `lib/`,
`constants/`, `mocks/` never import `components/` (lint-enforced).

## 3. Token mapping

1. For each Figma value, read the bound variable from `get_variable_defs`.
2. Find the semantic utility that resolves to it: colours in `packages/ui/src/styles/tokens/semantic.css`
   (`bg-surface-*`, `text-text-*`, `border-border-*`, `text-icon-*`), spacing (`p-lg`, `gap-md` from
   `spacing.css`), radius (`rounded-*` from `radius.css`), type (`type-*` composite utilities from
   `typography.css`).
3. Prefer the semantic role over a palette name; never use primitives (`--dco-*`).
4. A Figma value with no bound variable, or a variable with no repository counterpart: do **not**
   approximate silently. Use the nearest token only if the design team has accepted it; otherwise
   leave `TODO(dco-design): <what is missing, Figma node>` and report it.
5. Brand accent that follows the page: `brand-accent` utilities. Hover/focus tints on blocks that sit
   on either surface tone: `--section-surface-hover` with the design value as fallback.

Forbidden in components: hex/rgb/hsl literals, `style={{…}}` for design values, CSS modules,
arbitrary values (`text-[13px]`, `gap-[54px]`, `bg-[#…]`), one-off breakpoints (`min-[900px]:`).

## 4. File set and shape

Copy `packages/ui/src/components/atoms/placeholder/` and fill in all five files:

| File | Content |
| :-- | :-- |
| `variants.ts` | `cva` base + variants + compound variants + defaults. Every class name lives here — none in the component body. Tokens only. |
| `type.ts` | Props derived from `VariantProps<typeof xVariants>`; omit variants the component derives itself; discriminated unions for exclusive modes; `/** */` docs (Storybook reads them); `className?`; `testId?` when operable. |
| `index.tsx` | Named export matching the folder; element chosen by behaviour; `cn(variants(…), className)` last; `data-testid={testId}` before any prop spread. |
| `index.test.tsx` | Behavioural tests (§9). |
| `ui.stories.tsx` | Every state, both locales, long text (§10). |
| `README.md` | Only for something the props cannot tell a reader. |

Sub-parts of a complex block live beside `index.tsx` as kebab-case files (see
`blocks/feature-card-listing/`: `listing-card.tsx`, `listing-carousel.tsx`, `listing-header.tsx`,
`media.tsx`, `utils.ts`, `aem.ts`, `fixtures.ts`).

Import by full path: `import { Button } from '@workspace/ui/components/atoms/button'`. Do not add
`exports` entries to `packages/ui/package.json`.

## 5. Variants and interactive states

- Every variant in the Figma component set that an **author or caller decides** becomes a `cva`
  variant and a prop.
- These are **not** props: viewport (responsive utilities, fluid `type-*`), language (`dir` + logical
  utilities), hover/focus (`hover-supported:hover:`, `focus-visible:`), disabled (`disabled` attribute).
- `hover-supported:` alone is a media query that applies permanently on desktop — always
  `hover-supported:hover:…`.
- Focus is always visible; use the repository's focus utilities (`focus-dark` etc.) as siblings do.
- Implement every state the ticket requires (loading, empty, error, long content) even where the
  frames omit it, following sibling precedent, and record it as a design gap.

## 6. Responsive

- Named breakpoints only: `xs 384 · sm 640 · md 768 · lg 992 · xl 1280 · 2xl 1536 · wide 1680`
  (generated; JS reads `BREAKPOINT` from `@workspace/ui/constants/breakpoints`).
- Artboards (390 / 768 / 1536) are where designs were drawn; the component must hold at **every**
  breakpoint in between. Use `useIsWithinBreakpoint` / `useMediaQuery` hooks only when behaviour (not
  just layout) changes.
- Prefer layout components and grid/flex with `gap-*` over ad-hoc padding.

## 7. RTL and localisation

- Logical utilities: `ps-*`/`pe-*`, `ms-*`/`me-*`, `start-*`/`end-*`, `text-start`; mirror
  direction-aware icons; carousels and progress run in reading direction.
- Never branch on locale for fonts — `--font-dco-primary` resolves per `[dir='rtl']`.
- Copy comes from CMS fields or `uiCopy(locale)` / `useTranslations`; no hard-coded English.
- Pass `locale` down the way siblings do (blocks take `locale?: string`).

## 8. Accessibility

- `<button type="button">` for actions, `<a>` for navigation, real form controls with labels.
- Keyboard: every interactive element reachable and operable; Escape closes overlays
  (`use-escape-key`); focus moves into dialogs and returns on close.
- Names: icon-only controls get accessible names; decorative glyphs `aria-hidden="true"`.
- Images: `alt` from the CMS field; `alt=""` when decorative.
- Headings: correct level for the page context; `aria-labelledby` from a `useId()` title as
  `feature-card-listing` does.
- Respect reduced motion (`use-reduced-motion`).

## 9. Tests

`packages/ui` tests render with `@workspace/ui/test-utils` and `@testing-library/user-event`.

- Assert on roles and visible text; assert a class only where a variant has no behaviour, with a
  comment saying so.
- One named test per acceptance criterion (name it after the criterion).
- States: default, empty/`return null`, long content, each variant, disabled/error/loading as relevant.
- Keyboard operation for interactive components; an **Arabic** case.
- `testId` wiring both ways: lands on the driven element; nothing rendered when omitted.
- App wrappers: test the mapping (`utils.test.ts`) and the section marks with `readSectionMarks`
  for a fragment that renders and one that does not; add the model to
  `apps/dco/src/lib/page-theme/section-block.test.ts`.
- Analytics (only if specified): assert the exact event payload.

## 10. Stories

- `title` by layer: `Atoms/<Name>`, `Composites/<Name>`, `Blocks/<Name>`.
- One story per meaningful state and variant; `Arabic`; `LongLabel`/long content; missing image.
- Render from fixtures (`fixtures.ts` beside the block) — no network, and **never import fixtures or
  mocks from product code**.
- Blocks: check both surface tones by wrapping in `<SectionSurface tone="dark">`, and add a row to the
  `Layouts/SectionSurface` page-sequence story.
- Check the viewport toolbar at every breakpoint and the Accessibility panel.

## 11. Build requirements

| Requirement | Target implementation |
| :-- | :-- |
| Test ids | `testId?: string` prop; `data-testid={testId}` on the element automation drives; parts via `testIdPart(testId, 'cta')`; **no default value**, nothing rendered when absent; no `testId` on decorative atoms; list supported suffixes in the `testId` doc comment |
| AEM attributes | Blocks own an `aem.ts` (copy `blocks/feature-card-listing/aem.ts`): a `FIELDS` map of `{ type, prop, label }` keyed by the content-fragment field names and `aemAttributes(field, path, editMode)` over `getAemDataAttributes`, gated by `componentName` (add it to `AllowedComponent` when new). Spread onto every authorable element; atoms receiving plain strings stay AEM-agnostic |
| Analytics | Only as the ticket specifies, through `@workspace/analytics`, with a test. Otherwise none, flagged |
| Security | Rich text through `atoms/rte-renderer`; links checked with `isSafeAbsoluteLink`/`resolve-link` helpers; `target="_blank"` with `rel="noopener noreferrer"`; no `process.env` in `packages/ui` except the existing public getters in `lib/utils.ts` |
| Performance | Images via `atoms/responsive-picture`; below-the-fold media and heavy widgets lazy (`next/dynamic`, `loading="lazy"`); no reflex memoisation; named imports only |
| Client boundary | Server by default; `'use client'` only in the file needing state/effects/handlers/refs/browser APIs; split interactive parts (`listing-carousel.tsx`) and keep the block on the server; app wrappers never client |
| Section surface (blocks) | Transparent root unless covering the section; never assume tone; `withSectionMarks` on the wrapper with `ownBackground` / `empty` using the block's own emptiness helper |

## 12. Before reporting

```bash
cd "$TARGET_REPO"
pnpm --filter @workspace/ui check-types && pnpm --filter @workspace/ui lint && pnpm --filter @workspace/ui test
pnpm --filter dco check-types && pnpm --filter dco lint && pnpm --filter dco test     # when the app changed
ALLOW_BUILD_WITHOUT_AEM=true pnpm build:dco                                           # only if the environment permits; else NOT_VERIFIED
```

Then the `VERIFY.md` §4.1 scans, `git status --porcelain`, and the visual self-comparison against each
`get_screenshot`. Report exactly what ran (`VERIFY.md` §7).
