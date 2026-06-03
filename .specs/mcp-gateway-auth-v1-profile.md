# Kilo MCP Gateway v1 Control Plane / Runtime Architecture Profile

## Role of This Document

This document is the Kilo-specific architecture profile for the MCP Gateway v1 implementation. It extends and, where explicitly stated, supersedes the clean-room compatibility baseline in `obot-mcp-gateway-auth-clean-room-spec.md`.

The clean-room spec remains the source of truth for protocol security invariants, grant isolation, token secrecy, assignment rules, and upstream credential injection. This profile defines the Kilo v1 product boundary and implementation architecture:

- the split between the Next.js control plane and Cloudflare Worker runtime plane
- the scoped public connect resource shape
- app-owned OAuth authorization-server endpoints
- loose service ownership for shared Postgres tables
- the Cloudflare-native runtime coordination model
- the no-advisory-lock rule for Next.js control-plane mutations

Where this profile conflicts with the clean-room spec, this profile wins for the Kilo v1 implementation.

## Status

Draft -- revised 2026-06-02 for the app-control-plane and Worker-runtime architecture.

## Architecture Summary

Kilo MCP Gateway v1 is a two-plane system:

1. **Control plane**: `apps/web` primarily owns interactive user flows, gateway configuration, org assignment, OAuth authorization-server behavior, dynamic client registration, provider authorization callbacks, authorization codes, refresh tokens, and provider-grant lifecycle.
2. **Runtime plane**: `services/mcp-gateway` primarily owns protected-resource discovery, gateway-token verification, runtime authorization rechecks, upstream credential injection, streaming proxying, per-instance refresh coordination, and runtime telemetry.

This is intentionally a loose service-ownership model, consistent with the rest of the repo. Shared Postgres tables are allowed. The app and Worker can both read and write gateway tables when that is the natural place to do so. Correctness comes from domain invariants, normal transactions, conditional updates, version fields, and runtime rechecks, not from strict table-level ownership guards.

The app is an authorization boundary for interactive OAuth and management flows because it owns the user session and control-plane state. The Worker remains an independent runtime authorization boundary and MUST re-check current config, identity, membership, assignment, route, and instance state before proxying.

## Scoped Connect Resource Shape

The Kilo v1 public connect resource shape supersedes the opaque `/mcp-connect/{connect_id}` shape from the clean-room baseline.

1. Every enabled gateway config MUST have exactly one active scoped connect resource.
2. Personal config connect resources MUST use:

   ```text
   /mcp-connect/user/{user_id}/{config_id}/{route_key}
   ```

3. Org config connect resources MUST use:

   ```text
   /mcp-connect/org/{org_id}/{config_id}/{route_key}
   ```

4. Route scope `user` maps to owner scope `personal`; route scope `org` maps to owner scope `organization`.
5. `user_id`, `org_id`, and `config_id` MAY be visible in the public URL. They are not security boundaries.
6. `config_id` MUST be a stable non-sequential identifier.
7. `route_key` MUST be a high-entropy URL-safe value and MUST be rotatable independently of config identity.
8. A rotated `route_key` MUST immediately invalidate the old public URL and any outstanding gateway access tokens bound to it.
9. Rotating a `route_key` MUST NOT revoke provider grants or connection instances.
10. A config MUST NOT have more than one active route key at a time in v1.
11. The exact canonical connect URL, including scope, owner ID, config ID, and route key, MUST be used as the OAuth resource and access-token audience.
12. Descendant paths are allowed only when config path passthrough is enabled and MUST be authorized against the canonical root route.
13. A caller that knows a user ID, org ID, config ID, or route key MUST still pass runtime authorization checks. Public route knowledge MUST NOT grant access.

## OAuth Authorization Server Ownership

1. The Next.js app owns the gateway OAuth authorization server in v1.
2. The app-owned authorization server includes:
   - `GET /.well-known/oauth-authorization-server`
   - `GET /.well-known/oauth-authorization-server/oauth/authorize`
   - `POST /api/mcp-gateway/oauth/register`
   - `POST /api/mcp-gateway/oauth/register/{scope}/{owner_id}/{config_id}/{route_key}`
   - `GET|PUT|DELETE /api/mcp-gateway/oauth/register/{client_id}`
   - `GET /api/mcp-gateway/oauth/authorize`
   - `GET /api/mcp-gateway/oauth/authorize/{scope}/{owner_id}/{config_id}/{route_key}`
   - `POST /api/mcp-gateway/oauth/token`
   - `POST /api/mcp-gateway/oauth/token/{scope}/{owner_id}/{config_id}/{route_key}`
   - `GET /api/mcp-gateway/oauth/mcp/callback`
   - `GET /api/mcp-gateway/oauth/jwks.json`
   - `GET /api/mcp-gateway/oauth/userinfo`
