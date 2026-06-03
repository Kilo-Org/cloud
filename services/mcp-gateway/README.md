# MCP Gateway

`services/mcp-gateway` is the Kilo MCP Gateway runtime Worker. PR1 intentionally
ships only the route skeleton for scoped MCP connect resources and protected-resource
metadata. The Worker is not attached to `mcp.kilo.ai` yet and does not implement OAuth,
provider discovery, database state, credential injection, or proxying.

## Public surface in PR1

- `GET /health`
- `GET|POST /mcp-connect/user/{user_id}/{config_id}/{route_key}`
- `GET|POST /mcp-connect/org/{org_id}/{config_id}/{route_key}`
- Optional descendant paths under each scoped connect route
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp-connect/user/{user_id}/{config_id}/{route_key}`
- `GET /.well-known/oauth-protected-resource/mcp-connect/org/{org_id}/{config_id}/{route_key}`

All runtime and protected-resource routes return `501 Not Implemented` in PR1.

## Commands

```bash
pnpm --filter cloudflare-mcp-gateway types
pnpm --filter cloudflare-mcp-gateway typecheck
pnpm --filter cloudflare-mcp-gateway test
pnpm --filter cloudflare-mcp-gateway lint
pnpm --filter cloudflare-mcp-gateway dev
```

## Architecture

The Next.js app owns the interactive OAuth and control plane. This Worker owns the
runtime plane: protected-resource discovery, gateway-token verification, runtime
rechecks, upstream credential injection, streaming proxying, and per-instance refresh
coordination. The gateway architecture notes remain in the planning workspace until PR2.
