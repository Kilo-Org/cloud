# Color & Contrast

> Adapted from Impeccable's `color-and-contrast.md` (Apache 2.0). See
> `NOTICE.md` for attribution and upstream source.

## Kilo application

Kilo's palette is already expressed in OKLCH CSS variables. Do not
introduce a parallel palette.

### Use tokens, not hex

Prefer Tailwind utilities that map to Kilo's semantic tokens
(`bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`,
`border-border`, `ring-ring`, `bg-destructive`, `bg-sidebar`, etc.) over
raw hex. The token layer is in `apps/web/src/app/globals.css`; the
Tailwind bindings are in the `@theme inline` block.

### Primary and brand accent use

`--brand-primary` / `text-brand-primary` / `bg-brand-primary` (electric
yellow-green, `oklch(95% 0.15 108)`) is the same swatch as the semantic
`primary` token. It is both brand and primary action color. Hold it under
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

- Background `primary` / `--brand-primary` / `oklch(95% 0.15 108)`
- Foreground `primary-foreground` (near-black)
- Hover: slightly darker yellow-green
- Focus ring: semantic `ring` or low-alpha yellow-green

Hardcoded blue buttons (`#2B6AD2`, Tailwind `blue-*` fills) are legacy drift.
Migrate them to `primary` when touching the owning component or flow. Blue is
reserved for inline links and historical references, not action fills.

### Palette structure (how Kilo's tokens map)

| Role     | Purpose                           | Kilo tokens                                                                                                           |
| -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Brand    | Rare, load-bearing accent         | `brand-primary`                                                                                                       |
| Action   | Primary CTAs in product/marketing | `primary` / `primary-foreground`                                                                                      |
| Neutral  | Text, backgrounds, borders        | `background`, `foreground`, `muted`, `accent`, `secondary`, `card`, `popover`, `border`, `input`, `ring`, `kilo-gray` |
| Semantic | Destructive, success pills        | `destructive`, badge variants `beta`/`new`                                                                            |
| Surface  | Sidebar, charts, Kilo gray        | `sidebar-*`, `chart-1`..`chart-5`, `kilo-gray`                                                                        |

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

## Color Spaces: Use OKLCH

OKLCH is perceptually uniform — equal steps in lightness look equal. HSL
is not. Kilo's tokens are already OKLCH.

`oklch(lightness chroma hue)` where lightness is 0–100%, chroma ~0–0.4,
hue 0–360. Hold chroma+hue roughly constant and vary lightness to build
variants, but **reduce chroma as lightness approaches 0 or 100** — high
chroma at the extremes reads as garish.

## Building Functional Palettes

### Tinted Neutrals

Pure gray is dead. Add a tiny chroma value (0.005–0.015) to neutrals,
hued toward the brand hue. Kilo already does this: `--color-kilo-gray`
is `oklch(0.24 0.007 1)`. Tailwind's shadcn neutral tokens carry 0
chroma; that's acceptable for the dense product shell, but when you
create a new branded surface, lean on `kilo-gray` rather than a pure gray.

### Palette Structure

A complete system needs:

| Role         | Purpose                       | Example                   |
| ------------ | ----------------------------- | ------------------------- |
| **Brand**    | Rare, voice-carrying accent   | 1 color, 1–2 shades       |
| **Action**   | Primary call-to-action        | 1 color, 3 states         |
| **Neutral**  | Text, backgrounds, borders    | 9–11 shade scale          |
| **Semantic** | Success, error, warning, info | 4 colors, 2–3 shades each |
| **Surface**  | Cards, modals, overlays       | 2–3 elevation levels      |

Skip secondary/tertiary unless you need them. Most apps work fine with
one accent and one action color.

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

| Content type                    | AA minimum | AAA target |
| ------------------------------- | ---------- | ---------- |
| Body text                       | 4.5:1      | 7:1        |
| Large text (18px+ or 14px bold) | 3:1        | 4.5:1      |
| UI components, icons            | 3:1        | 4.5:1      |

The gotcha: placeholder text still needs 4.5:1. Check Kilo's
`placeholder:text-muted-foreground` against `bg-input/30` on real screens
before lowering opacity further.

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

Kilo is dark-first for a reason. If you design something for light mode
first and "flip" it, you'll introduce bad shadows, under-contrast accents,
and oversaturated hues. Design on the real `background` / `card` /
`muted` surfaces, not on `#fff`.

| Light mode principle | Dark mode behavior                          |
| -------------------- | ------------------------------------------- |
| Shadows for depth    | Lighter surfaces for depth (no shadows)     |
| Dark text on light   | Light text on dark (reduce font weight)     |
| Vibrant accents      | Desaturate accents slightly                 |
| White backgrounds    | Never pure black — dark gray (OKLCH 12–18%) |

Depth in dark mode comes from surface lightness, not shadow. Kilo's scale
is already: `background` → `card`/`popover` → `muted`/`secondary`/`accent`.

### Token Hierarchy

Use two layers: primitive tokens (`--blue-500`) and semantic tokens
(`--color-primary: var(--blue-500)`). In Kilo, primitives live inline in
OKLCH; semantic tokens map through `@theme inline`. Redefine the semantic
layer for theme changes, never the primitive layer per component.

## Alpha Is A Design Smell

Heavy use of transparency (`rgba`, `hsla`) usually means an incomplete
palette. Alpha creates unpredictable contrast, performance overhead, and
inconsistency. Define explicit overlay colors for each context instead.
Kilo's borders use `oklch(1 0 0 / 10%)` deliberately; that's fine. Don't
stack five more alpha layers on top of it.

---

**Avoid**: Relying on color alone to convey information. Creating
palettes without clear roles. Using pure black (`#000`) for large
surfaces. Skipping color-blindness testing.