3. Route-specific app OAuth endpoints MUST use the same `{scope}/{owner_id}/{config_id}/{route_key}` segment family as the Worker connect resource.
4. The Worker MUST NOT implement first-level OAuth authorization, token, registration, or provider callback endpoints in v1.
5. The Worker MUST implement:
   - scoped `/mcp-connect/...` runtime proxying
   - generic protected-resource metadata
   - scoped protected-resource metadata
   - `WWW-Authenticate` challenges for unauthenticated runtime requests
6. Protected-resource metadata served from `mcp.kilo.ai` MUST advertise the app-owned authorization server as the authorization server for that resource.
7. The Worker MUST verify app-issued gateway access tokens using the published public key set and MUST NOT trust the app token alone without runtime re-resolution.
8. The app MUST keep gateway signing private keys out of the Worker. The Worker receives only the public JWKS material it needs for verification.

## Control Plane Responsibilities

1. The app primarily handles gateway config CRUD, connect route creation/rotation/revocation, assignment management, discovery preflight, dynamic provider registration, static provider credential management, and static header management.
2. The app primarily handles user-interactive authorization and provider callback flows using its normal session boundary.
3. The app is the natural place to create, consume, and rotate first-level OAuth artifacts in Postgres:
   - OAuth clients
   - authorization requests
   - authorization codes
   - refresh tokens
   - pending provider authorizations
4. The app is the natural place to create, replace, revoke, and delete provider grants as part of provider authorization and control-plane lifecycle actions.
5. The app is the natural place to create and update connection instances as part of authorized control-plane actions.
6. The app records control-plane audit events for config, assignment, authorization, provider authorization, grant, and lifecycle actions.
7. The app MUST NOT inject upstream credentials or proxy remote MCP traffic.
8. The app MUST NOT rely on browser-to-Worker handoff callbacks for first-level or provider OAuth completion.
9. The app MUST NOT use advisory locks for gateway control-plane mutations.
10. The app MUST use normal database transactions, uniqueness constraints, version fields, and conditional updates for one-time artifact consumption and lifecycle transitions.
11. The app MUST use the existing Kilo identity/session boundary for user eligibility, org role checks, and ownership checks.

## Runtime Plane Responsibilities

1. The Worker MUST be the only component that injects upstream provider tokens or static header credentials.
2. The Worker MUST verify the gateway access token, exact scoped route, canonical audience, route key, config status, user eligibility, org membership, assignment, execution context, and connection-instance status before proxying every authenticated request.
3. The Worker MUST read current gateway runtime state from Postgres through Hyperdrive on every authenticated runtime request.
4. The Worker MAY use Durable Objects as per-instance runtime coordinators and credential caches, but Postgres remains the shared system of record.
5. The Worker MUST NOT treat a Durable Object cache as authoritative when current Postgres runtime state says a config, assignment, route, user, or instance is no longer usable.
6. The Worker MUST refresh provider grants lazily only when an upstream request needs a token and the current token is expired or insufficient.
7. The Worker is the natural place to update provider grants for runtime refresh outcomes and runtime state transitions such as `needs_reauth`.
8. The Worker records runtime usage and runtime refresh outcomes in a sanitized audit/telemetry stream.
9. The Worker MUST stream Streamable HTTP and SSE payloads without buffering unknown bodies.
10. The Worker MUST reject non-public HTTPS upstream destinations and validate redirect chains before following them.

## Durable Object Runtime Coordination

1. The v1 Cloudflare-native runtime coordination atom is one instance Durable Object per non-terminal connection instance.
2. The deterministic DO key MUST be derived from:

   ```text
   {owner_scope}:{owner_id}:{config_id}:{user_id}
   ```

3. The instance DO MAY cache decrypted provider grant material and config-level credential metadata only while the runtime request proves the corresponding Postgres version is current.
4. The instance DO MUST reload encrypted grant material from Postgres when the runtime request carries a newer grant version or when the cache is absent.
5. The instance DO MUST serialize provider refresh for one connection instance and prevent concurrent refresh races for the same grant.
6. The instance DO MUST persist refresh-in-progress state before an upstream token refresh call and MUST recover safely after eviction or failure.
7. The instance DO MUST not become the authoritative source for config, assignment, grant, or user eligibility state.
8. The Worker MAY bypass the instance DO for `none` and `static_headers` configs when no per-user grant refresh or secret cache is needed.
9. The system MUST NOT use a global Durable Object as the gateway coordination atom.
10. A shared org config MUST not serialize all assigned users through one config-level DO in v1.

## Shared Persistence and Service Responsibilities

