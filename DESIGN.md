---
version: 0.2.0
name: Kilo Cloud
description: Dark-first, utilitarian developer surface for Kilo Code. Near-black layered surfaces and low-alpha white borders carry hierarchy. Kilo yellow-green is both brand and primary action color. Blue is reserved for links and the Cloud status domain.
color:
  brand:
    primary: '#F7F586'
    primaryHover: '#E6E475'
    primaryRing: '#F7F58659'
    foreground: '#1F1F1F'

  status:
    blue300: '#93C5FD'
    blue400: '#60A5FA'
    blue500: '#3B82F6'
    blue600: '#2563EB'
    purple300: '#D8B4FE'
    purple400: '#C084FC'
    purple500: '#A855F7'
    purple600: '#9333EA'
    teal300: '#4CE7D7'
    teal400: '#00D4C2'
    teal500: '#00BAA9'
    teal600: '#009689'
    gray300: '#D4D4D8'
    gray400: '#A1A1AA'
    gray500: '#71717A'
    gray600: '#52525B'
    orange300: '#FDBA74'
    orange400: '#FB923C'
    orange500: '#F97316'
    orange600: '#EA580C'
    green300: '#86EFAC'
    green400: '#4ADE80'
    green500: '#22C55E'
    green600: '#16A34A'
    yellow300: '#FDD94A'
    yellow400: '#FBC51C'
    yellow500: '#F0A900'
    yellow600: '#D28100'
    red300: '#FCA5A5'
    red400: '#F87171'
    red500: '#EF4444'
    red600: '#DC2626'

  surface:
    inset: '#101010'
    background: '#151515'
    raised: '#202020'
    overlay: '#333333'
    hover: '#3A3A3A'
    selected: '#454545'

  foreground:
    default: '#FAFAFA'
    muted: '#A3A3A3'
    subtle: '#7A7A7A'
    onSecondary: '#FAFAFA'
    onDestructive: '#FFFFFF'

  border:
    default: '#FFFFFF1A'
    strong: '#FFFFFF2E'
    inputBg: '#FFFFFF0A'

  syntax:
    plain: '#E8E8E8'
    comment: '#7A7A7A'
    keyword: '#FF9AE2'
    string: '#ECF58C'
    number: '#F2B36B'
    function: '#93E9F6'
    type: '#00CEB9'
    property: '#9CDCFE'
    constant: '#C792EA'
    operator: '#A3A3A3'

  diff:
    addText: '#9BCD97'
    addSurface: '#1A2919'
    deleteText: '#FC533A'
    deleteSurface: '#42120B'

statusDomain:
  cloud: blue
  vscode: purple
  cli: gray
  slack: teal
  agentManager: orange
  success: green
  warning: yellow
  destructive: red

typography:
  title:
    fontFamily: Inter
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '-0.015em'
  heading:
    fontFamily: Inter
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.01em'
  bodyLg:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
  eyebrow:
    fontFamily: Inter
    fontSize: 0.6875rem
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: '0.08em'
    textTransform: uppercase
  code:
    fontFamily: Roboto Mono
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5

radius:
  none: '0'
  sm: 4px
  md: 8px
  lg: 10px
  xl: 14px
  full: 9999px

spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  '5': 20px
  '6': 24px
  '8': 32px
  '10': 40px
  '12': 48px
  '0_5': 2px
  '1_5': 6px

