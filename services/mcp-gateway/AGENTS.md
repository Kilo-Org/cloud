# MCP Gateway Conventions

## Scope

`services/mcp-gateway` is the runtime plane for the Kilo MCP Gateway. The Next.js
app owns interactive OAuth, configuration CRUD, assignment management, provider
callbacks, gateway token issuance, and control-plane audit. This Worker owns scoped
runtime routing, protected-resource metadata, gateway-token verification, runtime
Postgres rechecks, upstream credential injection, streaming proxying, per-instance
refresh coordination, and runtime telemetry.

The Worker MUST NOT implement first-level OAuth authorization, token, registration,
provider callback, JWKS, user-info, config CRUD, assignment CRUD, or app management
routes in v1.

## Specs

This service is governed by `.specs/mcp-gateway-auth.md` (the authoritative MCP
Gateway v1 spec — protocol surface, ownership, OAuth lifecycle, provider grants,
runtime auth). Read it (and load the `specs` skill) before changing gateway
behavior.

## HTTP routes

- Runtime routes are scoped connect resources only:
  - `/mcp-connect/user/{user_id}/{config_id}/{route_key}`
  - `/mcp-connect/org/{org_id}/{config_id}/{route_key}`
- Protected-resource metadata is the only other public gateway surface owned by
  this Worker.


## Hyperdrive and Postgres
- Postgres remains the shared system of record for config, route, assignment,
  identity, instance, and grant state.
- The Worker must re-check current Postgres state on every authenticated runtime
  request before proxying, even when a Durable Object cache has older material.

## Durable Objects

- `MCPGatewayInstance` is the per-instance runtime coordination atom. Its
  deterministic key is `{owner_scope}:{owner_id}:{config_id}:{user_id}`.
- Do not introduce a global gateway Durable Object or a config-level DO that
  serializes all users of a shared org config.
- DO cache state is never authoritative for config, assignment, identity, route,
  or grant eligibility.
- If DO SQLite is used, use tracked schema migrations from day one instead of ad
  hoc `CREATE TABLE IF NOT EXISTS` drift.

## Security and streaming

- Route knowledge is not an authorization boundary. Every authenticated runtime
  request must verify the exact scoped route, token audience, route key, config
  status, identity, org membership, assignment, execution context, and instance
  status.
- The client `Authorization` header is only for gateway authentication and must
  never be forwarded upstream.
- Strip credential-like client headers before proxying, including `Authorization`,
  `Proxy-Authorization`, `Cookie`, `X-API-Key`, `X-Auth-*`, and `X-Token-*`.
- Stream unknown request and response bodies. Do not buffer unbounded payloads.
- Do not log tokens, credentials, auth headers, cookies, webhook secrets, raw
  provider payloads, or other secret material.
