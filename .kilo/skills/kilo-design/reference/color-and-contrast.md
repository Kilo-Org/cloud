# Color & Contrast

> Adapted from Impeccable's `color-and-contrast.md` (Apache 2.0). See
> `NOTICE.md` for attribution and upstream source.

## Kilo application

Kilo's exact hex palette is defined in root `DESIGN.md` and implemented as CSS variables. Do not introduce a parallel palette or derive replacement values in another color space.

### Use tokens, not hex

Prefer Tailwind utilities that map to Kilo's semantic tokens
(`bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`,
`border-border`, `ring-ring`, `bg-destructive`, `bg-sidebar`, etc.) over
raw hex. The token layer is in `apps/web/src/app/globals.css`; the
Tailwind bindings are in the `@theme inline` block.

### Primary and brand accent use

`--brand-primary` / `text-brand-primary` / `bg-brand-primary` (`#F7F586`) is the same swatch as the semantic `primary` token. It is both brand and primary action color. Hold it under
10% of pixel weight on any given surface. Reserve for:

- Logo, wordmark, and logo-adjacent affordances.
- The single primary CTA on a surface.
- Focus rings on branded hero controls (see `HeaderLogo.tsx`).
- Intentional glow moments (see `animate-pulse-once` in `globals.css`).
- A small number of brand-defining selected / "on" toggles.

Do **not** use yellow-green as:

- Multiple competing CTAs on the same surface.
- Body or link text color.
- Chart series color (the `chart-*` tokens exist for that).
- Border color on product surfaces.

### Primary action token

The primary product CTA is the brand yellow-green semantic token:

- Background `primary` / `--brand-primary`: `#F7F586`
- Foreground `primary-foreground`: `#1F1F1F`
- Hover `primary-hover`: `#E6E475`
- Focus ring `ring` / `brand-primary-ring`: `#F7F58659`

Hardcoded blue buttons (`#2B6AD2`, Tailwind `blue-*` fills) are legacy drift.
Migrate them to `primary` when touching the owning component or flow. Blue is
reserved for inline links and historical references, not action fills.

### Palette structure (how Kilo's tokens map)

| Role | Purpose | Kilo tokens |
|---|---|---|
| Brand | Rare, load-bearing accent | `brand-primary` |
| Action | Primary CTAs in product/marketing | `primary` / `primary-foreground` |
| Neutral | Text, backgrounds, borders | `background`, `foreground`, `muted`, `accent`, `secondary`, `card`, `popover`, `border`, `input`, `ring`, `kilo-gray` |
| Semantic | Destructive, success pills | `destructive`, badge variants `beta`/`new` |
| Surface | Sidebar, charts, Kilo gray | `sidebar-*`, `chart-1`..`chart-5`, `kilo-gray` |

### Theming discipline

The web app is dark-first — `:root` sets `color-scheme: dark`. Do not
"add light mode" to a web surface on a whim. Mobile follows
`prefers-color-scheme`. If a redesign needs light-mode behavior, verify
both modes' tokens resolve and that existing components in the affected
tree actually react to theme changes.

### Absolute rejects in Kilo UI

- Pure `#000` or `#fff` backgrounds/text. Use tokens.
- Purple / pink / cyan gradient heroes.
- Gradient text (`background-clip: text` + gradient).
- Glassmorphism as a default, decorative effect.
- Rainbow accent palettes introduced just because the screen felt
  monochromatic.
- Yellow-green on body copy, sidebar surfaces, or form fields.
- Blue button backgrounds for new primary actions.

---

## Color-space discipline

The canonical palette uses exact hex values. Do not convert tokens to OKLCH, HSL, or generated shades during feature work: conversion and interpolation can alter contract values. Color-space experiments belong in an explicit design-system change that updates `DESIGN.md` first.

## Building Functional Palettes

### Neutral surfaces

Use the six exact surface tokens rather than deriving tinted neutrals: inset `#101010`, background `#151515`, raised `#202020`, overlay `#333333`, hover `#3A3A3A`, and selected `#454545`. `kilo-gray` aliases exist for compatibility, not as permission to invent additional neutrals.