components:
  buttonPrimary:
    backgroundColor: '{color.brand.primary}'
    textColor: '{color.brand.foreground}'
    typography: '{typography.label}'
    radius: '{radius.md}'
    height: 36px
    padding: '0 14px'
  buttonPrimaryHover:
    backgroundColor: '{color.brand.primaryHover}'
  buttonPrimaryFocus:
    ringColor: '{color.brand.primaryRing}'

  buttonSecondary:
    backgroundColor: '{color.surface.overlay}'
    textColor: '{color.foreground.onSecondary}'
    borderColor: '{color.border.default}'
    typography: '{typography.label}'
    radius: '{radius.md}'
    height: 36px
    padding: '0 14px'
  buttonSecondaryHover:
    backgroundColor: '{color.surface.hover}'

  buttonGhost:
    backgroundColor: transparent
    textColor: '{color.foreground.default}'
    typography: '{typography.label}'
    radius: '{radius.md}'
    height: 36px
    padding: '0 8px'
  buttonGhostHover:
    backgroundColor: '{color.surface.hover}'

  buttonDestructive:
    backgroundColor: '{color.status.red500}'
    textColor: '{color.foreground.onDestructive}'
    typography: '{typography.label}'
    radius: '{radius.md}'
    height: 36px
    padding: '0 14px'
  buttonDestructiveHover:
    backgroundColor: '{color.status.red600}'

  card:
    backgroundColor: '{color.surface.raised}'
    borderColor: '{color.border.default}'
    radius: '{radius.xl}'
    padding: 24px

  input:
    backgroundColor: '{color.border.inputBg}'
    textColor: '{color.foreground.default}'
    borderColor: '{color.border.strong}'
    radius: '{radius.md}'
    height: 36px
    padding: '0 12px'

  badgeStatus:
    typography: '{typography.label}'
    radius: '{radius.full}'
    padding: '2px 8px'

  badgeBrand:
    backgroundColor: '{color.brand.primary}'
    textColor: '{color.brand.foreground}'
    typography: '{typography.label}'
    radius: '{radius.full}'
    padding: '2px 8px'

  sidebar:
    backgroundColor: '{color.surface.raised}'
    textColor: '{color.foreground.muted}'
    width: 256px
    padding: '12px 8px'

  topbar:
    backgroundColor: '{color.surface.background}'
    textColor: '{color.foreground.default}'
    borderColor: '{color.border.default}'
    height: 56px
    padding: '0 16px'

  popover:
    backgroundColor: '{color.surface.overlay}'
    textColor: '{color.foreground.default}'
    radius: '{radius.lg}'
    padding: 12px

  dialog:
    backgroundColor: '{color.surface.raised}'
    textColor: '{color.foreground.default}'
    radius: '{radius.xl}'
    padding: 24px

  terminal:
    backgroundColor: '{color.surface.inset}'
    textColor: '{color.syntax.plain}'
    typography: '{typography.code}'
    radius: '{radius.lg}'
    padding: 16px
---

## Overview

**Trustworthy infrastructure tool, not a generic SaaS dashboard.** Kilo Cloud is the developer-facing product around Kilo Code. It manages organizations, usage and billing, agent sessions, and developer operations. Product UI is dark-first, compact, and utilitarian: dense tables, calm chrome, low ornamentation, and concrete language.

The cloud-agent surface may use terminal typography, syntax color, a restrained brand focus glow, and inset surfaces. Elsewhere, utility takes precedence over decoration.

**Three rules ground every screen.**

1. **Build depth with the surface ladder.** Use `surface.background` for the app canvas, `surface.raised` for cards and shell chrome, `surface.overlay` for floating UI, and `surface.inset` for terminal or recessed regions. Use `surface.hover` and `surface.selected` only for interaction states.
2. **Use low-alpha white borders.** `border.default` is standard chrome; `border.strong` distinguishes inputs and emphasized boundaries. Do not introduce solid gray borders.
3. **Yellow acts; neutrals carry everything else.** `brand.primary` is both brand and primary action color. Use one primary action per surface. Blue is for inline links and the Cloud status domain, not button backgrounds.

## Color

### Surfaces

The six surface tokens have fixed roles:

| Token | Value | Role |
|---|---|---|
| `surface.inset` | `#101010` | Terminal, code, and recessed regions |
| `surface.background` | `#151515` | App canvas |
| `surface.raised` | `#202020` | Cards, sidebar, dialogs, persistent chrome |
| `surface.overlay` | `#333333` | Popovers, dropdowns, tooltips |
| `surface.hover` | `#3A3A3A` | Pointer and ghost-control hover |
| `surface.selected` | `#454545` | Selected rows, active neutral controls |

Stack surfaces by role. Do not substitute arbitrary grays, gradients, or per-component surface colors. Floating UI may use a restrained shadow, but normal hierarchy comes from surface changes and borders.

### Foreground and borders

- `foreground.default` is default text.
- `foreground.muted` is secondary copy and metadata.
- `foreground.subtle` is tertiary or disabled copy. Confirm contrast before using it for essential information.
- `foreground.onSecondary` is text on neutral action surfaces.
- `foreground.onDestructive` is text on destructive fills.
- `border.default` is the standard 10%-white boundary.
- `border.strong` is the 18%-white emphasized boundary.
- `border.inputBg` is a recessed input fill, not a border color.