1. Postgres is the shared system of record for gateway state, app identity state, and runtime eligibility state.
2. The app primarily writes control-plane state such as configs, route keys, assignments, OAuth artifacts, provider grants, and control-plane audit events.
3. The Worker primarily writes runtime state such as provider refresh updates, runtime instance metadata, `needs_reauth` transitions caused by refresh failure, and runtime usage telemetry.
4. Strict database permission partitioning between the app and Worker is not required in v1.
5. Shared mutable tables, especially provider grants and connection instances, MUST use version fields so the Worker can detect an app-side replacement or revocation during runtime refresh.
6. If a Worker refresh update conflicts with an app-side control-plane write, the Worker MUST reload current state and MUST NOT overwrite the newer control-plane state.
7. A control-plane revoke or assignment removal MUST be visible to the Worker on the next authenticated runtime request and MUST block proxying even if a DO cache still contains older grant material.
8. A future hardening pass MAY introduce narrower database roles if operationally useful, but that is not required for v1 and is not part of the implementation plan.

## Gateway Token Contract

1. The app MUST issue gateway access tokens as RS256 JWTs with a 15-minute lifetime.
2. The Worker MUST verify the JWT signature using the published public key set and MUST reject tokens with unknown key IDs, invalid signature, wrong issuer, wrong audience, expired timestamps, or malformed claims.
3. Every gateway access token MUST include:
   - `sub` for the Kilo user ID
   - `aud` for the exact canonical scoped connect URL
   - `exp`
   - `scope`
   - `MCPID`
   - `owner_scope`
   - `owner_id`
   - `config_id`
   - `route_key`
   - `instance_id`
   - `execution_context`
   - `config_version`
4. `MCPID` MUST equal the canonical scoped route identity string:

   ```text
   {owner_scope}:{owner_id}:{config_id}:{route_key}
   ```

5. The Worker MUST compare the request path and the token's `aud`, `MCPID`, owner tuple, config ID, and route key before proxying.
6. Gateway token claims MAY optimize routing, but they MUST NOT replace runtime Postgres checks.
7. The Worker MUST route OAuth-mode runtime requests to the instance DO using the token's owner tuple and user ID only after validating the path and token.
8. Derived connect tokens minted from Kilo user tokens MUST use the same gateway token contract and MUST not expose the raw Kilo token to the Worker proxy or upstream server.

## Provider Grants and Refresh

1. Provider grants remain bound to exactly one connection instance and MUST NOT be shared across users, configs, owners, or scopes.
2. The app MUST persist a provider grant before issuing a final gateway authorization code or gateway access token for an OAuth-mode config.
3. The app MUST revoke or delete provider grants on config deletion, assignment removal, org removal, user deletion, material config mutation, or explicit user revocation.
4. The Worker MUST refresh provider grants only during runtime proxying.
5. The Worker MUST use the instance DO to serialize refresh for a single connection instance.
6. Provider grant rows MUST include a monotonic `grant_version` or equivalent version field.
7. The app MUST increment grant version on create, replace, revoke, or delete actions.
8. The Worker MUST increment grant version only when a refresh succeeds and it writes new provider token material.
9. If refresh fails, the Worker MUST move the instance to `needs_reauth` and MUST NOT proxy with stale or unrelated credentials.
10. If the app replaces or revokes a grant while a Worker refresh is in progress, the Worker MUST detect the version mismatch and reload rather than overwrite the app's newer state.

## No-Advisory-Lock Rule

1. The Next.js control plane MUST NOT use Postgres advisory locks for gateway operations.
2. Authorization code consumption MUST use a conditional one-time update or an equivalent transactional pattern that guarantees only one successful consumer.
3. Refresh-token rotation MUST use conditional updates, uniqueness constraints, and transaction boundaries rather than advisory locks.
4. Assignment reconciliation and material config mutation MUST use normal database transactions and versioned state transitions.
5. Runtime provider refresh coordination is explicitly delegated to per-instance Durable Objects, not to app-side advisory locks.

## Security and Privacy

1. The app and Worker MUST never expose provider access tokens, provider refresh tokens, static provider secrets, static header secrets, authorization codes, refresh tokens, PKCE verifiers, or raw callback payloads to normal MCP clients.
2. The Worker MUST be the only upstream credential injection boundary.
3. The app MUST not return stored secret values after initial configuration.
4. Public route knowledge MUST not grant access, and enumeration of user IDs, org IDs, config IDs, or route keys MUST not bypass runtime authorization.
5. The Worker MUST re-check current identity and assignment state on every authenticated runtime request.
6. The app and Worker MUST use dedicated gateway signing and credential-encryption key material, with app-only access to signing private keys and shared access to credential decrypt keys where provider refresh requires it.
7. Runtime and control-plane logs/audits MUST redact all secret and token material.

## Out of Scope

- Legacy opaque `/mcp-connect/{connect_id}` compatibility in v1.
- A Worker-owned OAuth authorization server in v1.
- Global gateway Durable Objects.
- D1 as an additional gateway index store while Postgres remains available.
- Per-user static header inputs.
- Group/team assignment.
- External `/v0.1/servers` registry projection.
- A Worker-side provider token-exchange API.
