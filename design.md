---
version: alpha
name: Kilo Cloud
description: Dark-first, utilitarian developer surface for Kilo Code — the open-source AI coding agent. Near-black backgrounds, white-at-low-alpha borders. The Kilo yellow-green is the primary action color — it's the brand and the CTA at once. Blue is a legacy link/inline-accent role only.
colors:
  # Foundations — the near-black ladder
  background: '#121212'
  surface: '#2B2B2B'
  surface-raised: '#333333'
  muted: '#3D3D3D'

  # Foreground — the white ladder
  foreground: '#FAFAFA'
  foreground-muted: '#A3A3A3'
  foreground-subtle: '#7A7A7A'
  foreground-on-red: '#FFFFFF'

  # Borders — the most characteristic move (white at low alpha)
  border: '#FFFFFF1A' # 10% — default
  border-strong: '#FFFFFF2E' # 18% — inputs, focused chrome
  input-bg: '#FFFFFF0A'

  # Primary action — the Kilo yellow-green. Brand and CTA in one.
  primary: '#EDFF00'
  primary-hover: '#D6E600'
  primary-ring: '#EDFF0059' # 35% alpha brand glow
  on-primary: '#1F1F1F' # near-black for AA contrast on yellow

  # Secondary action — dark-gray, quiet, the workhorse against cards.
  secondary: '#3D3D3D'
  secondary-hover: '#4D4D4D'
  on-secondary: '#FAFAFA'

  # Brand accent — alias of primary. Same swatch, used in atmospheric roles
  # (logo tile, focus rings, text selection, agent glow, status lights).
  brand: '#EDFF00'
  brand-dim: '#B8C800'
  on-brand: '#1F1F1F'

  # Link / inline-accent blue — legacy role only. Never a button background.
  link: '#3B82F6'
  link-hover: '#60A5FA'

  # Status palette — every status follows the same translucent /20 pattern.
  # The 500-step is the swatch; consumers compose with /20 bg + /20 ring + 400 text.
  blue-500: '#3B82F6' # Cloud / neutral default / link role
  blue-400: '#60A5FA'
  purple-500: '#A855F7' # VS Code Extension
  purple-400: '#C084FC'
  emerald-500: '#10B981' # Slack
  emerald-400: '#34D399'
  zinc-500: '#71717A' # CLI
  zinc-400: '#A1A1AA'
  orange-500: '#F97316' # Agent Manager
  orange-400: '#FB923C'
  green-500: '#22C55E' # Success / "new"
  green-400: '#4ADE80'
  yellow-500: '#EAB308' # Warnings
  yellow-400: '#FACC15'
  red-500: '#EF4444' # Destructive
  red-400: '#F87171'

typography:
  display:
    fontFamily: Inter
    fontSize: 3rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.015em'
  h1:
    fontFamily: Inter
    fontSize: 1.875rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.015em'
  h2:
    fontFamily: Inter
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.015em'
  h3:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  body-strong:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.3
  eyebrow:
    fontFamily: Inter
    fontSize: 0.6875rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '0.06em'
  code:
    fontFamily: Roboto Mono
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
  terminal:
    fontFamily: Roboto Mono
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: '"calt", "ss01"'

rounded:
  none: 0
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  full: 9999px

spacing:
  '0-5': 2px
  '1': 4px
  '1-5': 6px
  '2': 8px
  '3': 12px
  '4': 16px
  '5': 20px
  '6': 24px
  '8': 32px
  '10': 40px
  '12': 48px