Never use color alone to communicate state. Pair status color with labels, icons, or other visible structure.

### Brand and actions

`brand.primary` (`#F7F586`) is scarce and load-bearing. Reserve it for the logo, one primary CTA per surface, and deliberate brand moments. Use `brand.foreground` (`#1F1F1F`) on primary fills. Hover darkens to `brand.primaryHover` (`#E6E475`). Keyboard focus uses `brand.primaryRing` (`#F7F58659`) or the semantic focus-ring token supplied by the implementation.

Secondary actions use neutral surfaces and `foreground.onSecondary`. Ghost actions have no fill at rest and use `surface.hover` on hover. Destructive actions use red only when semantics are destructive; prefer reversible undo flows over confirmation dialogs when possible.

### Status domains

Status colors are assigned by domain, never by mood:

| Domain | Family |
|---|---|
| Cloud | Blue |
| VS Code | Purple |
| CLI | Gray |
| Slack | Teal |
| Agent Manager | Orange |
| Success | Green |
| Warning | Yellow |
| Destructive | Red |

Use the 500 step as the base swatch, 400 for dark-surface foreground emphasis, 300 for lighter emphasis, and 600 for darker interaction or high-emphasis states. Status badges may compose a low-alpha 500 background and border with 400 text. Preserve a non-color cue and verify contrast in context.

Do not invent status hues or substitute `emerald` for teal or `zinc` for gray. Blue remains acceptable for inline links, but not primary action fills.

### Syntax and diffs

Use syntax tokens only in code, terminal, and editor-like surfaces:

- `syntax.plain` for unclassified source text.
- `syntax.comment` for comments and de-emphasized code.
- `syntax.keyword`, `syntax.string`, `syntax.number`, `syntax.function`, `syntax.type`, `syntax.property`, `syntax.constant`, and `syntax.operator` for their matching grammar scopes.

Diffs use `diff.addText` on `diff.addSurface` and `diff.deleteText` on `diff.deleteSurface`. Always retain `+`/`-` markers or equivalent structure so additions and deletions do not depend on color alone.

## Typography

Use Inter for UI and Roboto Mono for code, identifiers, terminal output, timestamps, and dense numerical data. Do not introduce another family. JetBrains Mono may remain on existing editor-specific surfaces, but it is not part of this token contract.

The product scale is intentionally compact:

- `title`: page titles, `24px / 600 / 1.2`.
- `heading`: section and card headings, `18px / 600 / 1.25`.
- `bodyLg`: lead or emphasized prose, `16px / 400 / 1.5`.
- `body`: default product copy, `14px / 400 / 1.5`.
- `label`: controls, compact metadata, and badges, `12px / 500 / 1.4`.
- `eyebrow`: short uppercase category labels, `11px / 500 / 1.2`, with `0.08em` tracking.
- `code`: code and terminal text, `14px / 400 / 1.5`.

Use sentence case for user-visible copy. Eyebrows are the exception because the token explicitly transforms them to uppercase. Use `tabular-nums` for values aligned in columns. Do not use monospace as prose emphasis.

## Layout and spacing

Use the supplied 4px-based spacing ladder. `spacing.2`, `spacing.3`, `spacing.4`, and `spacing.6` cover most product layout. `spacing.8`, `spacing.10`, and `spacing.12` create section separation. `spacing.0_5` and `spacing.1_5` are for tight optical adjustments and compact component internals, not general page layout.

- Topbar height is `56px`; use `border.default` along its lower edge.
- Expanded sidebar width is `256px`; use the existing sidebar primitive for responsive collapse.
- Default page padding and card padding are `24px`.
- Default controls are `36px` tall; small and large variants may use `32px` and `40px`.
- Table rows target `48px` in dense desktop UI.
- Prefer `gap` over ad hoc margins.
- Never nest cards. Use spacing, dividers, headings, or inset regions for internal grouping.

Product UI must reflow at narrow widths. Test around 375px, 768–1024px, and 1440px. Required actions cannot depend on hover. On touch surfaces, preserve at least a 44px target even when the visual control is compact.

## Shape

Use radius by role:

