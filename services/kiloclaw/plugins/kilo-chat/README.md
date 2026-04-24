# Kilo Chat

OpenClaw channel plugin for Kilo's hosted chat service (kilo-chat worker).

## Build

```bash
pnpm install
pnpm build
```

Build output is written to `dist/` during `pnpm build` and `npm pack` (`prepack`).

## Runtime requirements

No per-sandbox secrets. The plugin reuses credentials already provisioned
on the Fly machine:

- `OPENCLAW_GATEWAY_TOKEN` (required) — per-sandbox HMAC token used to
  authenticate the plugin → controller → kiloclaw-worker chain.
- `KILOCLAW_CONTROLLER_URL` (optional) — controller localhost URL;
  defaults to `http://127.0.0.1:18789`.

The kilo-chat channel is always enabled.

## Streaming

Agent replies stream to kilo-chat Telegram-style: a single message is
created on the first token and edited in place as more tokens arrive.
Subsequent reply blocks become separate messages.

Outbound calls (all proxied through the controller):

- `POST   /_kilo/kilo-chat/send` — create the initial preview.
- `PATCH  /_kilo/kilo-chat/messages/:id` with `{conversationId, content, timestamp}` —
  each edit; the server MAY reject with `409` on a stale timestamp, which is
  treated as a benign drop (the plugin re-sends on finalize).
- `DELETE /_kilo/kilo-chat/messages/:id` — preview cleanup on dispatch failure.
- `POST   /_kilo/kilo-chat/typing` with `{conversationId}` — typing indicator.
  Server holds the indicator for ~5s then auto-clears. The plugin re-pings
  every 3s while the agent reply turn is in progress (openclaw SDK default).
- `POST` / `DELETE /_kilo/kilo-chat/messages/:id/reactions` — emoji reactions
  driven through the OpenClaw `react` message-tool action.

## Inbound webhook

kilo-chat delivers inbound messages to the plugin at
`/plugins/kilo-chat/webhook` on the OpenClaw gateway. Auth is the
per-sandbox gateway token forwarded by the kiloclaw worker; there is no
separate HMAC envelope.
