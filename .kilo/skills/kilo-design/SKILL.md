---
name: kilo-design
description: Use when designing, reviewing, polishing, adapting, or implementing Kilo Code frontend UI. Applies the DESIGN.md token contract, Kilo brand rules, shadcn/Radix component conventions, exact color tokens, Inter/Roboto Mono/JetBrains Mono typography, compact product rhythm, restrained motion, and Kilo voice guidelines. Triggers on web app screens (apps/web), Storybook components, React Native mobile surfaces (apps/mobile), marketing/landing pages, onboarding, empty states, forms, dialogs, dashboards, billing, sidebar, theming, accessibility, and visual QA. Triggers on terms like "design", "redesign", "polish", "critique", "audit", "typeset", "typography", "fonts", "color", "palette", "brand", "spacing", "layout", "grid", "motion", "animate", "transitions", "interaction", "forms", "focus", "responsive", "mobile", "breakpoints", "UX copy", "microcopy", "error states", "empty states", "on-brand", "Kilo voice". Not for backend-only work.
license: Apache 2.0 derivative of pbakaus/impeccable, adapted for Kilo Code. See NOTICE.md.
---

# Kilo Design

Design guidance for the Kilo Code frontend. Use this skill whenever the
task involves how something looks, how it behaves, how it reads, or how
it adapts.

## Canonical rule: design contract first

Root `DESIGN.md` is the source of truth for token names, exact values, domain mappings, typography roles, radius, and spacing. `reference/kilo-brand.md` explains how to apply that contract. When guidance, existing CSS, or a component conflicts with `DESIGN.md`, treat it as implementation drift rather than precedent.

Load `DESIGN.md` and `reference/kilo-brand.md` on every invocation before picking tokens, typography, layout, or motion. Together they define:

- Kilo's dark-first web theme and six-role surface ladder.
- Brand yellow-green `primary` token as the primary CTA color, used once per surface.
- Fixed status-domain mappings, syntax colors, and diff colors.
- Inter / Roboto Mono typography roles and editor-only JetBrains Mono usage.
- Spacing, radius, component, and motion conventions.
- Kilo-specific anti-patterns to reject on sight.

## Register

Identify the register of the surface before designing:

- **Product UI** — web app, dashboards, settings, billing, admin,
  Storybook components, mobile app screens. Calm, compact,
  task-oriented. Fixed type scale. Restrained accent use.
- **Brand / Marketing** — landing pages, docs, pricing, hero surfaces,
  campaign moments. More visual expression permitted (hero type,
  animation, committed color, imagery) while still using Kilo tokens.

When unclear, treat the surface as Product UI.

## Routing

Given a user prompt that invokes this skill:

1. Always load root `DESIGN.md`, then `reference/kilo-brand.md`.
2. Identify the dominant concern from the prompt and load the matching
   reference(s):

| Prompt signal | Load |
|---|---|
| typography, fonts, type scale, hierarchy, readability | `reference/typography.md` |
| color, palette, contrast, accent, theming, gradient, a11y colors | `reference/color-and-contrast.md` |
| spacing, layout, grid, rhythm, padding, alignment, cards | `reference/spatial-design.md` |
| motion, animation, transitions, easing, micro-interactions | `reference/motion-design.md` |
| forms, focus, hover, states, dialog, dropdown, keyboard nav | `reference/interaction-design.md` |
| responsive, mobile, breakpoints, touch, tablet, adapt | `reference/responsive-design.md` |
| copy, microcopy, error messages, labels, empty state copy | `reference/ux-writing.md` |
| audit / critique / polish / general redesign | all references above |

3. If the prompt targets a specific file, component, or route, **read
   that file first** before proposing or making changes. Do not guess
   what the current code looks like.

4. When the user asks for implementation, produce code; when the user
   asks for a review, produce a diff-ready report with file paths,
   line references, specific token/utility suggestions, and a short
   rationale per finding.

## Operating rules

Follow these on every task:

1. **Inspect before editing.** Open root `DESIGN.md`, `apps/web/src/app/globals.css`, the relevant component under `apps/web/src/components/`, and any Storybook story before proposing visual changes.
2. **Prefer compliant tokens, utilities, and components.** Reuse existing implementation only when it maps to `DESIGN.md`. If it differs, report or fix the drift instead of copying it.
3. **Do not rename or restructure the shadcn UI layer** unless the user
   explicitly asks for a design-system refactor.
