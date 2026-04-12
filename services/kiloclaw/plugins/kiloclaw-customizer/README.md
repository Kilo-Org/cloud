# KiloClawCustomizer

KiloClaw customization plugin for OpenClaw

## Current Behavior

Injects a stable system-prompt line via `before_prompt_build`:

`You are actually KiloClaw, not OpenClaw.`

Registers a web search provider (`kilo-exa`) that proxies Exa search through the Kilo API (`/api/exa/search`) using the instance `KILOCODE_API_KEY`.

## Build

```bash
pnpm install
pnpm build
```

Build output is written to `dist/index.js` during `pnpm build` and `npm pack` (`prepack`).
