# KiloClaw Controller (Go Experiment)

Standalone Go controller/proxy prototype with:

- PID1-style OpenClaw gateway supervision (`openclaw gateway ...`)
- `GET /health` (no auth)
- `/gateway/*` management API with bearer token auth
- Catch-all reverse proxy to `127.0.0.1:3001` with optional proxy-token enforcement
- HTTP + WebSocket proxying via `httputil.ReverseProxy`
- Route-table registration (`routeTable()` in `app.go`) so adding endpoints is a one-line entry plus handler

## Run

```bash
cd /Users/syn/projects/cloud-alt/kiloclaw/controller-go

OPENCLAW_GATEWAY_TOKEN=... \
KILOCLAW_GATEWAY_ARGS='["--port","3001","--verbose","--allow-unconfigured","--bind","loopback","--token","..."]' \
REQUIRE_PROXY_TOKEN=false \
go run .
```

## Required Env

- `OPENCLAW_GATEWAY_TOKEN`
- `KILOCLAW_GATEWAY_ARGS` (JSON array of CLI args)

## Optional Env

- `PORT` (default `18789`)
- `REQUIRE_PROXY_TOKEN` (`true`/`false`, default `false`)