### Palette structure

Kilo's complete system already provides:

| Role | Purpose | Example |
|---|---|---|
| **Brand** | Rare, voice-carrying accent | 1 color, 1–2 shades |
| **Action** | Primary call-to-action | 1 color, 3 states |
| **Neutral** | Text, backgrounds, borders | 9–11 shade scale |
| **Semantic** | Fixed status domains | Eight families, four shades each |
| **Surface** | Inset, canvas, cards, overlays, interaction states | Six fixed roles |

Do not extend this structure from a feature component. Update `DESIGN.md` first when a genuinely new role is required.

### The 60-30-10 Rule (Applied Correctly)

This is **visual weight**, not pixel count:

- **60%** — Neutral backgrounds, whitespace, base surfaces
- **30%** — Secondary colors: text, borders, inactive states
- **10%** — Accent: CTAs, highlights, focus states

Accent colors work _because_ they are rare. Overuse kills their power.
In Kilo, the primary CTA and brand accent share the same yellow-green swatch.
That shared role should still stay near 10% visual weight.

## Contrast & Accessibility

### WCAG Requirements

| Content type | AA minimum | AAA target |
|---|---|---|
| Body text | 4.5:1 | 7:1 |
| Large text (18px+ or 14px bold) | 3:1 | 4.5:1 |
| UI components, icons | 3:1 | 4.5:1 |

Placeholder text still needs 4.5:1. Check `placeholder:text-muted-foreground` against canonical `bg-input-background`; do not apply another opacity modifier to the already translucent input background.

### Dangerous Color Combinations

- Light gray on white (the #1 accessibility fail)
- Gray text on colored backgrounds (looks washed out)
- Red on green, blue on red (vibrates, colorblind hazards)
- Yellow on white (fails almost always)
- Thin light text on images (unpredictable contrast)

### Never Use Pure Gray or Pure Black

Pure gray and pure black do not exist in nature. Even a chroma of 0.005
is enough to feel natural. Kilo already honors this with `kilo-gray`.

### Testing

Don't trust your eyes. Use:

- WebAIM Contrast Checker
- Browser DevTools → Rendering → Emulate vision deficiencies

## Theming: Light & Dark Mode

### Dark Mode Is Not Inverted Light Mode

Kilo is dark-first for a reason. If you design something for light mode first and "flip" it, you'll introduce bad shadows, under-contrast accents, and oversaturated hues. Design on the exact `surface.background`, `surface.raised`, `surface.overlay`, `surface.hover`, and `surface.selected` roles, not on `#fff`.

| Light mode principle | Dark mode behavior |
|---|---|
| Shadows for depth | Lighter surfaces for depth (no shadows) |
| Dark text on light | Light text on dark (reduce font weight) |
| Vibrant accents | Desaturate accents slightly |
| White backgrounds | Never pure black — dark gray (OKLCH 12–18%) |

Depth in dark mode comes from surface roles, not shadow: `surface.inset` → `surface.background` → `surface.raised` → `surface.overlay`, with `surface.hover` and `surface.selected` reserved for interaction states.

### Token Hierarchy

Use two layers: contract primitives such as `--status-blue-500` and semantic aliases such as `--primary`, `--card`, and `--popover`. Tailwind mappings live in `@theme inline`. Components consume semantic or role-specific utilities; they never redefine primitives locally.

## Alpha Is A Design Smell

Heavy use of transparency (`rgba`, `hsla`) usually means an incomplete
palette. Alpha creates unpredictable contrast, performance overhead, and
inconsistency. Define explicit overlay colors for each context instead.
Kilo's `border.default` (`#FFFFFF1A`) and `border.strong` (`#FFFFFF2E`) use deliberate alpha. Do not stack additional alpha layers on top.

---

**Avoid**: Relying on color alone to convey information. Creating
palettes without clear roles. Using pure black (`#000`) for large
surfaces. Skipping color-blindness testing.
