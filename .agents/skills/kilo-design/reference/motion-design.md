# Motion Design

> Adapted from Impeccable's `motion-design.md` (Apache 2.0). See
> `NOTICE.md` for attribution and upstream source.

## Kilo application

Kilo motion is **purposeful and subtle** in product UI, with occasional
**branded flourishes** at specific hero/logo moments.

### Libraries and tokens

- `motion/react` (formerly `framer-motion`) is already in use.
  `HeaderLogo.tsx` is the canonical example of a branded interaction.
- `tw-animate-css` is imported in `apps/web/src/app/globals.css` for
  small utility animations.
- Preferred easing: `--ease-out-strong` → `cubic-bezier(0.23, 1, 0.32, 1)`.
  It is defined as a Tailwind token via `@theme inline`.
- Named brand keyframes already live in `globals.css`:
  `pulse-glow` / `animate-pulse-once`, `pulse-opacity`,
  `pulse-opacity-dim`. Reuse these instead of inventing new glow/pulse
  effects.
- Brand accent color for glow: `rgba(237, 255, 0, ...)` mirrors
  `--brand-primary`.

### Kilo-specific motion rules

- **Product UI should feel calm.** Default to opacity/transform fades
  (100–200ms) for hover, focus, and state changes. Resist adding motion
  to every element.
- **Brand moments are opt-in.** The logo hover rotation, the pulse-glow
  CTA, Lottie logo swap — these are branded punctuation, not templates
  to copy elsewhere.
- **Never animate layout properties casually** (`width`, `height`, `top`,
  `left`, `margin`). Use `transform`, `opacity`, `filter` or layout
  libraries (Framer Motion's `layout` prop, FLIP, `grid-template-rows`).
- **Respect `prefers-reduced-motion`.** For anything more than a small
  hover transform, provide a reduced fallback. Browsers with
  reduced-motion preference get functional behavior only.
- **No bouncy/elastic curves** on product UI. Ease-out exponential
  (`--ease-out-strong`) and short durations are the house style.
- **Do not animate modals/dropdowns by hand.** Radix + shadcn already
  ship well-tuned enter/exit transitions; configure them with
  Tailwind's `data-[state=open]` utilities.

### Durations

| Duration  | Use                                  | Examples                               |
| --------- | ------------------------------------ | -------------------------------------- |
| 100–150ms | Instant feedback                     | Button press, toggle, color shift      |
| 200–300ms | State changes                        | Menu open, tooltip, hover, focus bloom |
| 300–500ms | Layout changes                       | Accordion, drawer open, sheet open     |
| 500–800ms | Entrance animations (brand surfaces) | Hero reveal, first-paint choreography  |

Exit animations are faster than entrances (≈75% of enter duration).

### Absolute rejects in Kilo UI

- Animated gradients on product surfaces.
- Long (≥ 800ms) transitions in app UIs.
- `ease` (the CSS default) as the only easing on important motion.
- Bounce/elastic on buttons.
- Hover-only affordances on touch-capable surfaces (see
  `responsive-design.md`).
- Animating `will-change` globally or preemptively.

---

## Duration: The 100/300/500 Rule

Timing matters more than easing. These durations feel right for most UI:

| Duration  | Use                 | Examples                           |
| --------- | ------------------- | ---------------------------------- |
| 100–150ms | Instant feedback    | Button press, toggle, color change |
| 200–300ms | State changes       | Menu open, tooltip, hover states   |
| 300–500ms | Layout changes      | Accordion, modal, drawer           |
| 500–800ms | Entrance animations | Page load, hero reveals            |

Exit animations are faster than entrances — use ~75% of enter duration.

## Easing: Pick the Right Curve

Don't use `ease` — it's a compromise that's rarely optimal. Instead:

| Curve           | Use for                      | CSS                              |
| --------------- | ---------------------------- | -------------------------------- |
| **ease-out**    | Elements entering            | `cubic-bezier(0.16, 1, 0.3, 1)`  |
| **ease-in**     | Elements leaving             | `cubic-bezier(0.7, 0, 0.84, 0)`  |
| **ease-in-out** | State toggles (there → back) | `cubic-bezier(0.65, 0, 0.35, 1)` |

For micro-interactions, exponential curves feel natural (friction,
deceleration):

```css
/* Quart out — smooth, refined (Kilo's --ease-out-strong is close) */
--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);

/* Quint out — slightly more dramatic */
--ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);

/* Expo out — snappy, confident */
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
```

**Avoid bounce and elastic curves.** They feel tacky and amateurish. Real
objects don't bounce when they stop — they decelerate smoothly.

## Premium Motion Materials

Transform and opacity are reliable defaults, not the whole palette.
Premium interfaces often need atmospheric properties: blur reveals,
backdrop-filter panels, saturation or brightness shifts, shadow bloom,
SVG filters, masks, clip paths, gradient-position movement, and variable
font or shader-driven effects.

Use the right material for the effect:

- **Transform / opacity** — movement, press feedback, simple reveals,
  list choreography.
- **Blur / filter / backdrop-filter** — focus pulls, depth, glass/lens
  effects, softened entrances, atmospheric transitions.
- **Clip path / masks** — wipes, reveals, editorial cropping, product-
  like transitions.
- **Shadow / glow / color filters** — energy, affordance, focus, warmth,
  active state.
- **Grid-template rows or FLIP-style transforms** — expanding and
  reflowing layout without animating `height` directly.

Avoid animating layout-driving properties casually (`width`, `height`,
`top`, `left`, margins). Keep expensive effects bounded to small or
isolated areas, and verify in-browser that the result is smooth on
target viewports.

## Staggered Animations

Use CSS custom properties for cleaner stagger:
`animation-delay: calc(var(--i, 0) * 50ms)` with `style="--i: 0"` on each
item. **Cap total stagger time** — 10 items × 50ms = 500ms total. For
many items, reduce per-item delay or cap staggered count.

## Reduced Motion

Not optional. Vestibular disorders affect ~35% of adults over 40.

```css
/* Define animations normally */
.card {
  animation: slide-up 500ms ease-out;
}

/* Provide alternative for reduced motion */
@media (prefers-reduced-motion: reduce) {
  .card {
    animation: fade-in 200ms ease-out;
  }
}

/* Or disable entirely */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

Preserve functional animations: progress bars, loading spinners (slowed),
focus indicators.

## Perceived Performance

Nobody cares how fast your site is — only how fast it feels.

- **80ms threshold.** Anything under ~80ms feels instant. Target this
  for micro-interactions.
- **Active vs passive time.** Passive waiting (staring at a spinner)
  feels longer than active engagement. Preemptive transitions, early
  completion, and optimistic UI shift the balance.
- **Easing affects perceived duration.** Ease-in toward a task's end
  compresses perceived time.
- **Caution.** Instantaneous responses can decrease perceived value
  for complex operations — a brief delay can signal "real work."

## Performance

Don't use `will-change` preemptively — only when animation is imminent
(`:hover`, `.animating`). For scroll-triggered animations, use
Intersection Observer, and `unobserve()` after animating once. Create
motion tokens for consistency (Kilo already has `--ease-out-strong`).

---

**Avoid**: Animating everything (animation fatigue is real). >500ms for
UI feedback. Ignoring `prefers-reduced-motion`. Using animation to hide
slow loading. Reinventing Radix primitives' transitions.