4. **Use the `primary` token for primary CTAs.** The product primary is the
   Kilo brand yellow-green. Blue is reserved for links and legacy drift
   that should be migrated when touched.
5. **Do not add new motion libraries.** `motion/react` and
   `tw-animate-css` are already available.
6. **Respect `prefers-reduced-motion`** on any motion change beyond
   trivial opacity/transform hover feedback.
7. **Design all interactive states:** default, hover, focus-visible,
   active, disabled, loading, error, success — whichever are relevant.
8. **Check responsive behavior** for any visual change: mobile (~375px),
   tablet/laptop (~768–1024px), wide desktop (~1440px+).
9. **Use Kilo voice** (see `reference/ux-writing.md`) for any copy you
   add or rewrite.
10. **Surface conflicts.** If the user's ask conflicts with `DESIGN.md`, raise the conflict and propose a path forward before silently overriding the design contract.

## Implementing code changes

When producing code:

- Use Tailwind utilities that map to semantic tokens before hex: `bg-background`, `text-foreground`, `border-border`, `bg-primary`, and `text-primary-foreground` for broad semantics; `bg-surface-inset`, `bg-surface-raised`, `bg-surface-overlay`, `bg-surface-hover`, and `bg-surface-selected` for exact surface roles; syntax, diff, and status utilities for those domains.
- Extend `cva` variants in existing `ui/` primitives rather than cloning.
- Icons: `lucide-react`, typically `size-4`, inheriting `currentColor`; use `size-icon-sm` for canonical 14px compact/status icons.
- Add `aria-label` to icon-only buttons.
- Use Radix + shadcn wrappers for overlays (dialog, dropdown, popover,
  tooltip, sheet) — do not hand-roll positioning.
- Match compact rhythm: `h-8` / `h-control-default` / `h-10` controls, `h-14` topbar, and `p-6` cards. Use `h-control-touch` or `size-control-touch` where touch targets need 44px.
- Prefer `gap-*` over ad-hoc margins.

## Running a design review

When producing a review:

- Reference code locations as `file_path:line_number`.
- Group findings by severity: **Blocker** (accessibility failure, brand
  violation, broken behavior), **Improvement** (inconsistency,
  refinement opportunity), **Nit** (optional polish).
- Propose specific Tailwind utilities, tokens, or components for each
  fix.
- Call out responsive, reduced-motion, keyboard, and screen-reader gaps
  explicitly — they're the most commonly missed.

## Mobile surfaces

`apps/mobile/` uses React Native + NativeWind, with its own shadcn-style
setup in `apps/mobile/src/global.css` and `apps/mobile/components.json`.
Web Tailwind patterns do not always translate:

- CSS-variable theme colors do not compose with Tailwind opacity
  modifiers (`/40`) in NativeWind.
- `env(safe-area-inset-*)` is web-only; mobile uses react-native safe
  area tooling.
- Hover states do not apply. Design the `pressed` state instead.

Consult `apps/mobile/AGENTS.md` (if present) and existing components
before styling.

## Non-goals

This skill is intentionally scoped. It does **not**:

- Run automated anti-pattern scans.
- Run or expose Impeccable's "live mode."
- Generate or redefine root `DESIGN.md`; it must still enforce the existing contract.
- Migrate every legacy hardcoded blue CTA unless the owning surface is being updated. Broad migrations belong in separate design-system-scoped PRs.

## Reference map

| File | What it covers |
|---|---|
| Root `DESIGN.md` | Canonical token contract and application rules. Load first, always. |
| `reference/kilo-brand.md` | Kilo-specific implementation guidance. Load after `DESIGN.md`, always. |
| `reference/typography.md` | Inter/mono usage, hierarchy, tabular nums, OpenType polish. |
| `reference/color-and-contrast.md` | Exact palette, brand vs action color, dark-first contrast rules. |
| `reference/spatial-design.md` | Spacing, radius scale, grid patterns, optical alignment. |
| `reference/motion-design.md` | Durations, easings, reduced motion, Kilo brand flourishes. |
| `reference/interaction-design.md` | Focus, forms, overlays, destructive actions, keyboard nav. |
| `reference/responsive-design.md` | Breakpoints, input-method queries, safe areas, images. |
| `reference/ux-writing.md` | Kilo voice, labels, error copy, empty states, i18n. |

See `NOTICE.md` for Impeccable attribution and licensing.
