---
name: kilo-design-cloud
description: Kilo Cloud web UI overlay and pilot pattern recipes. Use when editing or reviewing Kilo Cloud UI paths such as apps/web/src/**, or when the Cloud repo path-scoped trigger requests Kilo design guidance.
---

# Kilo Design Cloud

This is the first agent-facing adapter for the Kilo design system. It covers Kilo Cloud's web app and the first Cloud pattern recipes.

## Run Order

1. If the task has a target Cloud file, read it first. For components, also read the matching primitive in `apps/web/src/components/ui/`.
2. If the task asks for a standalone mockup, prototype, or self-contained HTML with no target Cloud file, use Standalone Generation Mode.
3. Load `overlay.md` for all Cloud UI work.
4. Load one internal reference only when the task needs it: product judgment, brand, token architecture, voice, or interaction quality.
5. Load at most one matching recipe unless the task clearly spans multiple patterns.
6. If no recipe exists, use the overlay plus current Cloud code and report a coverage gap.
7. Keep broad product cleanup out of focused tasks.
8. Do not use playground specimen UI as a Cloud Canonical Example.

Completion criterion: the answer or change names the loaded overlay/recipe, follows real Cloud code, and does not normalize unrelated UI.

## Token Contract

- Cloud's generated token artifact is `src/tokens.cloud.ts`.
- Cloud UI code maps token values through `apps/web/src/app/globals.css` and semantic roles such as `--primary`, `--background`, and `--ring`.
- Do not use `src/tokens.landing.css` or `src/tokens.extension-host-map.md` as Cloud UI sources.

## Recipe Router

| Prompt or file signal | Load |
|---|---|
| primary action, CTA, button hierarchy, blue button drift | `patterns/cloud-web/primary-actions.md` |
| tabs, segmented navigation, Radix tabs, active tab state | `patterns/cloud-web/tabs.md` |
| tokens, globals.css, semantic mapping | `reference/token-architecture.md`; record that Cloud token adoption is `VVV-130` |
| copy, empty states, labels, errors, confirmations | `reference/voice.md` |
| forms, focus, keyboard, overlays, responsive layout, touch targets, loading, disabled, motion | `reference/interaction-quality.md` |
| badges, alerts, dialogs, sidebar, empty states | `overlay.md`; report coverage gap if a rule is missing |
| standalone mockup, prototype, generated HTML, arena pass, no target Cloud file | Standalone Generation Mode |
| login, auth, workspace slug, returning team, security status | `reference/brand.md`; `reference/voice.md`; `reference/token-architecture.md`; `reference/interaction-quality.md`; `patterns/cloud-web/primary-actions.md` |

## Standalone Generation Mode

Use this mode only when the task asks for generated UI without a real Cloud source file to read. The goal is a product-faithful Kilo Cloud surface, not a generic SaaS screen with Kilo labels.

Load these before designing:

1. `overlay.md`
2. `reference/brand.md`
3. `reference/voice.md`
4. `reference/token-architecture.md`
5. `reference/interaction-quality.md` when the surface includes forms, auth, overlays, responsive behavior, loading, disabled, error, or success states
6. One matching pattern recipe when available

Allowed read-only product artifact: `src/tokens.cloud.ts` when exact token values are needed.

Generated standalone HTML should:

- Define semantic CSS roles such as `--background`, `--foreground`, `--card`, `--muted-foreground`, `--primary`, `--primary-foreground`, `--border`, `--input`, and `--ring`.
- Resolve `--primary` to Kilo brand primary and `--primary-foreground` to Kilo brand foreground when writing self-contained CSS.
- Use Kilo Cloud product nouns from the prompt: workspaces, teams, agent runs, tool calls, changed files, billing, subscriptions, KiloClaw, security, or operational status.
- Stay compact, dark-first, technical, and task-oriented.
- Keep generated product UI free of guidance notes, gap reports, arena labels, skill labels, or comparison text.

## Non-Goals

- Do not build Landing, Editor, Console, Mobile, JetBrains, or CLI guidance here.
- Do not recreate a Cloud `DESIGN.md`.
- Do not migrate every hardcoded blue button unless the task is `primary-actions` implementation.
- Do not invent recipes without a real Canonical Example in shipped Cloud code.
- Do not copy UI structures from `playground/`; it previews token behavior only.

## Reference Map

- `overlay.md`: Cloud product overlay and known drift.
- `reference/product-judgment.md`: modes, authority order, and coverage gaps.
- `reference/brand.md`: Cloud use of Kilo brand language.
- `reference/token-architecture.md`: how Cloud agents should read product-facing token artifacts.
- `reference/voice.md`: Kilo Cloud UI copy rules.
- `reference/interaction-quality.md`: interaction states, form behavior, overlays, responsive checks, touch, and motion.
- `patterns/cloud-web/primary-actions.md`: primary CTA and button hierarchy recipe.
- `patterns/cloud-web/tabs.md`: Cloud tab recipe.
