# Interaction Design

> Adapted from Impeccable's `interaction-design.md` (Apache 2.0). See
> `NOTICE.md` for attribution and upstream source.

## Kilo application

Kilo is dark-first and relies on **shadcn/ui + Radix**. Before building
any interactive control from scratch, check these locations first:

- `apps/web/src/components/ui/` — shadcn primitives (button, input,
  dialog, dropdown-menu, select, tabs, tooltip, sheet, popover,
  skeleton, table, sidebar, badge).
- `apps/web/src/components/` — higher-level composed components.
- `apps/web/components.json` — shadcn config (style `new-york`, neutral
  base, lucide icons).

### Kilo-specific rules

- **Use Radix + shadcn for overlays.** Dialog, dropdown, popover, tooltip,
  sheet, and select already handle focus trapping, escape-to-close,
  outside-click dismissal, ARIA roles, and stacking. Do not hand-roll.
- **Focus rings.** Use `focus-visible:ring-ring` (semantic) or the
  explicit brand ring for branded controls (see `HeaderLogo.tsx` which
  uses `focus:ring-brand-primary focus:ring-3`). Never strip the ring
  without a replacement.
- **Button variants are authoritative.** Use the semantic `primary` token /
  primary variant for the single yellow CTA on a surface,
  `variant="destructive"` for red destructive actions, `variant="outline"`
  or `variant="secondary"` for secondary actions, and `variant="ghost"` for
  bare actions. Don't invent new variants per feature.
- **Forms use visible labels.** Placeholders are not labels. Pair inputs
  with `<Label>` (shadcn) and use `aria-describedby` for help/error text.
- **Validate on blur**, not every keystroke (password strength is an
  exception).
- **Destructive actions prefer undo toasts** over confirmation dialogs
  for reversible operations. Reserve confirm dialogs for truly
  irreversible actions (account deletion, workspace deletion, bulk
  destructive ops).
- **Icon-only buttons need `aria-label`.** Lucide icons inherit color —
  don't hand-color them unless a variant demands it.
- **Touch targets:** visual control can be `h-8`/`h-9`, but the tap
  target should reach 44px on touch surfaces via padding or `::before`
  (see `spatial-design.md`).

### Absolute rejects in Kilo UI

- Custom focus-ring removal without a replacement.
- Reimplementing dialog, dropdown, tooltip, select, popover, or sheet
  positioning instead of using the shadcn wrappers.
- Placeholder-as-label in forms.
- Generic "Submit" / "OK" button labels (see `ux-writing.md`).
- Confirmation dialog for "are you sure you want to save" style prompts.
- Custom keyboard handlers that override native form submit / Escape /
  arrow navigation on shadcn components.

---

## The Eight Interactive States

Every interactive element needs these states designed:

| State        | When                          | Visual treatment            |
| ------------ | ----------------------------- | --------------------------- |
| **Default**  | At rest                       | Base styling                |
| **Hover**    | Pointer over (not touch)      | Subtle lift, color shift    |
| **Focus**    | Keyboard / programmatic focus | Visible ring (see below)    |
| **Active**   | Being pressed                 | Pressed in, darker          |
| **Disabled** | Not interactive               | Reduced opacity, no pointer |
| **Loading**  | Processing                    | Spinner, skeleton           |
| **Error**    | Invalid state                 | Red border, icon, message   |
| **Success**  | Completed                     | Green check, confirmation   |

Common miss: designing hover without focus, or vice versa. Keyboard users
never see hover states.

## Focus Rings: Do Them Right

Never `outline: none` without a replacement. Use `:focus-visible` to show
focus only for keyboard users:

```css
/* Hide focus ring for mouse/touch */
button:focus {
  outline: none;
}

/* Show focus ring for keyboard */
button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
```

In Kilo:

- Default shadcn primitives already do this correctly
  (`focus-visible:ring-ring/50`, `focus-visible:ring-[3px]`).
- Branded interactive moments may use `focus:ring-brand-primary`.

Focus ring design:

- High contrast (3:1 minimum against adjacent colors).
- 2–3px thick.
- Offset from element (not inside it).
- Consistent across all interactive elements of the same type.

## Form Design

- **Placeholders aren't labels** — they disappear on input. Always use
  visible `<Label>`.
- **Validate on blur**, not on every keystroke (password strength is an
  exception).
- **Errors go below the field** with `aria-describedby` connecting them.
- **Autocomplete is free accessibility.** Set `autocomplete="email"`,
  `autocomplete="current-password"`, `autocomplete="one-time-code"`,
  etc. — browsers fill in correctly and screen readers benefit.
- **Input types matter.** `type="email"`, `type="tel"`, `type="number"`,
  `type="url"` trigger appropriate mobile keyboards.

## Loading States

