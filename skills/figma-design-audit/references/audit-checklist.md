# Figma design audit — checklist

Detailed criteria for the ten areas in `../SKILL.md`. Each area lists what to inspect, the evidence
source, and the default severity. Raise or lower a default only with a stated reason.

Judge against the **target repository's** vocabulary and inventory (gathered in step 1), not against
generic best practice.

---

## 1. Design variables and tokens

Evidence: `get_variable_defs` per audited node; `get_metadata` for fills/strokes/text styles.

- Colours are **bound variables**, not raw fills per layer. Count bound vs raw per frame.
- Spacing (padding, gap) uses a spacing scale as variables, not ad-hoc pixel values.
- Type uses **text styles / typography variables**, not per-layer overrides of size, weight or
  line-height.
- Radius, border width, opacity and shadow use variables where the repository tokenises them.
- Variable names map onto the repository's tiers (this target: primitives → palette → semantic
  `surface/*`, `text/*`, `icon/*`, `border/*`). A design bound only to primitives (brand ramp names)
  forces guessing which semantic role was meant.
- Every bound variable exists in the repository's generated tokens. A variable with no counterpart is
  a missing token (design handover needed, `design/tokens/README.md` "When design ships new tokens").
- Modes/collections that imply theming (light/dark, locale, artboard) are identified.

Severity: **HIGH** if colours or typography are not variables at all — implementation would hard-code
values, which the conventions forbid. **MEDIUM** for spacing/radius not tokenised, or variables with
no repository counterpart. **LOW** for isolated raw values.

## 2. Component organisation and reuse

Evidence: component/component-set listing; `get_metadata` instance and main-component references.

- Repeated elements are **components or component sets**, not copy-pasted groups or detached
  instances. Count detached instances.
- Instances reference the library's main components, not local copies.
- Each design component maps to an existing repository component (search the inventory recursively)
  or is clearly new. A design whose components already exist in the repository is a **reuse/variant**
  job — say so; it changes the implementation plan more than anything else in the report.
- New design components are plausibly atoms/composites/blocks (`CONVENTIONS.md` §3); a "block"
  containing an unextracted reusable element (badge, tag, icon button) is flagged.

Severity: **HIGH** if primary UI elements are not components (every instance would diverge in code);
**MEDIUM** for detached instances of library components; **LOW** for minor duplication.

## 3. Variants and states

Evidence: component-set properties via `get_metadata`; frames per state.

- Component sets express variants and states as properties: default, hover, focus, active, pressed,
  disabled, selected, loading, error, empty — as applicable to the element.
- States the ticket's acceptance criteria require are present (loading, empty, error, long content,
  validation messages).
- Variant axes are code-mappable. Per the target's conventions, **viewport, language, hover/focus and
  disabled are not props** — they are responsive utilities, `dir`, CSS states and attributes. Flag
  axes that would only make sense as props if they encode one of those.
- Focus states exist and are visible (accessibility).

Severity: **HIGH** when a state an acceptance criterion requires is missing (code would invent it);
**MEDIUM** for missing interaction states (hover/focus/disabled); **LOW** for naming of axes.

## 4. Auto-layout and constraints

Evidence: `get_metadata` layout mode, sizing (hug/fill/fixed), constraints, gaps.

- Frames and components use **auto-layout** with sensible hug/fill resizing.
- Constraints make the intent at other widths inferable (pinned vs scaling).
- Gaps and padding are consistent and tokenised (ties to area 1).
- Absolute positioning is limited to genuine overlays/decoration.

Severity: **HIGH** if key page frames or components are absolutely positioned — responsive behaviour
would be guessed and fidelity cannot be verified. **MEDIUM** for mixed fixed widths inside fluid
containers. **LOW** otherwise.

## 5. Responsiveness

Evidence: frames per artboard; `get_metadata` widths; screenshots for comparison.

- Designs exist for the repository's artboards (this target: mobile 390, tablet 768, desktop 1536),
  or the ticket explicitly limits scope.
