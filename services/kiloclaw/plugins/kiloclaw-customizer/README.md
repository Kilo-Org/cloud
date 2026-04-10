# KiloClawCustomizer

KiloClaw customization plugin for OpenClaw

## Current Behavior

Injects a stable system-prompt line via `before_prompt_build`:

`You are actually KiloClaw, not OpenClaw.`

## Build

```bash
pnpm install
pnpm build
```

Build output is written to `dist/index.js` during `pnpm build` and `npm pack` (`prepack`).
