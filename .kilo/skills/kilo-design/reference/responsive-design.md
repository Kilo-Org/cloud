# Responsive Design

> Adapted from Impeccable's `responsive-design.md` (Apache 2.0). See
> `NOTICE.md` for attribution and upstream source.

## Kilo application

Kilo has two parallel responsive surfaces:

1. **Web** (`apps/web/`) — Next.js + Tailwind v4. Responsive tooling is
   Tailwind breakpoints + container queries + `env(safe-area-inset-*)`.
2. **Mobile** (`apps/mobile/`) — React Native + NativeWind. Tailwind
   breakpoints do **not** map to RN components the same way; use the
   device conventions already in that app.

### Kilo-specific rules

- **Design mobile-first** for web flows that appear on both marketing
  and the app shell. Add complexity at `md:` / `lg:` / `xl:` breakpoints,
  not the other way around.
- **Do not rely on hover for required functionality.** Hover is
  supplementary. Touch users can't use it.
- **Cards and forms should reflow**, not clip. Long labels, long email
  addresses, long plan names are the norm, not the edge case.
- **Sidebar rules.** The app shell sidebar has its own mobile behavior
  via `@/components/ui/sidebar`. Don't reinvent mobile nav — wrap into
  the existing sidebar state or use `Sheet` from shadcn.
- **Respect safe areas** on mobile web (iPhone notches, rounded corners).
  Use `max(…, env(safe-area-inset-*))` on fixed bottom/top bars.
- **Test at least three widths** for any visual change:
  - A narrow mobile viewport (~375px).
  - A tablet or narrow laptop (~768–1024px).
  - A wide desktop (~1440px+).
- **React Native + NativeWind caveat:** opacity modifiers (`bg-card/40`)
  do not work on CSS-variable theme colors. Verify with the component in
  `apps/mobile/` before assuming a utility composes the same way it does
  on web.

### Absolute rejects in Kilo UI

- Hover-only required actions.
- Fixed-pixel widths that break at mobile widths without reflow.
- Device-user-agent sniffing instead of feature queries.
- Separate mobile/desktop component trees built from scratch when a
  shared responsive component would work.
- Hiding content on mobile (`hidden md:block`) just because the layout
  is inconvenient. If information matters at desktop, it matters on
  mobile — reshape it.

---

## Mobile-First: Write It Right

Start with base styles for mobile, use `min-width` queries to layer
complexity. Desktop-first (`max-width`) means mobile loads unnecessary
styles first. In Tailwind this is the default behavior: unprefixed
utilities apply at the smallest viewport, and `md:`, `lg:`, `xl:` add
complexity upward.

## Breakpoints: Content-Driven

Don't chase device sizes — let content tell you where to break. Start
narrow, stretch until the design breaks, and add a breakpoint there.
Three breakpoints usually suffice (the Tailwind `md` 768, `lg` 1024,
`xl` 1280 defaults work). Use `clamp()` for fluid values without
breakpoints — but only on marketing/brand pages (see `typography.md`).

## Detect Input Method, Not Just Screen Size

Screen size doesn't tell you input method. A laptop with a touchscreen,
a tablet with a keyboard — use pointer and hover queries:

```css
/* Fine pointer (mouse, trackpad) */
@media (pointer: fine) {
  .button {
    padding: 8px 16px;
  }
}

/* Coarse pointer (touch, stylus) */
@media (pointer: coarse) {
  .button {
    padding: 12px 20px;
  } /* Larger touch target */
}

/* Device supports hover */
@media (hover: hover) {
  .card:hover {
    transform: translateY(-2px);
  }
}

/* Device doesn't support hover (touch) */
@media (hover: none) {
  /* No hover state — use active instead */
}
```

**Critical**: Don't rely on hover for functionality. Touch users can't
hover. In Tailwind, `hover:` + `@media (hover: hover)` wrapping via the
`hocus` pattern / `@custom-variant` is fine, but design the no-hover
path first.

## Safe Areas: Handle the Notch

Modern phones have notches, rounded corners, and home indicators. Use
`env()`:

```css
body {
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}

/* With fallback */
.footer {
  padding-bottom: max(1rem, env(safe-area-inset-bottom));
}
```

Enable `viewport-fit` in your meta tag:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

`apps/web/src/app/layout.tsx` sets a Next.js `viewport` object — align
additions there, not via manual meta tags.

## Responsive Images: Get It Right

### srcset with Width Descriptors

```html
<img
  src="hero-800.jpg"
  srcset="hero-400.jpg 400w, hero-800.jpg 800w, hero-1200.jpg 1200w"
  sizes="(max-width: 768px) 100vw, 50vw"
  alt="Hero image"
/>
```

How it works:

- `srcset` lists available images with actual widths (`w` descriptors).
- `sizes` tells the browser how wide the image will display.
- Browser picks the best file based on viewport width AND device pixel
  ratio.

In Kilo, prefer Next.js `<Image>` — it produces correct srcset, sizes,
and lazy loading automatically.

### Picture Element for Art Direction

When you need different crops/compositions (not just resolutions):

```html
<picture>
  <source media="(min-width: 768px)" srcset="wide.jpg" />
  <source media="(max-width: 767px)" srcset="tall.jpg" />
  <img src="fallback.jpg" alt="..." />
</picture>
```

## Layout Adaptation Patterns

- **Navigation.** Three stages — hamburger/sheet on mobile, horizontal
  compact on tablet, full with labels on desktop. In Kilo, the
  `Sidebar` primitive + `Sheet` covers this.
- **Tables.** Transform to cards on mobile using `display: block` and
  `data-label` attributes. For simple tables, horizontal scroll with a
  fade mask is acceptable — Kilo already uses this pattern in a few
  billing/admin views.
- **Progressive disclosure.** Use `<details>/<summary>` or shadcn's
  `Accordion` / `Collapsible` for content that can collapse on mobile.

## Testing: Don't Trust DevTools Alone

DevTools device emulation is useful for layout but misses:

- Actual touch interactions.
- Real CPU/memory constraints.
- Network latency patterns.
- Font rendering differences.
- Browser chrome / keyboard appearances.

Test on at least one real iPhone, one real Android, a tablet if relevant.
Cheap Android phones reveal performance issues you'll never see on
simulators. For Kilo's mobile app, use a dev build / dev client on a real
device before shipping significant UI changes. Do not use Expo Go; the app
does not support it.

---

**Avoid**: Desktop-first design. Device detection instead of feature
detection. Separate mobile/desktop codebases grown by accident. Ignoring
tablet and landscape. Assuming all mobile devices are powerful.
Mobile-hostile `hidden` instead of reshaping content.
