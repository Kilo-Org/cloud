# Typography

> Adapted from Impeccable's `typography.md` (Apache 2.0). See `NOTICE.md` for
> attribution and upstream source.

## Kilo application

Kilo's fonts are already chosen and loaded. Do not introduce new families.

| Family         | CSS variable       | Use                                                        |
| -------------- | ------------------ | ---------------------------------------------------------- |
| Inter          | `--font-sans`      | Default product UI, buttons, labels, body                  |
| Roboto Mono    | `--font-mono`      | Code tokens, identifiers, metadata                         |
| JetBrains Mono | `--font-jetbrains` | Terminal and code-editor surfaces (class `font-jetbrains`) |

Kilo-specific rules:

- **Product UI uses a fixed type scale.** No fluid `clamp()` sizing inside
  the app shell, dashboards, billing, settings, or Storybook components.
  App UIs need spatial predictability.
- **Marketing/brand pages may use `clamp()` for hero headlines** only. Body
  copy stays fixed.
- **Use `tabular-nums`** on anything numeric that aligns in columns:
  billing, usage counters, tables, KPIs, timers.
- **Disable code ligatures** (`font-variant-ligatures: none;`) only on
  surfaces where glyph-accurate code matters (terminals, diff views).
- **Dark-first line-height bump.** Kilo's default theme is dark. Light text
  on dark reads as lighter weight — prefer the upper end of `line-height`
  ranges (1.55–1.65 for body).
- Logo wordmark is `text-3xl font-bold`; topbars/pages derive their scale
  from there.
- Known token mismatch: `globals.css` maps Tailwind to `--font-geist-*`
  variables that no longer exist. `font-sans` / `font-mono` utilities may
  fall back to system fonts until this is fixed. For now, rely on the font
  variables Inter/Roboto Mono apply via the `<html>` classList in
  `layout.tsx`. Do not paper over this mismatch per component; it is a
  design-system issue.

Absolute rejects in Kilo product UI:

- New font families outside the three listed above.
- Gradient text.
- ALL-CAPS body copy (short labels/eyebrows OK with added tracking).
- Font sizes not on the Tailwind scale.
- Fluid `clamp()` in product UI.

---

## Classic Typography Principles

### Vertical Rhythm

Your line-height should be the base unit for ALL vertical spacing. If body
text has `line-height: 1.5` on 16px type (24px), spacing values should be
multiples of 24px. This creates subconscious harmony between text and space.

### Modular Scale & Hierarchy

The common mistake: too many font sizes that are too close together (14, 15,
16, 18). Muddy hierarchy.

**Use fewer sizes with more contrast.** A five-size system covers most
product UI:

| Role | Typical ratio | Kilo Tailwind | Use case                |
| ---- | ------------- | ------------- | ----------------------- |
| xs   | 0.75rem       | `text-xs`     | Captions, legal, helper |
| sm   | 0.875rem      | `text-sm`     | Secondary UI, metadata  |
| base | 1rem          | `text-base`   | Body text               |
| lg   | 1.125–1.25rem | `text-lg`     | Subheadings, lead text  |
| xl+  | 1.5rem and up | `text-xl`+    | Page titles, hero       |

Pick a ratio (1.25 major third, 1.333 perfect fourth, 1.5 perfect fifth)
and commit. Do not mix multiple scales.

### Readability & Measure

Cap body width in the 45–75ch band (`max-width: 65ch`). Narrow columns need
tighter leading; wide columns need more.

**Dark mode compensation.** Light text on dark reads lighter than dark on
light. Bump line-height by 0.05–0.1, add a trace of letter-spacing (0.01em),
and step body weight up one notch if the text looks thin.

**Paragraph rhythm.** Use either space between paragraphs or first-line
indent. Never both. Product UI uses space.

## Font Selection & Pairing

Kilo does not select new fonts per project. If a brand surface justifies a
genuine display face for a hero, treat it as a design decision that needs
approval, not a reflex.

### Pairing principles

One well-chosen family in multiple weights usually beats two competing
typefaces. Kilo already runs Inter + Roboto Mono + JetBrains Mono; that is
enough. If a second typeface appears on a marketing page, it contrasts on
multiple axes (serif + sans, geometric + humanist, condensed + wide), never
two similar sans-serifs side by side.

### Web font loading

Fonts are loaded in `apps/web/src/app/layout.tsx` via `next/font/google`,
which handles `font-display: swap` and preload. Do not reintroduce manual
`@font-face` declarations or competing loaders.

## Modern Web Typography

### Fluid type — limited in Kilo

`clamp(min, preferred, max)` is allowed on marketing hero headlines and
long-form content where the type dominates the layout. It is **not** used
for product UI, dashboards, tools, or tables. Material, Polaris, Primer,
and Carbon all use fixed scales for the same reason: spatial predictability
matters more than viewport-scaled type in dense surfaces.

Bound your `clamp()`: `max-size ≤ ~2.5 × min-size`.

### OpenType features

```css
/* Tabular numbers for data alignment */
.data-table {
  font-variant-numeric: tabular-nums;
}

/* Proper fractions */
.recipe-amount {
  font-variant-numeric: diagonal-fractions;
}

/* Small caps for abbreviations */
abbr {
  font-variant-caps: all-small-caps;
}

/* Disable ligatures in code */
code,
.font-jetbrains {
  font-variant-ligatures: none;
}

/* Explicit kerning */
body {
  font-kerning: normal;
}
```

### Rendering polish

```css
/* Even out heading line lengths */
h1,
h2,
h3 {
  text-wrap: balance;
}

/* Reduce orphans and ragged endings in long prose */
article p {
  text-wrap: pretty;
}

/* Pick the right optical-size master automatically */
body {
  font-optical-sizing: auto;
}
```

ALL-CAPS short labels need 5–12% letter-spacing (`letter-spacing: 0.05em`
to `0.12em`).

## Typography System Architecture

Name tokens semantically (`--text-body`, `--text-heading`), not by value
(`--font-size-16`). In Kilo, prefer Tailwind's `text-*` scale and the
`--font-sans` / `--font-mono` / `--font-jetbrains` variables directly.

## Accessibility

- **Never disable zoom.** `user-scalable=no` breaks accessibility.
- **Use `rem`/`em` for font sizes.** Never `px` for body text.
- **Minimum 16px body text.** Smaller than this fails WCAG on mobile.
- **Adequate touch targets.** Text links need padding or line-height that
  yields a 44px+ tap target.

---

**Avoid**: More than three font families (Kilo already uses three; no
fourth). Skipping fallback font definitions. Decorative fonts for body
text. Fluid type in product UI.
