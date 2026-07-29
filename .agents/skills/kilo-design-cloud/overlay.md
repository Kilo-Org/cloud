# Kilo Cloud Overlay

Cloud is the pilot product for Kilo's agent-consumable design system. It is a dense, dark-first infrastructure console built with Next.js, React, Tailwind, shadcn/ui, Radix, and `lucide-react`.

## Product Intent

- Help teams understand workspaces, billing, subscriptions, KiloClaw, and operational status without marketing noise.
- Stay compact and task-oriented. Cloud can be visually polished, but it should not feel like a landing page.
- Make one action obvious per surface. Surrounding actions should be secondary, ghost, outline, or links.

## Code Sources To Read First

| Concern | Cloud path |
|---|---|
| Base theme and Tailwind tokens | `apps/web/src/app/globals.css` |
| Font variables | `apps/web/src/app/layout.tsx` |
| shadcn config | `apps/web/components.json` |
| UI primitives | `apps/web/src/components/ui/*.tsx` |
| Legacy button drift | `apps/web/src/components/Button.tsx` |

## Token Mapping

Use semantic roles, not raw values:

| Role | Cloud token |
|---|---|
| Page background | `--background` / `bg-background` |
| Default text | `--foreground` / `text-foreground` |
| Raised surface | `--card`, `--popover` |
| Secondary surface | `--secondary`, `--muted`, `--accent` |
| Muted text | `--muted-foreground` |
| Primary action | `--primary` / `bg-primary` |
| Primary action text | `--primary-foreground` / `text-primary-foreground` |
| Border and focus | `--border`, `--input`, `--ring` |

Known drift: Cloud token adoption is tracked by `VVV-130`. Until that lands, recipe guidance should still point agents at semantic roles, not hardcoded replacements.

## Cloud Rhythm

- Controls are compact: `h-8`, `h-9`, `h-10`; icons are usually `size-4`.
- Cards and dialogs use existing shadcn primitives before custom containers.
- Prefer `gap-*` and grouped spacing over dividers between every row.
- Keep status color as small signals: badges, inline text, rings, or charts. Do not let status hues become the UI palette.
- Use Inter for UI and Roboto Mono for code, identifiers, token names, and tabular data.
- Treat focus, disabled, loading, error, and responsive states as part of the surface, not follow-up polish.

## Cloud Anti-Patterns

- Blue button fills as primary actions.
- Yellow-green applied to multiple unrelated controls.
- Equal-card dashboard grids when the task has one focal action.
- New component libraries or new design primitives when shadcn/Radix already exists.
- Marketing copy, fake slogans, avatars, decorative AI stars, glass panels, or gradient text inside product UI.
- Hover-only required actions, missing focus-visible states, or custom overlay behavior that bypasses Radix.
- Large implementation sweeps before the matching recipe exists.

## Current Coverage

Covered now:

- Primary actions.
- Tabs.

Known gaps:

- Status badges.
- Alerts and feedback banners.
- Dialogs and destructive confirmations.
- Sidebar/topbar chrome.
- Empty states.

When a gap appears in real work, use the nearest shipped code and report the missing recipe instead of adding broad rules.
