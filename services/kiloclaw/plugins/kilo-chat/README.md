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

Agent replies can be streamed to the external service Telegram-style — a single message
is created on the first token and then edited in place as more tokens arrive.

Configure under `channels.kilo-chat.streaming`:

- `mode`: `off | partial | block`. Default `partial`.
  - `partial` — live edit-in-place for the primary reply block; subsequent blocks create
    separate messages.
  - `off` — no streaming; each reply block becomes a new message on completion.
  - `block` — accepted but currently behaves as `off` (reserved for future block-level
    streaming semantics).
- `throttleMs`: integer in `[100, 5000]`. Default `500`. Minimum gap between outbound
  `PATCH` edits while streaming.

The plugin issues:

- `POST   /v1/messages` to create the initial preview (`version: 1`).
- `PATCH  /v1/messages/:id` with `{conversationId, text, version}` for each edit; the
  server MAY reject `409` on stale versions, which is treated as a benign drop.
- `DELETE /v1/messages/:id` for preview cleanup on dispatch failure.
