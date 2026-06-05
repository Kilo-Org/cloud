# MCP Gateway

`services/mcp-gateway` is the Kilo MCP Gateway runtime Worker. The Next.js app owns
interactive OAuth and control-plane state. This Worker owns protected-resource metadata,
scoped runtime authorization, upstream credential injection, streaming proxying, and
per-instance refresh coordination.

## Public surface

- `GET /health`
- `GET|POST /mcp-connect/user/{user_id}/{config_id}/{route_key}`
- `GET|POST /mcp-connect/org/{org_id}/{config_id}/{route_key}`
- Optional descendant paths under each scoped connect route
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp-connect/user/{user_id}/{config_id}/{route_key}`
- `GET /.well-known/oauth-protected-resource/mcp-connect/org/{org_id}/{config_id}/{route_key}`

Unauthenticated runtime requests return an OAuth challenge. The Worker does not own
first-level OAuth registration, authorization, token, callback, JWKS, or user-info routes.

## Commands

```bash
pnpm --filter cloudflare-mcp-gateway keys:generate
pnpm --filter cloudflare-mcp-gateway types
pnpm --filter cloudflare-mcp-gateway typecheck
pnpm --filter cloudflare-mcp-gateway test
pnpm --filter cloudflare-mcp-gateway lint
pnpm --filter cloudflare-mcp-gateway dev
```

## Local key material

The key generator emits a matching app/Worker key bundle without writing secrets to disk:

```bash
pnpm --filter cloudflare-mcp-gateway keys:generate
pnpm --filter cloudflare-mcp-gateway keys:generate -- --format env --target worker --issuer http://localhost:3000
pnpm --filter cloudflare-mcp-gateway keys:generate -- --format env --target app --issuer http://localhost:3000
```

For local Worker startup, `cp .dev.vars.example .dev.vars` provides test-only values.
Wrangler loads the keyset values in `.dev.vars` as ordinary local Worker secrets. For
end-to-end local OAuth smoke tests, the app and Worker must use a matching generated
bundle.

For deployed environments, set the three Worker secrets with Wrangler:

```bash
wrangler secret put MCP_GATEWAY_JWT_PUBLIC_KEYSET_JSON
wrangler secret put MCP_GATEWAY_CREDENTIAL_KEYSET_JSON
wrangler secret put MCP_GATEWAY_RATE_LIMIT_SECRET
```

Local app and Worker origins must also agree. In the Worker `.dev.vars`, set
`APP_BASE_URL` to the Next.js app origin and `MCP_GATEWAY_BASE_URL` to the Worker
origin:

```bash
APP_BASE_URL=http://localhost:3000
MCP_GATEWAY_BASE_URL=http://localhost:8806
```

In `apps/web/.env.local`, set the app-side gateway origin to the same Worker
origin:

```bash
MCP_GATEWAY_BASE_URL=http://localhost:8806
```

`apps/web` derives its own app origin from `APP_URL`; only set
`MCP_GATEWAY_APP_BASE_URL` if the OAuth app origin differs from `APP_URL`.

## Architecture

The Next.js app owns the interactive OAuth and control plane. This Worker owns the
runtime plane: protected-resource discovery, gateway-token verification, runtime
rechecks, upstream credential injection, streaming proxying, and per-instance refresh
coordination. See `.specs/mcp-gateway-auth.md`.
