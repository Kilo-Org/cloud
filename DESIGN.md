---
name: Kilo Cloud
description: Dark-first, utilitarian developer surface for Kilo Code. Near-black surfaces, low-alpha white borders, compact density, and scarce Kilo yellow-green primary actions.
colors:
  background: '#121212'
  surface: '#2B2B2B'
  surface-raised: '#333333'
  muted: '#3D3D3D'
  foreground: '#FAFAFA'
  foreground-muted: '#A3A3A3'
  foreground-subtle: '#7A7A7A'
  foreground-on-red: '#FFFFFF'
  border: '#FFFFFF1A'
  border-strong: '#FFFFFF2E'
  input-bg: '#FFFFFF0A'
  primary: '#EDFF00'
  primary-hover: '#D6E600'
  primary-ring: '#EDFF0059'
  on-primary: '#1F1F1F'
  secondary: '#3D3D3D'
  secondary-hover: '#4D4D4D'
  on-secondary: '#FAFAFA'
  brand: '#EDFF00'
  brand-dim: '#B8C800'
  on-brand: '#1F1F1F'
  link: '#3B82F6'
  link-hover: '#60A5FA'
  blue-500: '#3B82F6'
  blue-400: '#60A5FA'
  purple-500: '#A855F7'
  purple-400: '#C084FC'
  emerald-500: '#10B981'
  emerald-400: '#34D399'
  zinc-500: '#71717A'
  zinc-400: '#A1A1AA'
  orange-500: '#F97316'
  orange-400: '#FB923C'
  green-500: '#22C55E'
  green-400: '#4ADE80'
  yellow-500: '#EAB308'
  yellow-400: '#FACC15'
  red-500: '#EF4444'
  red-400: '#F87171'
typography:
  display:
    fontFamily: Inter
    fontSize: 3rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.015em'
  headline:
    fontFamily: Inter
    fontSize: 1.875rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.015em'
  title:
    fontFamily: Inter
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.015em'
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
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    typography: '{typography.body-strong}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 14px'
  button-primary-hover:
    backgroundColor: '{colors.primary-hover}'
  button-secondary:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.on-secondary}'
    typography: '{typography.body-strong}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 14px'
  button-secondary-hover:
    backgroundColor: '{colors.secondary-hover}'
  button-ghost:
    backgroundColor: transparent
    textColor: '{colors.foreground}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 4px'
  button-destructive:
    backgroundColor: '{colors.red-500}'
    textColor: '{colors.foreground-on-red}'
    typography: '{typography.body-strong}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 14px'
  card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.xl}'
    padding: 24px
  input:
    backgroundColor: '{colors.input-bg}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.sm}'
    height: 36px
    padding: '0 12px'
  badge-status:
    backgroundColor: '{colors.blue-500}'
    textColor: '{colors.blue-400}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'
  sidebar:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.foreground-muted}'
    width: 256px
    padding: '12px 8px'
  topbar:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    height: 56px
    padding: '0 16px'
  popover:
    backgroundColor: '{colors.surface-raised}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    padding: 12px
  dialog:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.xl}'
    padding: 24px
  terminal:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    typography: '{typography.terminal}'
    rounded: '{rounded.lg}'
    padding: 16px
---

# Design System: Kilo Cloud

## 1. Overview

**Creative North Star: "The Operator Console"**

Kilo Cloud is a trustworthy infrastructure tool for developers, organization admins, and internal operators. It should feel like a calm console for real work: dense, legible, fast to scan, and specific about state, cost, access, and next action.

The system is dark-first because the product sits next to editors, terminals, and long-running agent sessions. The physical scene is a developer or admin checking active sessions, usage, billing, or security findings during focused work on a laptop or large monitor. Low glare, compact density, and predictable contrast matter more than decorative atmosphere.

The surface rejects generic SaaS dashboards, neon AI hype, decorative glass or gradient-heavy interfaces, playful consumer app UI, corporate enterprise portals, and vague marketing pages. The single atmospheric exception is the agent surface, where terminal-styled mono and a thin yellow-green glow can signal live work. Everywhere else, utility wins.

