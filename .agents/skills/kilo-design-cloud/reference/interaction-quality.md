# Interaction Quality

This reference is for Cloud UI tasks where behavior, accessibility, responsive layout, forms, overlays, touch, or motion are part of the change.

## Load When

- The task touches forms, inputs, validation, focus, keyboard behavior, overlays, dialogs, dropdowns, popovers, tabs, tooltips, or sheets.
- The task changes responsive layout, touch behavior, loading states, disabled states, error states, success states, or animation.
- A review asks whether a surface feels usable, shippable, accessible, or polished.

## Interactive States

Changed interactive controls account for the states they can enter: default, hover, focus-visible, active, disabled, loading, error, and success.

- Hover is never the only way to reach a required action.
- Disabled and loading states preserve layout and explain blocked progress when the reason is not obvious.
- Focus-visible states use the existing ring/token system. Do not remove browser or Radix focus behavior to make a design look cleaner.
- Icon-only controls need an `aria-label` that names the action.

## Forms

- Use visible labels. Placeholder text is not a label.
- Put field errors next to the field and connect help or error text with `aria-describedby` where the component supports it.
- Validate on blur for ordinary fields. Password strength can update while typing.
- Use the correct input type and autocomplete attributes for common fields.
- Error copy says what failed, why if knowable, and what to try next.

## Overlays

- Use existing shadcn/Radix wrappers for dialogs, dropdowns, popovers, selects, tabs, tooltips, and sheets.
- Do not hand-roll positioning, focus traps, Escape behavior, outside-click behavior, or arrow-key navigation.
- Preserve Radix keyboard semantics when styling trigger, content, and item states.
- Destructive confirmations are for irreversible or high-stakes actions. Prefer undoable feedback for reversible actions.

## Responsive And Touch

- Check at least 375px, 768-1024px, and 1440px+ when the task changes layout.
- Long workspace names, emails, plan names, token labels, and billing values must wrap, truncate, or collapse intentionally.
- Cards, forms, and tables reflow before hiding important controls.
- Touch targets should reach 44px even when the visual control is compact.
- Use the existing Cloud sidebar and navigation behavior before inventing a mobile-specific nav.

## Motion

- Product motion is short and functional: 100-200ms for direct feedback, 200-300ms for larger state changes.
- Prefer opacity and transform. Do not casually animate width, height, top, left, or grid placement.
- Respect `prefers-reduced-motion` for anything beyond trivial hover or focus feedback.
- Do not add bouncy, elastic, or playful easing to infrastructure UI.
- Do not hand-animate Radix overlays when the existing primitive already handles entry and exit behavior.

## Layout Discipline

- Use 4px-aligned spacing and `gap-*` before ad hoc margins.
- Do not nest cards inside cards. Use spacing, headings, dividers, or muted sections to separate related content.
- Use surface roles for dark-mode depth, not heavy shadows.
- Use tabular numbers for billing, usage, quota, and table values.
