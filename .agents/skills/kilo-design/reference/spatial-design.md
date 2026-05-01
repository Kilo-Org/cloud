# Spatial Design

> Adapted from Impeccable's `spatial-design.md` (Apache 2.0). See
> `NOTICE.md` for attribution and upstream source.

## Kilo application

Kilo's product UI is **compact and task-oriented**. Do not redesign the
app shell with marketing-scale spacing.

### Spacing

- Use Tailwind's 4pt-aligned scale: `gap-1`, `gap-2`, `gap-3`, `gap-4`,
  `gap-6`, `gap-8`. Avoid arbitrary `gap-[19px]`.
- Prefer `gap` over margins. It eliminates margin collapse and is
  consistent with flex/grid in the codebase.
- Cards use `p-6` for header/content/footer, `gap-1.5` between card title
  and description (`apps/web/src/components/ui/card.tsx`).
- App topbars run at `h-14`; avoid arbitrary topbar heights.
- Controls stay compact: `h-8` (sm), `h-9` (default), `h-10` (lg). Match
  this rhythm when adding new interactive elements.
- Mobile (React Native) has its own safe-area behavior — use the tokens
  in `apps/mobile/`, not web-only `env(safe-area-inset-*)`.

### Radius

Kilo defines a radius scale:

| Token         | Value                       | Use                           |
| ------------- | --------------------------- | ----------------------------- |
| `--radius`    | `0.625rem`                  | Base                          |
| `--radius-sm` | `calc(var(--radius) - 4px)` | Tight inline chips            |
| `--radius-md` | `calc(var(--radius) - 2px)` | Buttons, inputs               |
| `--radius-lg` | `var(--radius)`             | Popovers, medium containers   |
| `--radius-xl` | `calc(var(--radius) + 4px)` | Cards, dialogs                |
| (full)        | `rounded-full`              | Badges, avatars, status pills |

Do not introduce new radius values.

### Hierarchy

- **Never nest a Card inside a Card.** If you need sub-grouping, use
  dividers, spacing, headings, or muted backgrounds — not another card.
- Use Kilo's sidebar tokens for sidebar-adjacent surfaces; don't hand-paint
  a second sidebar.
- Use spacing + typography to build hierarchy before reaching for shadows.
  Dark-mode depth comes from lighter surfaces, not shadows.

### Absolute rejects in Kilo UI

- Arbitrary spacing values outside Tailwind's scale.
- Nested cards.
- Uniform padding everywhere (variety creates rhythm).
- Hand-drawn z-index values like `z-[9999]`. Use semantic layering
  (`z-10` for sticky, Radix overlays for modals/menus — Radix handles
  stacking).
- Reintroducing one-off popover/tooltip/drawer positioning when Radix
  primitives already exist in `apps/web/src/components/ui/`.

---

## Spacing Systems

### Use 4pt Base

4pt systems give you 12px between 8 and 16. Tailwind's scale is 4pt-aligned;
use it. Name tokens semantically (`--space-sm`, `--space-lg`), not by value
(`--spacing-8`). In Kilo this usually means Tailwind utilities.

## Grid Systems

### The Self-Adjusting Grid

Use `repeat(auto-fit, minmax(280px, 1fr))` for responsive grids without
breakpoints. Columns are at least 280px, as many as fit per row, leftovers
stretch.

For complex layouts, use named `grid-template-areas` and redefine at
breakpoints. Kilo's app shell already uses sidebar + content layouts with
`sidebar-*` tokens; reuse those structural utilities before building new
ones.

## Visual Hierarchy

### The Squint Test

Blur your eyes or screenshot + blur. Can you still identify:

- The most important element?
- The second most important?
- Clear groupings?

If everything looks the same weight blurred, you have a hierarchy problem.

### Hierarchy Through Multiple Dimensions

Do not rely on size alone. Combine:

| Tool         | Strong hierarchy         | Weak hierarchy    |
| ------------ | ------------------------ | ----------------- |
| **Size**     | 3:1 ratio or more        | <2:1 ratio        |
| **Weight**   | Bold vs Regular          | Medium vs Regular |
| **Color**    | High contrast            | Similar tones     |
| **Position** | Top / left (primary)     | Bottom / right    |
| **Space**    | Surrounded by whitespace | Crowded           |

The best hierarchy uses 2–3 dimensions at once: a heading that's larger,
bolder, AND has more space above it.

### Cards Are Not Required

Cards are overused. Spacing and alignment create visual grouping naturally.
Use cards only when:

- Content is truly distinct and actionable.
- Items need visual comparison in a grid.
- Content needs clear interaction boundaries.

**Never nest cards inside cards.** Use spacing, typography, and subtle
dividers for hierarchy within a card.

## Container Queries

Viewport queries are for page layouts. **Container queries are for
components:**

```css
.card-container {
  container-type: inline-size;
}

.card {
  display: grid;
  gap: var(--space-md);
}

/* Card layout changes based on its container, not the viewport */
@container (min-width: 400px) {
  .card {
    grid-template-columns: 120px 1fr;
  }
}
```

A card in a narrow sidebar stays compact while the same card in a main
content area expands — automatically, no viewport hacks.

## Optical Adjustments

Text at `margin-left: 0` looks indented due to letterform whitespace; use
negative margin (`-0.05em`) to optically align. Geometrically centered
icons often look off-center; play icons shift right, arrows shift toward
their direction.

### Touch Targets vs Visual Size

Buttons can look small but need large touch targets (44px minimum). Use
padding or pseudo-elements:

```css
.icon-button {
  width: 24px;
  height: 24px;
  position: relative;
}

.icon-button::before {
  content: '';
  position: absolute;
  inset: -10px;
}
```

In Kilo, `h-9 w-9` icon buttons (`button.tsx` `size: "icon"`) sit just
below the 44px touch target. On mobile-facing surfaces, stretch the tap
area via padding or `::before`, not by enlarging the visual control.

## Depth & Elevation

Create semantic z-index scales (`dropdown → sticky → modal-backdrop →
modal → toast → tooltip`) rather than arbitrary numbers. In Kilo, Radix
primitives already manage stacking for overlays — don't fight them with
`z-[99999]`.

Shadows should be subtle — if you can clearly see them, they're too
strong. Dark-mode Kilo depth comes from surface elevation, not shadow.

---

**Avoid**: Arbitrary spacing values outside your scale. Making all spacing
equal (variety creates hierarchy). Creating hierarchy through size alone.
Nested cards. Rewriting positioning for overlays when Radix already solves it.