- Behaviour **between** artboards is inferable at the repository's breakpoints (xs 384, sm 640, md 768,
  lg 992, xl 1280, 2xl 1536, wide 1680): what reflows, what stacks, what hides, how carousels behave.
- Type scales come from the fluid type styles, not per-artboard ad-hoc sizes.
- Touch targets on mobile are adequately sized.

Severity: **HIGH** if a required artboard is missing for a layout-changing component; **MEDIUM** if
breakpoint behaviour must be guessed; **LOW** for minor inconsistencies.

## 6. Page and layer hierarchy

Evidence: `get_metadata` page/frame tree.

- Pages are organised (foundations / components / screens), not one dumping ground.
- Nesting is meaningful and maps to atoms → composites → blocks.
- No stale duplicate screens without an indication of which is current; versions are labelled.
- Annotations/specs live beside the frames they describe.

Severity: **MEDIUM** when the current version of a screen cannot be identified; **LOW** otherwise.

## 7. Naming quality

Evidence: node names from `get_metadata`.

- No default names (`Frame 427`, `Group 12`, `Rectangle 3`) on meaningful layers. Count them.
- Layers are named by **role** (`cta-primary`, `card-title`), not appearance (`blue text bold`).
- Sections trace to block names; components to repository component names (kebab-case-able).
- Text styles carry names that match the repository's typography tokens (this target: `headline-1`,
  `body-01-regular`, `tags-02-regular` …).

Severity: **MEDIUM** when components or sections cannot be mapped by name; **LOW** for stray default
names on decorative layers.

## 8. RTL and locale requirements

Evidence: Arabic/RTL frames or variants; text content; `get_variable_defs` typography modes.

- For bilingual repositories (this target: English + Arabic), Arabic variants exist for every
  component and screen in scope, or the ticket states RTL is out of scope.
- Directional properties are mirrored (padding, alignment, icon direction, carousel direction,
  progress direction), not left-biased.
- Arabic and English type ramps are distinguished (this target resolves the family per direction; the
  design must show the Arabic ramp's sizes/line-heights).
- Long-string behaviour is shown for both languages (Arabic and English lengths differ).
- Numerals, dates and currency formats are specified where shown.

Severity: **HIGH** when the repository is bilingual and Arabic/RTL is absent for in-scope components;
**MEDIUM** for partial mirroring; **LOW** for minor gaps.

## 9. Missing design specifications

Evidence: all of the above against the ticket.

- Every acceptance criterion with a visible outcome has a design.
- Content rules are specified: max lengths, truncation/line clamp, empty/missing image behaviour.
- Interaction specs: what changes on hover/press, transitions and durations (or "none"), focus order,
  dismiss behaviour for overlays, carousel controls.
- Accessibility specs where design decides them: contrast-safe colour pairs, focus ring, alt-text
  source for images.
- Assets: icons available as components/vectors; image aspect ratios and crops.
- Analytics: only if the ticket specifies it — the design is not the source of analytics requirements.

Severity: **HIGH** for a missing spec that an acceptance criterion depends on; **MEDIUM** for
interaction/content rules left to guesswork; **LOW** for nice-to-have detail.

## 10. Design-to-code ambiguity

- Places where two reasonable implementations differ visibly (e.g. grid vs carousel at tablet).
- Conflicts between the design and the ticket (a state the ticket requires that the design omits, or
  contradicts).
- Conflicts between frames (different spacing for the same component on two screens).
- Design values that contradict existing repository components (the component exists with different
  padding) — reuse vs change is a decision.
- Unclear CMS mapping: which elements are authorable fields.

Severity: **HIGH** for a direct contradiction between ticket and design; **MEDIUM** for ambiguities
that change structure; **LOW** for cosmetic ones. Every item also appears under open questions.

---

## Report hygiene

- Quote counts ("43 of 51 frames use raw fills"), node ids and page names — not impressions.
- Every finding: area, severity, node, evidence, consequence in code terms, specific correction.
- "What is already good" is genuine and specific: this is a collaborative report for designers.
- Recommended sequence: fixes ordered by leverage (variables first, then components, then states).
