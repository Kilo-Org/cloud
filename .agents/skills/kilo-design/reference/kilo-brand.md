# Kilo Brand

The canonical overlay for every other reference in this skill. When any of
the general design references below conflict with this document, **this
document wins**.

This is not a style guide rewrite. It captures what the Kilo Code codebase
already does, so design changes stay coherent instead of drifting into
generic AI-flavored "modern SaaS."

## Sources of Truth

Before changing tokens, colors, type, radius, or animation, consult these
files directly:

| Concern                  | File                                                       |
| ------------------------ | ---------------------------------------------------------- |
| Web tokens & base theme  | `apps/web/src/app/globals.css`                             |
| Font loading & variables | `apps/web/src/app/layout.tsx`                              |
| shadcn config            | `apps/web/components.json`                                 |
| Core UI primitives       | `apps/web/src/components/ui/*.tsx`                         |
| Brand lockup             | `apps/web/src/components/HeaderLogo.tsx`                   |
| Storybook canvas         | `apps/storybook/.storybook/preview.ts` and `storybook.css` |
| Mobile tokens            | `apps/mobile/src/global.css`                               |

If a token or component already exists, **use it**. Do not reintroduce a
parallel system.

## Register

Kilo has two surfaces with slightly different design rules. Identify which
one you are designing for before picking colors, type scale, or motion.

| Register              | Scope                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| **Product UI**        | Web app, dashboards, settings, billing, admin, Storybook components, mobile app screens |
| **Brand / Marketing** | Landing pages, docs, pricing, hero surfaces, on-brand campaign moments                  |

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

| Token                          | Role                                                    |
| ------------------------------ | ------------------------------------------------------- |
| `background`                   | Page/body surface. Near-black `oklch(0.145 0 0)`.       |
| `foreground`                   | Default text. Near-white `oklch(0.985 0 0)`.            |
| `card`, `popover`              | Elevated dark surface `oklch(0.205 0 0)`.               |
| `card-foreground`              | Text on card.                                           |
| `primary`                      | Brand yellow-green primary CTA token.                   |
| `primary-foreground`           | Near-black text on primary yellow-green.                |
| `secondary`, `muted`, `accent` | Mid-dark surfaces `oklch(0.269 0 0)` for chips, hovers. |
| `muted-foreground`             | Secondary text `oklch(0.708 0 0)`.                      |
| `border`, `input`, `ring`      | Hairline borders and focus rings.                       |
| `destructive`                  | Red error/danger state.                                 |
| `sidebar-*`                    | Sidebar app-shell tokens.                               |
| `chart-1`..`chart-5`           | Data viz palette.                                       |

### Kilo-specific primitives

| Token                               | Value                                           | Use                              |
| ----------------------------------- | ----------------------------------------------- | -------------------------------- |
| `--brand-primary` / `brand-primary` | `oklch(95% 0.15 108)` (electric yellow-green)   | Alias of primary for brand roles |
| `--color-kilo-gray`                 | `oklch(0.24 0.007 1)`                           | Kilo-branded neutral surface     |
| `--color-kilo-gray-lighter`         | Derived via `oklch(from ... calc(l + 0.1) c h)` | Paired with `kilo-gray`          |
| `--ease-out-strong`                 | `cubic-bezier(0.23, 1, 0.32, 1)`                | Preferred easing for transitions |

### Primary action color

The product primary CTA is the Kilo brand yellow-green, exposed through the
semantic `primary` token and `--brand-primary` alias:

| Role       | Value                                    |
| ---------- | ---------------------------------------- |
| Background | `oklch(95% 0.15 108)` (`#EDFF00`-ish)    |
| Hover      | Slightly darker yellow-green             |
| Text       | Near-black via `primary-foreground`      |
| Focus ring | Low-alpha yellow-green / semantic `ring` |

Use it for the main action on a surface, exactly once. Blue is no longer a
primary CTA color; treat hardcoded `#2B6AD2` buttons as legacy drift and
migrate them to semantic `primary` when the owning surface is updated. Blue
remains acceptable for inline links and historical references only.

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

| Family         | CSS variable       | Use                                                        |
| -------------- | ------------------ | ---------------------------------------------------------- |
| Inter          | `--font-sans`      | Default UI text                                            |
| Roboto Mono    | `--font-mono`      | Code, identifiers, metadata                                |
| JetBrains Mono | `--font-jetbrains` | Terminal-like and code-editor surfaces (`.font-jetbrains`) |

Known issue to be aware of (do not fix casually): `globals.css` currently
maps Tailwind's font tokens to `--font-geist-sans` / `--font-geist-mono`,
while `layout.tsx` defines `--font-sans` / `--font-mono`. This means the
Tailwind `font-sans` / `font-mono` utilities may fall back to the browser
default unless the element consumes `--font-sans` directly through the
`<html>` variable. If you are asked to fix this, raise it as a focused
design-system cleanup PR rather than bundling it into an unrelated change.

Type scale rules for product UI:

- Prefer fewer sizes with stronger hierarchy. Do not stack 14/15/16/17.
- Common sizes used in the codebase: `text-xs`, `text-sm`, `text-base`,
  `text-lg`, `text-3xl` (logo wordmark).
- Use `font-medium` for buttons/controls, `font-bold` for logos and
  top-level page titles.
- Use `tabular-nums` for billing, usage counters, metrics, and anything
  that aligns in columns.

## Shape and Radius

Base radius: `--radius: 0.625rem` in `globals.css`. Derived tokens:

| Token         | Value                       | Typical use                   |
| ------------- | --------------------------- | ----------------------------- |
| `--radius-sm` | `calc(var(--radius) - 4px)` | Tight inline chips            |
| `--radius-md` | `calc(var(--radius) - 2px)` | Buttons, inputs               |
| `--radius-lg` | `var(--radius)`             | Popovers, medium containers   |
| `--radius-xl` | `calc(var(--radius) + 4px)` | Cards, dialogs                |
| (pill)        | `rounded-full`              | Badges, avatars, status pills |

Follow existing shadcn primitives. Buttons/inputs `rounded-md`, cards
`rounded-xl`, badges full-pill. Do not introduce new radius values.

## Spacing Rhythm

The app-shell rhythm in the current codebase:

- Controls are compact: `h-8` (sm), `h-9` (default), `h-10` (lg).
- Icons in controls are `size-4`.
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
