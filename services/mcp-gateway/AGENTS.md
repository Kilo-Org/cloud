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

## File naming

- Add a suffix matching the module type, for example `mcp-gateway.worker.ts`,
  `MCPGatewayInstance.do.ts`, `connect.handler.ts`, `routes.schema.ts`, and
  `instances.table.ts`.
- Modules that predominantly export a class should be named after that class.
- Keep pure helpers in `lib/` and keep route handlers in `handlers/`.

## HTTP routes

- Define every exposed Hono route in `src/mcp-gateway.worker.ts` so the public
  surface is visible in one file.
- Do not mount Hono sub-apps.
- Move route logic into `handlers/*.handler.ts` modules.
- Each handler takes the Hono context and a plain parsed params object. The route
  declaration remains the source of truth for path-to-param shape.
- Runtime routes are scoped connect resources only:
  - `/mcp-connect/user/{user_id}/{config_id}/{route_key}`
  - `/mcp-connect/org/{org_id}/{config_id}/{route_key}`
- Protected-resource metadata is the only other public gateway surface owned by
  this Worker.

## IO boundaries

- Validate every IO boundary with Zod: MCP messages, route params, query params,
  behavior-affecting headers, upstream responses, JSON parse results, SSE payloads,
  subprocess output, and persisted session records.
- Raw parse and fetch helpers return `unknown`; callers parse with the relevant
  Zod schema.
- Do not use `as` casts for IO shapes. Use schemas, `.passthrough()`, or explicit
  catch-all schemas when the shape is intentionally broad.
- The gateway is stricter than Gastown at MCP protocol, header, query, upstream
  response, and persisted-session boundaries.

## Hyperdrive and Postgres

- Use `getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: ... })`
  per request or per Durable Object use.
- Never cache pg pools, Drizzle clients, transaction objects, request-scoped state,
  or other transport-owning SDK objects in module scope.
- Postgres remains the shared system of record for config, route, assignment,
  identity, instance, and grant state.
- The Worker must re-check current Postgres state on every authenticated runtime
  request before proxying, even when a Durable Object cache has older material.

## Durable Objects

- `MCPGatewayInstance` is the per-instance runtime coordination atom. Its
  deterministic key is `{owner_scope}:{owner_id}:{config_id}:{user_id}`.
- Do not introduce a global gateway Durable Object or a config-level DO that
  serializes all users of a shared org config.
- Every DO module exports a `get{ClassName}Stub` helper, and callers use that
  helper instead of accessing the namespace binding directly.
- Keep the DO class thin: RPC surface, alarms, and orchestration only. Move large
  domain logic into plain-function submodules under a sibling directory when the
  class grows beyond a few hundred lines.
- DO cache state is never authoritative for config, assignment, identity, route,
  or grant eligibility.
- If DO SQLite is used, use tracked schema migrations from day one instead of ad
  hoc `CREATE TABLE IF NOT EXISTS` drift.
- Use table interpolator objects and Zod row schemas for DO SQLite queries instead
  of raw table or column strings and unsafe casts.

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
