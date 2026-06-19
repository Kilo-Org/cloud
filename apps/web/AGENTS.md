# AGENTS.md

## UI Work

When editing UI files in `apps/web` — React components, pages, layouts, or styles (`.tsx`/`.css`) — use the `/kilo-design` skill.

## Web Environment Variables

When a shared web env var needs to be added or rotated across tracked dotenv files and Vercel deployments, tell the user to run `pnpm web:env set <VARIABLE>`. Agents must not run that command themselves because it prompts for secret values and writes to external systems.