components:
  # Primary action — the yellow button. Brand and CTA in one. Earned, used once per surface.
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    typography: '{typography.body-strong}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 14px'
  button-primary-hover:
    backgroundColor: '{colors.primary-hover}'

  # Secondary — dark-gray with white text + 10%-white border. The workhorse.
  button-secondary:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.on-secondary}'
    typography: '{typography.body-strong}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 14px'
  button-secondary-hover:
    backgroundColor: '{colors.secondary-hover}'

  # Ghost — underlined white text, no chrome at rest. For inline links and table-row affordances.
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.foreground}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 4px'

  # Destructive — red, only inside dialogs and confirms.
  button-destructive:
    backgroundColor: '{colors.red-500}'
    textColor: '{colors.foreground-on-red}'
    typography: '{typography.body-strong}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 14px'

  # Card — the containing surface for almost everything in the dashboard.
  card:
    backgroundColor: '{colors.surface}'
    borderColor: '{colors.border}'
    rounded: '{rounded.xl}'
    padding: 24px

  # Input — text fields, search, composer.
  input:
    backgroundColor: '{colors.input-bg}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 12px'

  # Status badge — the most characteristic micro-pattern in the system.
  # Translucent fill + matching ring + brighter foreground text.
  badge-status:
    backgroundColor: '{colors.blue-500}'
    textColor: '{colors.blue-400}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'

  # Brand badge — for the logo lockup and earned highlights.
  badge-brand:
    backgroundColor: '{colors.brand}'
    textColor: '{colors.on-brand}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'

  # Sidebar — fixed-width, dense nav.
  sidebar:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.foreground-muted}'
    width: 256px
    padding: '12px 8px'

  # Topbar — sticky, single-breadcrumb chrome.
  topbar:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    height: 56px
    padding: '0 16px'

  # Tooltip / popover.
  popover:
    backgroundColor: '{colors.surface-raised}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    padding: 12px

  # Dialog / modal.
  dialog:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.xl}'
    padding: 24px

  # Terminal / agent atmospheric surface.
  terminal:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    typography: '{typography.terminal}'
    rounded: '{rounded.lg}'
    padding: 16px
---

## Overview

**Trustworthy infra tool, not a marketing site.** Kilo Cloud is the developer-facing web product around Kilo Code, an open-source AI coding agent that lives primarily as a VS Code / JetBrains extension. The cloud surface manages organizations, usage and billing, headless agent sessions, and developer ops. The aesthetic is **dark-first, near-black, utilitarian** — dense tables, calm chrome, low ornamentation. Speak to developers in second person, plain English, with concrete nouns.

The single concession to atmosphere is the cloud-agent chat surface — terminal-styled mono, a thin yellow-green focus glow, glass on sticky chrome. Everywhere else: utility over delight.

**Three rules to ground every screen.**

1. **Never pure black, never a gradient.** Background is `#121212`. Cards step up to `#2B2B2B`. The lift comes from a one-step background change plus a 10%-white border, not from drop shadows or blur.
2. **Borders are white at low alpha.** This is the single most characteristic move. `#FFFFFF1A` on every card, `#FFFFFF2E` on every input. No solid grey borders.
3. **Yellow acts. Greys carry everything else.** The Kilo yellow-green (`#EDFF00`) is the primary action color — brand and CTA collapsed into one swatch. Use it exactly once per surface for the thing the user is here to do, and again atmospherically for the logo tile, focus ring, text selection, and agent-surface glow. Secondary actions are dark gray. Blue is a legacy link role only — never a button background.

## Colors

**Foundations are a four-step near-black ladder.** `background → surface → surface-raised → muted`. Compose UI by stacking surfaces against background; the visual hierarchy is built from value steps, not color shifts. Cards sit on background. Popovers sit on cards. Inputs sit inside cards but drop _down_ into translucency (`input-bg` is white-on-card at 4% — a recess, not a lift).

- **`background` (`#121212`)** — the app canvas. Always behind everything. Never gradient, never patterned.
- **`surface` (`#2B2B2B`)** — cards, sidebar, dialogs, sticky chrome. The default container.
- **`surface-raised` (`#333333`)** — popovers, tooltips, menus. One step above cards.
- **`muted` (`#3D3D3D`)** — hover states on rows and ghost buttons. Inactive tab backgrounds.

**Foreground is a three-step white ladder.** Body text is near-white (`#FAFAFA`), not pure white — pure white vibrates against `#121212`. Use `foreground-muted` (`#A3A3A3`) for secondary text, captions, and metadata. `foreground-subtle` (`#7A7A7A`) is for disabled and tertiary copy only.

**Borders carry the elevation.** White at 10% alpha for the default border, 18% for inputs and focused chrome. Because borders are translucent, they read correctly on every surface step without needing per-context overrides. Never use a solid grey for borders.

**Action hierarchy is colored, not sized.**

- **`primary` (`#EDFF00`)** — the Kilo yellow-green. The primary action color _and_ the brand mark — they're the same swatch. Used exactly once per surface for the thing the user is here to do (Create session, Save, Install, Continue). Hover darkens to `#D6E600` (not lighter, not translucent). The on-color is near-black (`#1F1F1F`); white text on yellow fails AA.
- **`secondary` (`#3D3D3D`)** — dark-gray with white text and a 10%-white border. The workhorse. Use freely.
- **`ghost`** — underlined white text, no chrome at rest. The decoration is the affordance: `text-decoration-color: rgba(255,255,255,0.35)` at rest, opaque on hover. For inline links, table-row actions, and dialog Cancel buttons.
- **`destructive` (`red-500`)** — red fill, white text. Only inside dialogs and confirm flows. Never on a primary listing screen.
- **`link` (`#3B82F6`)** — legacy blue, inline only. Used for links inside running prose. Never a button background, never a section accent.

