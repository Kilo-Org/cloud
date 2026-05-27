# Kilo Cloud Design

Design guidance for Kilo Cloud. Read this before making or reviewing UI changes in this repo.

Kilo Cloud is the dense, dark-first infra/admin surface for Kilo. It manages organizations, usage, billing, integrations, headless agent sessions, and developer operations. The interface should feel trustworthy, utilitarian, compact, and calm.

## Core Rules

1. Value creates hierarchy. Build product surfaces from a near-black canvas into slightly lighter cards and raised chrome.
2. Borders are white at low alpha. Prefer translucent white borders over solid gray strokes.
3. Yellow acts. The Kilo yellow-green is both brand and primary action. Use it sparingly, usually once per surface.
4. Greys carry the interface. Secondary actions, cards, tables, inputs, sidebars, and chrome should mostly stay neutral.
5. Status colors are semantic. Use status hues for state and badges, not decoration.
6. Copy is plain and concrete. Speak to developers in second person with direct nouns and actions.

## Colors

Use existing semantic tokens and Tailwind utilities before adding new values.

| Role | Value | Use |
|---|---|---|
| Background | `#121212` | App canvas |
| Surface | `#2B2B2B` | Cards, sidebar, dialogs |
| Raised surface | `#333333` | Popovers, menus, tooltips |
| Muted | `#3D3D3D` | Hovers, inactive tabs, secondary fills |
| Foreground | `#FAFAFA` | Primary text |
| Muted foreground | `#A3A3A3` | Secondary text, metadata |
| Subtle foreground | `#7A7A7A` | Disabled and tertiary text |
| Border | `#FFFFFF1A` | Default card/chrome border |
| Strong border | `#FFFFFF2E` | Inputs and focused chrome |
| Primary | `#EDFF00` | Main CTA and brand accent |
| Primary hover | `#D6E600` | Hover state for primary action |
| Primary foreground | `#1F1F1F` | Text on yellow primary |
| Link | `#3B82F6` | Inline links only |

Blue is a legacy inline link color. Do not use blue as a button background or section accent.

## Status Colors

Status badges use a translucent fill, matching ring, and brighter foreground text. Do not invent new hues unless the taxonomy genuinely needs one.

| Color | Domain |
|---|---|
| Blue | Cloud sessions, neutral default |
| Purple | VS Code extension |
| Zinc | CLI |
| Emerald | Slack |
| Orange | Agent Manager |
| Green | Success, new |
| Yellow | Warnings |
| Red | Destructive, errors |

Badge pattern: `bg-{color}-500/20 text-{color}-400 ring-1 ring-{color}-500/20`.

## Typography

- Use Inter for product UI.
- Use Roboto Mono or the product mono token for code, terminal output, dollar amounts, token counts, latency, timestamps, and IDs in dense data.
- Body text defaults to `14px / 1.5`.
- Page titles are compact and direct.
- Display type is reserved for onboarding and empty-state moments, not normal app chrome.
- Use sentence case for user-visible product UI.

## Layout

- Keep product interfaces dense but legible.
- Use the 4px spacing ladder.
- Prefer 8, 12, 16, and 24px for most layout decisions.
- Controls are compact: 36px regular, 32px small.
- Card padding is usually 24px.
- Table rows are usually 48px.
- Avoid page-level multi-column grids unless comparison itself is the task.
- Avoid card-in-card layouts unless a repeated item or modal genuinely needs framing.

## Shape

Use role-based radii:

| Radius | Use |
|---|---|
| `sm` | Controls, badges, menu items, inputs |
| `md` | Popovers and secondary surfaces |
| `lg` | Non-dashboard cards |
| `xl` | Primary dashboard cards |
| `full` | Avatars and true pills |

## Components

Buttons:

- Primary buttons use Kilo yellow-green with near-black text. Use one primary action per surface.
- Secondary buttons use dark-gray fills with white text.
- Ghost actions should stay visually quiet and work well in rows, prose, and dialogs.
- Destructive actions should appear inside confirm/destructive flows, not as casual listing-page CTAs.

Cards:

- Use surface background, low-alpha border, consistent radius, and consistent padding.
- Lift comes from value step plus border, not decorative shadows.

Inputs:

- Use translucent/dark fills, strong low-alpha borders, compact height, and clear focus states.
- Error states should change the border/state treatment and include helpful copy.

Dialogs:

- Keep confirms narrow and forms wider only when needed.
- Primary action belongs in the footer with clear secondary/cancel behavior.

Agent and terminal surfaces:

- Terminal or chat areas can use mono, streaming affordances, and restrained brand glow.
- Billing, admin, settings, and organization management screens should stay quieter.

## Copy

Use direct second-person language. Prefer concrete labels like:

- Create session
- Connect GitHub
- Update billing
- Invite member
- Cancel subscription

Avoid motivational or vague AI language. Good UI copy should make the next action obvious.

## Do

- Stack value, not color.
- Use the brand yellow for the primary action.
- Use translucent borders everywhere.
- Use mono for numbers in dense data.
- Use sentence case for user-facing product copy.
- Use existing tokens, components, and utilities before adding new primitives.

## Don't

- Do not use pure black or gradients for core app backgrounds.
- Do not put more than one yellow button on a normal product surface.
- Do not use blue as a button background.
- Do not introduce new status hues casually.
- Do not use emoji in product chrome.
- Do not add per-element decorative shadows to cards.
- Do not mix mono into prose for emphasis.
- Do not use title case for normal product UI.
