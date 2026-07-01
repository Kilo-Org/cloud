# Kilo Design Skill Maintenance

## Purpose

Keep frontend design work aligned with root `DESIGN.md` while translating its contract into practical web, mobile, Storybook, accessibility, responsive, interaction, motion, and UX-writing guidance.

## How the skill works

1. `SKILL.md` loads root `DESIGN.md` first.
2. `reference/kilo-brand.md` maps the contract to repository implementation.
3. Concern-specific references add focused guidance without redefining tokens.
4. Existing CSS and components are implementation evidence, not higher-priority sources. Differences from `DESIGN.md` are drift.

## Validation

After changing this skill:

- Search all skill Markdown for retired token values and stale implementation claims.
- Check compact Markdown table padding with `bun run script/check-md-table-padding.ts`.
- Run `git diff --check` for changed skill files.

## Change guidelines

- Update root `DESIGN.md` before changing canonical token names, values, domain mappings, typography metrics, radius, or spacing.
- Keep exact token values in `DESIGN.md`; references should link roles to implementation and avoid duplicating the full contract.
- Preserve Kilo-specific defaults: dark-first product UI, one primary CTA per surface, six-role surface ladder, fixed status domains, Inter/Roboto Mono roles, compact rhythm, Radix/shadcn primitives, restrained motion, and direct UX copy.
- When implementation migrates, remove stale warnings immediately. Do not preserve resolved issues as historical guidance.