**Status colors follow one rigid pattern.** Every status badge is `bg-{color}-500/20 text-{color}-400 ring-1 ring-{color}-500/20`. The translucent fill + matching ring + brighter foreground is the system's most recognizable micro-pattern. Color assignments are fixed by domain, not by mood:

| Color   | Domain                           |
| ------- | -------------------------------- |
| Blue    | Cloud sessions (neutral default) |
| Purple  | VS Code Extension                |
| Zinc    | CLI                              |
| Emerald | Slack                            |
| Orange  | Agent Manager                    |
| Green   | Success, "new" badges            |
| Yellow  | Warnings                         |
| Red     | Destructive, errors              |

Do not invent new status hues. Do not use status colors outside this badge pattern (e.g. don't use `red-500` as a button background — use `destructive` semantics through the dialog system).

## Typography

**Two faces, with discipline.** Inter for all UI. Roboto Mono for code, terminal output, agent tool readouts, dollar amounts in dense tables, and timestamps. Never mix mono into prose UI for emphasis — emphasis is weight (`500`/`600`), not face.

**Default body is `14px / 1.5`.** This is the floor for everything that isn't a heading or a label. Page titles use `tracking-tight` (`-0.015em`) — Inter at 24px+ is too wide-set without it. Eyebrows are uppercase + `tracking-wide` (`0.06em`).

**Heading scale is compact.** This is a dashboard, not a marketing page. Page-level h1 is `30px / 700`. The `display` size (`48px`) is reserved for empty-state hero moments and onboarding — not normal app chrome.

**Casing is sentence case for everything user-visible.** Buttons, nav, section titles, badges. Title Case is wrong. The exceptions are the eyebrow style (uppercase tracking-wide) and the rare role badge (`KILO ADMIN`).

**Numbers in dense data lean mono.** Dollar amounts, latencies, token counts, timestamps in the audit log — all Roboto Mono. This is functional, not decorative: mono digits align across rows.

## Layout

**Shell is sidebar + main, both dark, with a sticky topbar.** Sidebar is fixed `256px` expanded, `48px` icon-only collapsed. The toggle is `cmd/ctrl+B`. State persists via cookie.

- **Topbar** — `56px` tall, `border-b` (the 10%-white border), single breadcrumb on the left, sidebar toggle on the right. Sticky.
- **Page content** — `w-full flex-1` under the topbar. Page-level padding is `24px`.
- **Card stacks** — dashboards are vertical stacks of `Card` components with `gap-y-6` (`24px`). No multi-column page-level grids; multi-column lives _inside_ a card.

**Spacing is a 4px ladder.** Pull from the `spacing` scale; do not invent intermediate values. `2/3/4/6` (8/12/16/24px) covers ~90% of layout decisions. `8/10/12` (32/40/48px) is for section gaps and empty-state breathing room. Anything tighter than `2` is a bug — except for `0-5` (2px) which exists for icon-text optical alignment.

**Density is compact.** Buttons are `36px` tall by default, `32px` for the small variant. Inputs match buttons at `36px`. Table rows are `48px`. Cards get `24px` of inner padding. This is a tool that admins live in for hours; sparseness wastes their time.

## Elevation & Depth

**Lift is a value step, not a shadow.** Cards aren't elevated by drop-shadow — they're elevated by being one step lighter than background plus a 10%-white border. This is the system's signature. Reach for shadows only when an element genuinely floats above the page (popover, tooltip, dialog).

- **`shadow-xs`** — used on inputs to suggest a recessed depth. Whisper-soft.
- **`shadow`** — used on default cards in rare cases (focus, drag).
- **`shadow-md`** — popovers, tooltips, dropdowns.
- **`shadow-lg`** — dialogs over the `bg-black/80` overlay.

**Glass is reserved for sticky chrome.** `backdrop-blur-xl` only on the topbar lockup or persistent overlays. Never on cards or content surfaces — translucent content surfaces become unreadable in dense tables.

**The agent surface gets one extra move: the brand glow.** A thin yellow-green inner shadow on focused composers and live-streaming chrome (`0 0 24px {colors.brand}/35%`). Does not appear in dashboards, billing, or admin.

## Shapes

**Five radii, applied by role.**

- **`rounded.sm` (6px)** — controls. Buttons, inputs, badges, status pills, menu items.
- **`rounded.md` (8px)** — popovers, dropdowns, secondary surfaces.
- **`rounded.lg` (10px)** — cards in non-dashboard contexts (auth, marketing).
- **`rounded.xl` (14px)** — the dashboard `Card`. The most common surface.
- **`rounded.full`** — avatars and the rare pill nav.

Never round above `xl` for a card; never round below `sm` for a control. The system gets its calm cohesion from radius consistency.

## Components

The token table above defines the canonical surface. Notes on application:

**Buttons.** `button-primary` is the yellow CTA with near-black text — one per surface. `button-secondary` is the dark-gray workhorse on cards. `button-ghost` is underlined white text with no chrome at rest — for inline links, table-row actions, and dialog Cancel. `button-destructive` is red, only inside dialogs. Press states are not represented by transforms — buttons don't shrink or scale. Disabled is `opacity-50 + pointer-events-none`. Focus is the brand-glow ring (`#EDFF00` at 35% alpha) on `:focus-visible` only — never on hover.

**Card.** Always `surface` background, always 10%-white border, always `rounded.xl`, always `24px` padding. The header gets `pb-2` (less bottom padding) so the title sits closer to its content.

**Input.** Translucent fill (`input-bg`), 18%-white border, `rounded.sm`, `36px` tall. Focus state adds the brand yellow-green halo via `:focus-visible` — never via hover. Errors flip the border to `destructive` and surface a description below.

**Status badges.** The translucent /20 pattern is non-negotiable. Layout: `gap-1` between icon and label, label in sentence case, icon in `size-3` (12px) — smaller than other inline icons because the badge itself is small.

**Sidebar.** Fixed `256px`. Section headers are eyebrow-style uppercase + tracking-wide. Active row gets `accent` background, inactive rows get `accent` only on hover. Icon at `size-4`, label at `body-strong`. The Kilo logo lives at the top in a `40×40` brand tile.

**Topbar.** Single breadcrumb, no logo (the logo lives in the sidebar). Right side gets the sidebar toggle, a search omnibox, and an avatar. Never put primary actions in the topbar — those belong in the page body.

**Dialog.** `bg-black/80` overlay, centered card, max width `28rem` for confirms / `40rem` for forms. Close button is a ghost icon button in the top-right. Primary action is on the right of the footer, secondary on the left of _that_; cancel is a ghost button on the left of the footer.

**Terminal / agent.** `background` color (not `surface` — terminals stay flush with the canvas), Roboto Mono, `text-sm`. Streaming output is rendered with a blinking caret. Tool-call cards inside the chat are `surface` cards with a 12-px icon + tool name eyebrow + a one-line summary.

## Do's and Don'ts

**Do**

- **Stack value, not color.** Build hierarchy by stepping `background → surface → surface-raised`, not by tinting.
- **Use the brand yellow for the primary action.** One per surface. Earn it.
- **Use translucent borders everywhere.** White at 10% / 18% — never solid grey.
- **Use Roboto Mono for numbers in dense data.** Tables, billing, audit logs, latencies.
- **Stick to sentence case for all user-visible copy.** Including buttons.
- **Use Lucide for every icon.** 1.5–2px stroke, 16px in buttons / badges, 16–20px elsewhere.
- **Apply the translucent /20 pattern for every status badge.** No exceptions.
- **Let cards lift via border + value step.** Reach for shadows only for floating chrome.

**Don't**

- **Don't use pure black or gradients for backgrounds.** Always `#121212`, always flat.
- **Don't put more than one yellow button on a screen.** If you feel the urge, the second one is a `button-secondary`. The yellow has to stay scarce to keep its meaning.
- **Don't use blue as a button background.** Blue is reserved for inline links inside running prose. The primary action is yellow.
- **Don't introduce new status hues.** The eight assigned colors cover the entire taxonomy.
- **Don't use emoji in product chrome.** Lucide only. Emoji are reserved for user-authored content.
- **Don't add per-element drop shadows to cards.** The border + value step does the lift.
- **Don't mix Inter and Roboto Mono in the same line of running text.** Mono in tables, code, terminals — never as inline emphasis.
- **Don't use Title Case anywhere user-facing.** Sentence case throughout.
- **Don't tint borders to convey state.** State changes background (`muted` on hover), not the border color.