**Key Characteristics:**

- Dark-first near-black canvas with stepped charcoal surfaces.
- Borders carry structure: white at low alpha, not solid gray.
- Kilo yellow-green is scarce and action-oriented.
- Compact dashboard rhythm: 36px controls, 48px table rows, 24px card padding.
- Developer-to-developer clarity: concrete nouns, precise costs, states, timestamps, and links.
- Existing implementation drift exists in a few legacy components: some button variants still hardcode blue, and the app-level `--primary` token is not yet the Kilo yellow-green. Treat those as migration targets, not design precedent.

## 2. Colors

The palette is a restrained operator palette: near-black neutrals do almost all the work, while Kilo yellow-green marks the one action that matters.

### Primary

- **Kilo action yellow-green** (`primary`, `brand`): Primary action, logo tile, focus ring, text selection, earned agent glow, and rare brand emphasis. Use once per surface for the action the user came to perform.
- **Kilo action hover** (`primary-hover`): Hover state for the primary action. Darken the yellow-green; do not lighten it or make it translucent.
- **Kilo action ring** (`primary-ring`): Focus-visible ring and agent composer glow. It belongs on keyboard focus and active agent surfaces, not decorative cards.

### Secondary

- **Workhorse gray** (`secondary`): Secondary buttons, neutral affordances, inactive tabs, and quiet action surfaces.
- **Workhorse gray hover** (`secondary-hover`): Hover state for secondary controls and row-level affordances.
- **Legacy link blue** (`link`, `link-hover`): Inline links in prose or tables. Blue is never a button background and never a section accent.

### Tertiary

- **Status blue** (`blue-500`, `blue-400`): Cloud sessions and neutral defaults.
- **Status purple** (`purple-500`, `purple-400`): VS Code Extension.
- **Status emerald** (`emerald-500`, `emerald-400`): Slack.
- **Status zinc** (`zinc-500`, `zinc-400`): CLI.
- **Status orange** (`orange-500`, `orange-400`): Agent Manager.
- **Status green** (`green-500`, `green-400`): Success and "new" states.
- **Status yellow** (`yellow-500`, `yellow-400`): Warnings.
- **Status red** (`red-500`, `red-400`): Destructive actions and errors.

### Neutral

- **App canvas** (`background`): Root background. Always flat, always near-black.
- **Dashboard surface** (`surface`): Cards, sidebar, dialogs, sticky chrome, and the main contained layer.
- **Raised surface** (`surface-raised`): Popovers, menus, tooltips, and short-lived floating chrome.
- **Muted surface** (`muted`): Hover rows, inactive tab fills, and low-emphasis UI backgrounds.
- **Primary text** (`foreground`): Body and heading text. Near-white, never pure white.
- **Muted text** (`foreground-muted`): Secondary labels, descriptions, metadata, and captions.
- **Subtle text** (`foreground-subtle`): Disabled or tertiary text only.
- **Low-alpha border** (`border`): Default structural line. White at 10% alpha.
- **Strong border** (`border-strong`): Inputs, focused chrome, and places needing slightly firmer separation.
- **Input recess** (`input-bg`): Translucent input fill that visually drops into a card.

### Named Rules

**The Yellow Acts Rule.** Yellow-green means the primary action or live agent focus. If two yellow buttons appear on one surface, one of them is wrong.

**The Border Carries Structure Rule.** Use low-alpha white borders to separate surfaces. Do not tint borders to create hierarchy.

**The Blue Is Inline Rule.** Blue is a legacy inline link role only. It is prohibited as a primary button, badge accent outside its status role, or marketing flourish.

## 3. Typography

**Display Font:** Inter with system sans fallbacks.
**Body Font:** Inter with system sans fallbacks.
**Label/Mono Font:** Roboto Mono for code, terminal output, command snippets, timestamps, token counts, costs, latencies, and dense tabular numbers. JetBrains Mono exists as a legacy alias in some surfaces and should not become a new visual direction.

