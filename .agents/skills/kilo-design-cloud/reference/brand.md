# Kilo Brand For Cloud

Kilo Cloud is dark-first, precise, calm, technical, and compact. It should feel like engineering infrastructure software, not a marketing page.

## Shared Defaults

- Dark-only surfaces: near-black canvas, raised charcoal panels, muted gray secondary text.
- Typography: Inter for UI, Roboto Mono for code and identifiers.
- Shape: compact radii, rounded controls, existing shadcn/Radix primitives.
- Motion: short and functional. Brand flourish is punctuation, not a default.
- Primary action: one semantic primary action per visible decision area.

## Brand Primary

`tokens.json` defines the source values:

```text
color.brand.primary = #F7F586
color.brand.foreground = #1F1F1F
```

In daily Cloud work, say `primary action token`, not `#F7F586`, unless editing token source or generated artifact docs.

In standalone generated HTML, define the semantic primary role from these values:

```text
--primary = #F7F586
--primary-foreground = #1F1F1F
```

## Product Signals

Kilo Cloud should be recognizable through product structure, not decorative branding.

- Use real Cloud nouns when relevant: workspace, team, agent run, tool call, changed files, token usage, billing, subscription, security status, KiloClaw.
- Treat workspace identifiers, slugs, run IDs, file paths, and usage numbers as technical data; use monospace sparingly for those values.
- Keep the brand mark compact and utilitarian. Do not make a large logo lockup the main composition.
- Primary actions use the brand primary token. Secondary actions stay neutral.
- Status colors stay small: badges, inline text, rings, or compact indicators.

## Reject

- Neutral or gray primary actions.
- Blue button fills used as primary CTAs.
- Yellow-green applied to many unrelated controls.
- Purple gradient heroes, glass panels, glossy surfaces, or decorative AI sparkle language.
- New font families outside Cloud's contract.
- Light-mode-only Cloud designs.
