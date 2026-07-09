# Kilo Brand

Canonical application overlay for every other reference in this skill. Root `DESIGN.md` wins for token contracts; this document wins when general references conflict on Kilo-specific application guidance.

Root `DESIGN.md` owns exact token values and roles. This reference explains how to apply that contract in the Kilo Code codebase so changes stay coherent instead of drifting into generic AI-flavored "modern SaaS." If implementation differs from `DESIGN.md`, treat it as drift.

## Sources of Truth

Before changing tokens, colors, type, radius, or animation, consult these
files directly:

| Concern | File |
|---|---|
| Canonical token contract | `DESIGN.md` |
| Web token implementation | `apps/web/src/app/globals.css` |
| Font loading & variables | `apps/web/src/app/layout.tsx` |
| shadcn config | `apps/web/components.json` |
| Core UI primitives | `apps/web/src/components/ui/*.tsx` |
| Brand lockup | `apps/web/src/components/HeaderLogo.tsx` |
| Storybook canvas | `apps/storybook/.storybook/preview.ts` and `storybook.css` |
| Mobile tokens | `apps/mobile/src/global.css` |

If a compliant token or component already exists, **use it**. Do not reintroduce a parallel system. If existing code conflicts with `DESIGN.md`, report or fix the drift rather than copying it.

## Register

Kilo has two surfaces with slightly different design rules. Identify which
one you are designing for before picking colors, type scale, or motion.

| Register | Scope |
|---|---|
| **Product UI** | Web app, dashboards, settings, billing, admin, Storybook components, mobile app screens |
| **Brand / Marketing** | Landing pages, docs, pricing, hero surfaces, on-brand campaign moments |

Both use the same tokens and fonts. Brand permits more visual expression
(hero type, animation, committed color, imagery). Product UI stays calm,
compact, and task-oriented.

## Theme

Kilo's web app is **dark-first**. `:root` in `apps/web/src/app/globals.css`
forces `color-scheme: dark`. Mobile's `apps/mobile/src/global.css` defines
light tokens in `:root` and dark tokens under `prefers-color-scheme`. Design
web surfaces with dark as the default; check mobile surfaces in both system
themes.

Do not "add a light mode" speculatively. If asked to work in light, check
that the surface actually participates in theme switching and that the
tokens you need are defined for both modes.

## Color Primitives

### Semantic (use these first)

These are declared as CSS variables in `globals.css` and surfaced to
Tailwind via `@theme inline`. Prefer the Tailwind utility that maps to the
token (e.g. `bg-background`, `text-foreground`, `border-border`) over hex.

| Token | Role |
|---|---|
| `background` | Alias of `surface.background` (`#151515`) for the page/body canvas. |
| `foreground` | Alias of `foreground.default` (`#FAFAFA`). |
| `card` | Alias of `surface.raised` (`#202020`). |
| `popover` | Alias of `surface.overlay` (`#333333`). |
| `card-foreground`, `popover-foreground` | Default foreground on those surfaces. |
| `primary` | Brand yellow-green primary CTA token (`#F7F586`). |
| `primary-foreground` | Near-black text on primary (`#1F1F1F`). |
| `secondary` | Alias of `surface.overlay`; neutral action surface. |
| `muted` | Alias of `surface.raised`; de-emphasized region. |
| `accent` | Alias of `surface.hover`; interaction hover state. |
| `muted-foreground` | Alias of `foreground.muted` (`#A3A3A3`). |
| `border`, `input`, `ring` | Default border, strong input border, and brand focus ring. |
| `destructive` | Red error/danger state. |
| `sidebar-*` | Sidebar app-shell tokens. |
| `chart-1`..`chart-5` | Data viz palette. |

### Kilo-specific primitives

| Token | Value | Use |
|---|---|---|
| `--brand-primary` / `brand-primary` | `#F7F586` | Alias of primary for brand roles |
| `--brand-primary-hover` | `#E6E475` | Primary hover |
| `--brand-primary-ring` | `#F7F58659` | Brand focus ring |
| `--color-kilo-gray` | `surface.raised` (`#202020`) | Compatibility alias |
| `--color-kilo-gray-lighter` | `surface.overlay` (`#333333`) | Compatibility alias |
| `--ease-out-strong` | `cubic-bezier(0.23, 1, 0.32, 1)` | Preferred easing for transitions |

### Primary action color

The product primary CTA is the Kilo brand yellow-green, exposed through the
semantic `primary` token and `--brand-primary` alias:

| Role | Value |
|---|---|
| Background | `#F7F586` via `primary` / `brand-primary` |
| Hover | `#E6E475` via `primary-hover` / `brand-primary-hover` |
| Text | `#1F1F1F` via `primary-foreground` |
| Focus ring | `#F7F58659` via `ring` / `brand-primary-ring` |

Use it for the main action on a surface, exactly once. Blue is no longer a
primary CTA color; treat hardcoded `#2B6AD2` buttons as legacy drift and
migrate them to semantic `primary` when the owning surface is updated. Blue
remains acceptable for inline links and historical references only.

## Surface and Domain Tokens

Use the six-role surface ladder exactly: `surface.inset` for terminal and recessed regions, `surface.background` for canvas, `surface.raised` for cards and persistent chrome, `surface.overlay` for floating UI, `surface.hover` for hover, and `surface.selected` for selected neutral states.

Status domain assignments are fixed: Cloud blue, VS Code purple, CLI gray, Slack teal, Agent Manager orange, success green, warning yellow, destructive red. Do not rename teal to emerald or gray to zinc. Use syntax tokens only on code-oriented surfaces and dedicated diff text/surface pairs with non-color `+`/`-` cues.