**Character:** The pairing is compact and technical without becoming cold. Inter carries product clarity; Roboto Mono appears only where monospaced alignment improves comprehension.

### Hierarchy

- **Display** (700, `3rem`, `1.15`, `-0.015em`): Empty-state hero moments and onboarding, not regular dashboard chrome.
- **Headline** (700, `1.875rem`, `1.15`, `-0.015em`): Page titles and major decision screens.
- **Title** (600, `1.5rem`, `1.3`, `-0.015em`): Card groups, dialogs, and page sections.
- **Body** (400, `0.875rem`, `1.5`): Default UI text. Cap long prose at 65 to 75 characters.
- **Body strong** (500, `0.875rem`, `1.5`): Navigation items, button labels, row-leading labels, and emphasized values.
- **Label** (500, `0.75rem`, `1.3`): Form labels, small metadata, and badge text.
- **Eyebrow** (600, `0.6875rem`, `0.06em`): Section markers and sidebar group labels. Uppercase is allowed here because it is a structural label, not conversational copy.
- **Code and terminal** (400, `0.8125rem`, `1.5`): Commands, code, terminal output, tool readouts, dollar amounts, timestamps, and dense numeric columns.

### Named Rules

**The Mono Earns Its Place Rule.** Use mono only where alignment or code semantics matter. Do not use mono as decoration or inline emphasis in prose.

**The Sentence Case Rule.** User-facing product chrome uses sentence case. Title Case is wrong for buttons, nav, section titles, badges, dialogs, and empty states.

**The Dense Data Rule.** Numbers that must be compared across rows use Roboto Mono with tabular alignment.

## 4. Elevation

Kilo Cloud is tonal and layered, not shadow-heavy. Depth comes from value steps: `background` under `surface`, then `surface-raised` for floating chrome, all separated by low-alpha white borders. Shadows are reserved for elements that genuinely float above the page or need state feedback.

### Shadow Vocabulary

- **Input recess** (`shadow-xs`): Inputs and small recessed controls. It should feel almost invisible.
- **Card state** (`shadow`): Rare focus, drag, or active card states. Default cards should not rely on shadows.
- **Floating chrome** (`shadow-md`): Popovers, tooltips, menus, dropdowns.
- **Dialog lift** (`shadow-lg`): Dialogs over a dark overlay.
- **Agent glow** (`primary-ring`): A thin yellow-green focus or streaming glow on agent surfaces only.

### Named Rules

**The Value Step Rule.** Lift comes from background value plus border. A card should still read correctly if every shadow is removed.

**The Glass Is Sticky Chrome Rule.** Backdrop blur belongs on topbars or persistent overlays only. Glass cards are prohibited.

**The Shadow Must Float Rule.** If an element is part of normal page flow, do not add a shadow to make it look important.

## 5. Components

### Buttons

- **Shape:** Compact control radius (`sm`, 6px). Height is 36px by default and 32px for small controls.
- **Primary:** Kilo yellow-green background with near-black text. Use once per surface. Existing hardcoded blue `primary` variants are implementation drift and should be migrated.
- **Secondary:** Workhorse gray with near-white text and a low-alpha white border. Use for all non-primary actions.
- **Ghost:** Transparent at rest, underlined or quiet text-only affordance. Use for inline links, table-row actions, and Cancel.
- **Destructive:** Red fill with white text, only inside confirmation flows and dialogs.
- **Hover / Focus:** Hover changes color value only. Focus-visible gets the yellow-green ring. Buttons do not shrink, bounce, or scale.

### Chips

- **Style:** Status chips use translucent fill, matching low-alpha ring, and brighter foreground text.
- **State:** The pattern is fixed: `bg-{color}-500/20 text-{color}-400 ring-1 ring-{color}-500/20`.
- **Icons:** Lucide icons at 12px inside badges. Keep them smaller than normal inline icons because the badge is small.
- **Naming:** Badge labels use sentence case unless they are intentionally structural role markers.

### Cards / Containers

