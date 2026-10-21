# Figma verification — checklist

Detailed criteria for `../SKILL.md`. Each item names what to compare, the evidence source, and the
default severity (`BLOCKER` / `MAJOR` / `MINOR`). Use the target repository's conventions
(`CONVENTIONS.md` §13 and the repository's own `CONVENTIONS.md`) for the *how*.

---

## 1. Text and structure

Evidence: `get_metadata` (frame tree, text nodes, order) vs the rendered JSX in the changed files.

- Every section, element and text node in the frame exists in the implementation, in the same order.
- Static copy matches the frame; CMS-driven copy is bound to the right field (not hard-coded).
- Hierarchy matches: heading levels follow the page context; lists are lists.
- Nothing extra renders that the design does not show (and the ticket does not require).

Missing section, wrong/truncated copy, reordered content → `BLOCKER`.

## 2. Token fidelity

Evidence: `get_variable_defs` vs the utilities in `variants.ts` / component files, resolved through
`packages/ui/src/styles/tokens/*.css`.

- For each value the frame binds to a variable, the code uses the utility that resolves to **the same
  token**: colour (semantic `bg-surface-*`, `text-text-*`, `border-border-*`), spacing (`p-*`, `gap-*`),
  radius, type (`type-*` composite).
- Semantic tier, not palette, where a semantic role exists; never primitives.
- No hex/rgb/hsl literals, no arbitrary values, no inline style design values (run the `VERIFY.md`
  §4.1 scans over the changed files and record the counts).
- A design value with no token is reported as a `TODO(dco-design)` gap, not silently approximated.

`spacing/lg` implemented as `p-md` → `MAJOR`. Hex or `bg-[#…]` → `BLOCKER`. Semantic role skipped for
a palette name → `MAJOR`.

## 3. Variants and states

Evidence: component-set properties (`get_metadata`) and state frames vs `variants.ts`, `type.ts`,
stories and tests.

- Every author-decided variant exists as a `cva` variant / prop, and has a story.
- Interactive states (hover via `hover-supported:hover:`, `focus-visible`, active, disabled) are
  implemented as CSS states/attributes, not props.
- States the ticket requires (loading, empty, error, long content) exist even where the frames omit them.
- File naming is judged by the repository's convention (this target: `ui.stories.tsx`), not a fixed
  external rule.

Missing variant or required state → `BLOCKER`. Missing story for an existing variant → `MAJOR`.
Bare `hover:` or `hover-supported:` without `hover:` → `MAJOR`.

## 4. Responsiveness

Evidence: frames per artboard (mobile 390, tablet 768, desktop 1536) vs responsive utilities.

- Layout changes happen at named breakpoints only (`sm`, `md`, `lg`, `xl`, `2xl`, `wide`), never
  one-off `min-[…]:`/raw media queries.
- Each artboard's layout is reproduced (stacking, column counts, visibility, carousel vs grid).
- Behaviour between artboards is sensible at every breakpoint (tier 2: check the Storybook viewport
  toolbar at each).
- Type scales with the fluid `type-*` styles, not per-breakpoint sizes.

Artboard layout not reproduced → `MAJOR`. One-off breakpoint → `MAJOR`.

## 5. RTL and localisation

Evidence: Arabic frames (if supplied) vs logical utilities and stories.

- Logical utilities only (`ps/pe`, `ms/me`, `start/end`, `text-start`); no `pl-`/`pr-`/`left-`/`right-`
  for direction-dependent spacing.
- Direction-aware icons and motion mirror; carousels/progress follow reading direction.
- Copy is not hard-coded in one language; an Arabic story and an Arabic test exist.

LTR-only layout → `MAJOR`. Missing Arabic story/test → `MAJOR`.

## 6. Accessibility

- Semantic elements chosen by behaviour; buttons have `type="button"`; links navigate.
- Keyboard reachability and operation; visible focus; Escape/focus management for overlays.
- Accessible names for icon-only controls; `alt` from CMS fields; decorative glyphs hidden.
- Contrast-safe token pairs as designed.

Unreachable or unnamed interactive element → `BLOCKER`. Missing visible focus → `MAJOR`.

## 7. Acceptance-criteria coverage

Evidence: ticket text vs the code and the tests.

- Each criterion maps to code **and a named test** that proves it. Plausible implementation without a
  test is **not covered**.
- Criteria in conflict with the design are listed as `CONFLICT`, with both accounts.

Uncovered criterion → `BLOCKER`.

## 8. Component conventions and build requirements

Read each changed component against `CONVENTIONS.md` §3–§12 and the target's own rules:

| Check | Default severity |
| :-- | :-- |
| Fixed file set present for new components (`index.tsx`, `type.ts`, `variants.ts`, `index.test.tsx`, `ui.stories.tsx`) | `MAJOR` |
| Placement: presentational in `packages/ui`; CMS mapping in the app wrapper; layer direction respected | `MAJOR` |
| Reuse: a small reusable element built inline in a block, or a new atom duplicating an existing one | `MAJOR` |
| AEM attributes on every authorable element via the block's `aem.ts` / `getAemDataAttributes` with CMS field names | `MAJOR` |
| Test ids: `testId` prop on operable components, on the driven element, parts via `testIdPart`, **no default**, none on decorative atoms | `MAJOR` |
| Analytics present only if the ticket asks; specified analytics present and tested | `MAJOR` |
| CMS/user HTML sanitised through `atoms/rte-renderer`; no secret or non-public `process.env` in client/shared code | `BLOCKER` |
| Other unsafe patterns (`target="_blank"` without `rel`, unvalidated URL into `href`) | `MAJOR` |
| `"use client"` in a file with no state/effect/handler/ref/browser API, or on a whole block/page/wrapper | `MAJOR` |
| Raw `<img>` instead of `atoms/responsive-picture`; heavy/below-the-fold asset eager | `MINOR` |
| Section surface (blocks): transparent root unless covering the section; no tone assumption; wrapper marks | `MAJOR` |
| Storybook-only fixtures/mocks imported by product code | `MAJOR` |

## 9. Claims audit

Compare the implementer's report — visual self-comparison, AC coverage, build-requirement statements,
verification table — with what you found. Each contradicted claim is a finding (severity of the
underlying defect), quoted verbatim. A `PASSED` claimed without evidence is reported as
`NOT_VERIFIED` in your audit, not accepted.

## 10. Tier 2 — rendered parity procedure

1. Probe for browser tooling the runtime provides. If none responds → tier 2 `SKIPPED`.
2. Start Storybook from the target root in the background: `pnpm storybook` (serves on 6006). Wait
   for it to respond. If it fails to start → `SKIPPED` with the error.
3. Find each component's story `title` in its `ui.stories.tsx`; the URL is
   `http://localhost:6006/?path=/story/<title-kebab>--<story-kebab>` (or the iframe form
   `iframe.html?id=<title-kebab>--<story-kebab>`).
4. Screenshot each relevant state at mobile 390, tablet 768 and desktop 1536 widths, in LTR and (if in
   scope) RTL via the locale toolbar.
5. Compare with the frame's `get_screenshot`: name deviations by kind — spacing, size, weight, radius,
   alignment, colour, missing/extra element — or state there are none. Fonts and antialiasing differ;
   never pixel-diff.
6. Close the tabs and stop the Storybook process you started. Save screenshots to the reports directory.

## 11. Findings format

```
| # | severity | where           | expected                                   | actual          | recommendation                     |
| 1 | BLOCKER  | index.tsx:41    | `loading` state (AC-3)                      | absent          | add variant, story and test        |
| 2 | MAJOR    | variants.ts:12  | spacing/lg → `p-lg` (Figma var, node 12:34) | `p-md`          | use `p-lg`                         |
| 3 | MINOR    | ui.stories.tsx  | radius-lg per frame                         | radius-md       | visible at 2× only                 |
```

Compact on purpose: findings are read by the Orchestrator, the Frontend Engineer and the final report.
