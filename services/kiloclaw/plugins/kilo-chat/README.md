# Kilo Chat

OpenClaw channel plugin for Kilo's hosted chat service.

## Build

```bash
pnpm install
pnpm build
```

Build output is written to `dist/` during `pnpm build` and `npm pack` (`prepack`).

## Env vars

- `KILOCHAT_API_TOKEN` (required, encrypted) — auth token for the external service.
- `KILOCHAT_WEBHOOK_SECRET` (required, encrypted) — HMAC secret for inbound webhooks.
- `KILOCHAT_BASE_URL` (optional, plaintext) — overrides default endpoint.