## Brand Accent Discipline

The yellow-green primary is load-bearing precisely because it is rare.
Reserve it for:

- The Kilo logo and wordmark.
- The primary CTA, once per surface.
- Focus rings on branded / hero controls.
- Confirmation glow on intentional brand moments (see
  `animate-pulse-once` / `pulse-glow` in `globals.css`).
- Selected / "on" state for a small number of brand-critical toggles.

Avoid:

- Using it for every button.
- Using it as a default text color.
- Pairing it with long body copy (contrast and reading feel drop fast).
- Decorative use on dense product UI.

## Typography

Font loading is in `apps/web/src/app/layout.tsx`:

| Family | CSS variable | Use |
|---|---|---|
| Inter | `--font-sans-loaded` / Tailwind `font-sans` | Default UI text |
| Roboto Mono | `--font-mono-loaded` / Tailwind `font-mono` | Code, identifiers, metadata |
| JetBrains Mono | `--font-jetbrains` | Terminal-like and code-editor surfaces (`.font-jetbrains`) |

`globals.css` maps Tailwind font tokens to the variables loaded by `layout.tsx`. Do not add per-component font fallbacks.

Type scale rules for product UI:

- Prefer canonical utilities: `type-title`, `type-heading`, `type-body-lg`, `type-body`, `type-label`, `type-eyebrow`, and `type-code`.
- Do not stack near-duplicate sizes or replace exact typography roles with arbitrary Tailwind combinations.
- Use `type-label` for buttons and controls, `type-title` for top-level page titles, and existing lockup styling for logos.
- Use `tabular-nums` for billing, usage counters, metrics, and anything
  that aligns in columns.

## Shape and Radius

Use the exact radius contract:

| Token | Value | Typical use |
|---|---|---|
| `--radius-sm` | `4px` | Tight inline chips |
| `--radius-md` | `8px` | Buttons, inputs |
| `--radius-lg` | `10px` | Popovers, medium containers |
| `--radius-xl` | `14px` | Cards, dialogs |
| (pill) | `rounded-full` | Badges, avatars, status pills |

Follow existing shadcn primitives. Buttons/inputs `rounded-md`, cards
`rounded-xl`, badges full-pill. Do not introduce new radius values.

## Spacing Rhythm

The app-shell rhythm in the current codebase:

- Controls are compact: `h-8` (sm), `h-control-default` / 36px (default), `h-10` (lg). Touch surfaces use `h-control-touch` or `size-control-touch` for 44px targets.
- Icons in controls are usually `size-4`; compact/status icons use `size-icon-sm` (14px).
- Topbars are `h-14`.
- Cards use `p-6` for header/content/footer, `gap-1.5` between title and
  description.
- Sidebars have their own token set (`sidebar-*`).
- Prefer Tailwind's 4pt-aligned scale (`gap-2`, `gap-3`, `gap-4`, `gap-6`,
  `gap-8`). Avoid one-off spacing.

## Components

The design system is shadcn/ui in the **New York** style, neutral base
color, CSS variables enabled (`apps/web/components.json`). Icons come from
`lucide-react`.

Work inside this system:

- Before building a new control, check `apps/web/src/components/ui/` for a
  primitive. Extend variants before creating new files.
- Radix primitives back most overlays (dialog, dropdown, popover, select,
  tabs, tooltip, sheet). Use them — do not hand-roll positioning.
- Mobile uses a sibling shadcn setup in `apps/mobile/`. React Native does
  not accept every Tailwind pattern; check `apps/mobile/AGENTS.md` (if
  present) and the components there before styling across mobile surfaces.

## Motion

Current conventions:

- `--ease-out-strong` is the preferred curve for most transitions.
- `motion/react` is already in use (see `HeaderLogo.tsx`) for brand
  interactions. `tw-animate-css` is imported in `globals.css` for small
  utility animations.
- Brand moments can use `animate-pulse-once` (see `globals.css`) or the
  logo hover flourish. Treat these as branded punctuation, not defaults.
- Respect `prefers-reduced-motion`. Product motion should be short and
  functional.

## Iconography

- `lucide-react` is the default set.
- `size-4` inside controls, inheriting `currentColor`.
- Icon-only buttons need an `aria-label`.
- Do not mix icon packs without a strong reason.

## Anti-Patterns To Reject On Sight

These hurt Kilo specifically, on top of general anti-slop rules:

- **Yellow everywhere.** If the screen screams yellow, keep yellow to the
  single primary action plus real brand moments.
- **Blue button backgrounds.** Blue is for inline links and legacy drift,
  not primary action fills.
- **Inventing a new primary color** instead of using the `primary` token.
- **Purple gradient heroes, gradient text, glassmorphism defaults.**
- **Nested cards** (card inside card). Use hierarchy and spacing instead.
- **New font families** beyond Inter / Roboto Mono / JetBrains Mono.
- **New radius values** outside the token set above.
- **Ignoring the sidebar tokens** and hand-coloring sidebar surfaces.
- **Light-mode-only designs** that ignore Kilo's dark-first app.

## How Agents Should Use This File

- Load `kilo-brand.md` whenever a design change touches Kilo's UI.
- When producing code, prefer existing tokens, utilities, and components
  before writing new ones.
- When producing review/critique output, cite specific tokens, files, and
  components by path.
- When a user's request conflicts with these rules, surface the conflict
  first. Do not quietly override the brand system.