- **Optimistic updates.** Show success immediately, rollback on failure.
  Use for low-stakes actions (toggles, likes, saves in a session). Never
  for payments or destructive operations.
- **Skeleton screens > spinners.** They preview content shape and feel
  faster than generic spinners. Kilo ships a `Skeleton` primitive.
- **Set expectations.** For long waits, say "This usually takes 30
  seconds" instead of an unbounded spinner.

## Modals: The Inert Approach

Focus trapping in modals used to require complex JavaScript. Modern
options:

```html
<!-- When modal is open, make everything else inert -->
<main inert>
  <!-- Content behind modal can't be focused or clicked -->
</main>
<dialog open>
  <h2>Modal Title</h2>
</dialog>
```

Or use the native `<dialog>` element:

```ts
const dialog = document.querySelector('dialog');
dialog.showModal(); // Opens with focus trap, closes on Escape
```

In Kilo, **use `Dialog` from `@/components/ui/dialog`** — Radix already
handles this correctly.

## The Popover API

For tooltips, dropdowns, and non-modal overlays, native popovers work:

```html
<button popovertarget="menu">Open menu</button>
<div id="menu" popover>
  <button>Option 1</button>
  <button>Option 2</button>
</div>
```

**In Kilo**, use `@/components/ui/popover`, `@/components/ui/dropdown-menu`,
or `@/components/ui/tooltip` — those already provide light-dismiss,
correct stacking, and accessibility.

## Dropdown & Overlay Positioning

Dropdowns rendered with `position: absolute` inside a container that has
`overflow: hidden` or `overflow: auto` will be clipped. The single most
common dropdown bug in generated code.

### CSS Anchor Positioning

Modern solution ties an overlay to its trigger without JavaScript:

```css
.trigger {
  anchor-name: --menu-trigger;
}

.dropdown {
  position: fixed;
  position-anchor: --menu-trigger;
  position-area: block-end span-inline-end;
  margin-top: 4px;
}

@position-try --flip-above {
  position-area: block-start span-inline-end;
  margin-bottom: 4px;
}
```

`position: fixed` escapes overflow clipping. `@position-try` handles
viewport edges. Browser support: Chrome 125+, Edge 125+ — use a fallback
for Firefox/Safari.

### Portal / Teleport Pattern

In component frameworks, render the dropdown at the document root and
position it from the trigger's `getBoundingClientRect()`. Radix and
shadcn already do this. Do not replace it with `position: absolute`
inside a scroll container.

### Anti-Patterns

- `position: absolute` inside `overflow: hidden` — the dropdown clips.
  Use `position: fixed` or the top layer.
- Arbitrary z-index like `z-index: 9999` — use a semantic z-index scale
  (dropdown 100 → sticky 200 → modal-backdrop 300 → modal 400 → toast
  500 → tooltip 600). In Kilo, Radix handles stacking; do not override
  its layers.
- Rendering dropdown markup inline without an escape hatch from the
  parent's stacking context. Use `popover`, a portal, or `position: fixed`.

## Destructive Actions: Undo > Confirm

Undo beats confirmation dialogs for reversible operations — users click
through confirmations mindlessly. Remove from UI immediately, show undo
toast, actually delete after the toast expires.

Use confirmation for:

- Truly irreversible actions (account deletion, workspace deletion).
- High-cost actions (paid plan downgrade).
- Bulk operations where the blast radius is unclear.

Confirmation labels name the action. `Delete workspace` / `Keep editing`,
not `Yes` / `No`.

## Keyboard Navigation Patterns

### Roving Tabindex

For component groups (tabs, menu items, radio groups), one item is
tabbable; arrow keys move within:

```html
<div role="tablist">
  <button role="tab" tabindex="0">Tab 1</button>
  <button role="tab" tabindex="-1">Tab 2</button>
  <button role="tab" tabindex="-1">Tab 3</button>
</div>
```

Arrow keys move `tabindex="0"` between items. Tab moves to the next
component entirely. In Kilo, `@/components/ui/tabs` already does this.

### Skip Links

Provide `<a href="#main-content">Skip to main content</a>` for keyboard
users to jump past navigation. Hide off-screen, show on focus.

## Gesture Discoverability

Swipe-to-delete and similar gestures are invisible. Hint at their
existence:

- **Partially reveal** — show the delete button peeking from the edge.
- **Onboarding** — coach marks on first use.
- **Alternative** — always provide a visible fallback (a menu with
  "Delete").

Don't rely on gestures as the only way to perform actions. In React
Native (`apps/mobile/`), use accessible gesture patterns from the
existing component library.

---

**Avoid**: Removing focus indicators without alternatives. Placeholder
text as labels. Touch targets <44×44px. Generic error messages. Custom
controls without ARIA / keyboard support. Reimplementing Radix primitives.
