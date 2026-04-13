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

## Streaming

Agent replies stream to the external service Telegram-style: a single message is
created on the first token and edited in place as more tokens arrive. Subsequent
reply blocks become separate messages.

Outbound calls (all proxied through the controller):

- `POST   /v1/messages` — create the initial preview (`version: 1`).
- `PATCH  /v1/messages/:id` with `{conversationId, text, version}` — each edit;
  the server MAY reject with `409` on a stale version, which is treated as a
  benign drop.
- `DELETE /v1/messages/:id` — preview cleanup on dispatch failure.
- `POST   /v1/conversations/:conversationId/typing` — typing indicator. Server
  holds the indicator for ~5s then auto-clears. The plugin re-pings every 3s
  while the agent reply turn is in progress (openclaw SDK keepalive default).