- **Corner Style:** Dashboard cards use calm rounded corners (`xl`, 14px). Non-dashboard cards can use `lg` (10px). Never exceed `xl` for cards.
- **Background:** Cards use `surface` on `background`. Popovers use `surface-raised`.
- **Border:** Every default card has a low-alpha white border. Do not use solid gray borders.
- **Internal Padding:** 24px default. Card header spacing is tighter below the title so headings sit close to content.
- **Shadow Strategy:** Default cards lift through value step plus border, not shadow.

### Inputs / Fields

- **Style:** 36px height, 6px radius, translucent fill, strong low-alpha white border, and 12px horizontal padding.
- **Focus:** Focus-visible uses the yellow-green ring or halo. Do not move the element or animate layout.
- **Error / Disabled:** Errors use destructive border and clear text below the field. Disabled uses opacity reduction and removed pointer events.
- **Density:** Inputs should align with buttons in height and rhythm.

### Navigation

- **Sidebar:** Fixed 256px expanded, 48px collapsed icon rail, compact group spacing, 16px icons, and active rows using muted/accent backgrounds.
- **Topbar:** 56px sticky chrome with a bottom border, single breadcrumb, sidebar toggle, search or avatar controls. Primary page actions belong in the page body, not the topbar.
- **Mobile:** Sidebar becomes a sheet with the same dark surface and no decorative treatment.
- **Shortcut:** Sidebar toggles with command/control+B and persists state with a cookie.

### Dialogs and Popovers

- **Dialog:** Centered surface card, 24px padding, dark overlay, `xl` radius, and shadow only because it floats.
- **Popover:** Raised surface, `md` radius, 12px padding, shadow-md. Keep content short and action-oriented.
- **Footer Actions:** Primary action on the right, secondary beside it, Cancel as ghost. Avoid defaulting to modals when inline or progressive disclosure works.

### Terminal / Agent Surface

- **Style:** Flush near-black canvas, Roboto Mono, compact text, and restrained yellow-green prompt or focus glow.
- **Tool Cards:** Surface cards with low-alpha borders, tiny icon, tool-name eyebrow, and one-line summary.
- **Streaming:** A caret or lightweight activity cue is enough. Do not add decorative neon effects.

## 6. Do's and Don'ts

### Do:

- **Do** use `background` under `surface` under `surface-raised` to build hierarchy.
- **Do** use Kilo yellow-green for exactly one primary action per surface.
- **Do** use low-alpha white borders: `border` for default structure, `border-strong` for inputs and focused chrome.
- **Do** keep product surfaces compact: 36px controls, 48px rows, 24px card padding, and 24px vertical card gaps.
- **Do** use Roboto Mono for costs, latencies, token counts, timestamps, commands, and terminal output.
- **Do** use concrete labels, costs, states, timestamps, links, and next actions.
- **Do** preserve sentence case and the Kilo naming rules from PRODUCT.md.
- **Do** use Lucide icons with restrained sizing and consistent stroke.
- **Do** treat current blue primary buttons and near-white app `--primary` as legacy drift to migrate away from.

### Don't:

- **Don't** create generic SaaS dashboards.
- **Don't** create neon AI hype.
- **Don't** use decorative glass or gradient-heavy interfaces.
- **Don't** make the product feel like a playful consumer app UI.
- **Don't** make the product feel like a corporate enterprise portal.
- **Don't** create vague marketing pages inside product chrome.
- **Don't** use blue as a primary button background. Blue is inline link/accent only.
- **Don't** put more than one yellow button on a screen.
- **Don't** introduce new status hues beyond the documented status palette.
- **Don't** use pure black or pure white in product surfaces.
- **Don't** add per-element drop shadows to default cards.
- **Don't** use glass cards, side-stripe borders, gradient text, hero-metric templates, or repeated identical icon-card grids.
- **Don't** use ambiguous billing language. Kilo Credits are purchased usage credit; tokens are model input and output volume.
- **Don't** use old names such as "Kilo For Teams," "Kilo for Enterprise," "Kilo for Organizations," "Kilo Code Deploy," "Kilo Managed Indexing," or "Kilo Cloud Agents."