- `radius.none` for edge-to-edge or intentionally square regions.
- `radius.sm` (`4px`) for tight chips and compact inline elements.
- `radius.md` (`8px`) for buttons and inputs.
- `radius.lg` (`10px`) for popovers and medium containers.
- `radius.xl` (`14px`) for cards and dialogs.
- `radius.full` for badges, avatars, and status pills.

Do not introduce one-off radii. Follow existing shadcn primitives when their semantic radius already matches these roles.

## Components and interaction

**Buttons.** Primary uses `brand.primary` with `brand.foreground`, once per surface. Secondary uses `surface.overlay`, `foreground.onSecondary`, and `border.default`. Ghost uses no fill at rest and `surface.hover` on hover. Destructive uses `status.red500`, darkening to `status.red600`. Do not scale buttons on press.

**Cards.** Use `surface.raised`, `border.default`, `radius.xl`, and `24px` padding. Cards represent distinct content or interaction boundaries, not every grouping.

**Inputs.** Use `border.inputBg`, `border.strong`, `radius.md`, and visible labels. Focus must remain visible. Errors pair a red boundary or icon with explanatory text connected through `aria-describedby`.

**Status badges.** Use the fixed domain mapping, a full radius, and `typography.label`. Include text or an icon so meaning survives color-vision differences.

**Sidebar.** Use `surface.raised`, sidebar semantic tokens where available, and `foreground.muted` for inactive items. Active rows use `surface.selected`; hover uses `surface.hover`. Use the existing responsive sidebar or Sheet behavior instead of creating another mobile navigation tree.

**Topbar.** Use `surface.background`, `border.default`, and a 56px height. Keep primary page actions in page content rather than persistent chrome.

**Overlays.** Popovers and menus use `surface.overlay`; dialogs use `surface.raised`. Build them with existing Radix and shadcn primitives for focus trapping, keyboard navigation, dismissal, portals, and stacking.

**Terminal and code.** Use `surface.inset`, `typography.code`, and the syntax palette. Disable ligatures where exact glyph representation matters. Diff views use the dedicated diff tokens.

Every interactive component must account for default, hover, focus-visible, active, disabled, loading, error, and success states where relevant. Hover is supplementary. Focus indicators need at least 3:1 contrast against adjacent colors and must not be removed without a replacement.

## Motion

Product motion is short and functional. Use opacity and transform transitions around 100–200ms for direct feedback and 200–300ms for overlays or state changes. Reuse the established strong ease-out curve. Avoid bounce, elastic motion, and casual animation of layout properties.

Brand flourishes belong only in deliberate brand moments. Respect `prefers-reduced-motion`; preserve function while removing nonessential movement. Use existing Radix/shadcn transitions for dialogs, dropdowns, sheets, and tooltips.

## Voice

Kilo voice is clear, technical, calm, and direct. Use concrete verbs and specific nouns. Buttons use verb + object (`Save changes`, `Create workspace`, `Delete project`) rather than `Submit`, `OK`, or `Yes`. Error copy states what happened and what the user can do next. Do not use hype, jokes in errors, emoji in product chrome, or inconsistent terminology.

## Do and don't

**Do**

- Use semantic implementation tokens that map to this contract before raw hex values.
- Build hierarchy with the six-role surface ladder and low-alpha borders.
- Keep brand yellow-green scarce and reserve it for primary action and brand roles.
- Use fixed domain mappings for statuses.
- Use syntax and diff colors only on code-oriented surfaces.
- Use Inter for UI, Roboto Mono for code and aligned technical data.
- Preserve keyboard, screen-reader, reduced-motion, touch, and responsive behavior.

**Don't**

- Use pure black, gradients, or arbitrary surface grays.
- Put multiple yellow primary buttons on one surface.
- Use blue as a primary button background.
- Rename teal to emerald or gray to zinc in the token contract.
- Invent status colors, spacing values, radii, or typography roles.
- Nest cards or use shadows as the default source of depth.
- Depend on color, hover, placeholders, or icon shape alone to convey meaning.

## Mobile (Focus palette)

The mobile app (`apps/mobile/`) intentionally does not use this token contract. It ships its own light/dark palette ("Focus", FL/FD) defined as CSS variables in `apps/mobile/src/global.css`, tuned for WCAG AA contrast against its own warmer neutral surfaces. This divergence is deliberate — mobile is not expected to converge onto the tokens above.
