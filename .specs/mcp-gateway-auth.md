# Kilo MCP Gateway Authentication v1

## Role of This Document

This is the authoritative Kilo MCP Gateway v1 specification. It defines the public
protocol surface, ownership model, OAuth lifecycle, provider grant rules, runtime
proxy behavior, persistence invariants, and security boundaries for the gateway.

Kilo v1 is intentionally a two-plane system:

- `apps/web` owns the interactive OAuth and control plane: session-backed
  authorization, config CRUD, assignment management, dynamic registration,
  provider callbacks, authorization codes, refresh tokens, provider grants,
  derived connect tokens, and control-plane audit.
- `services/mcp-gateway` owns the runtime plane: protected-resource metadata,
  scoped runtime routing, gateway JWT verification, fresh Postgres rechecks,
  upstream credential injection, streaming proxying, per-instance refresh
  coordination, runtime telemetry, and maintenance cleanup.

This document supersedes the earlier clean-room baseline/profile split. There is
one in-repo contract for Kilo v1, not a baseline plus override layer.

## Status

Draft - revised 2026-06-03 for the scoped-route, app-control-plane, Worker-runtime
architecture.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174]
when they appear in all capitals.

## Definitions

- **Gateway**: The Kilo MCP-facing Worker service that authenticates callers,
  resolves scoped connect resources, enforces current eligibility, injects
  upstream credentials, and proxies authorized traffic.
- **Config**: A first-class Kilo connection definition for one remote MCP
  endpoint, one auth mode, one sharing mode, one active scoped route, config-level
  credentials or auxiliary headers, and optional registry metadata.
- **Scoped connect resource**: The public runtime resource for one config:
  `/mcp-connect/user/{user_id}/{config_id}/{route_key}` for personal configs or
  `/mcp-connect/org/{org_id}/{config_id}/{route_key}` for org configs.
- **Route key**: A high-entropy URL-safe segment that is rotatable independently
  of config identity. Route knowledge is never an authorization boundary.
- **Owner scope**: Either `personal` or `organization`. Every config and route
  has exactly one owner scope and owner ID.
- **Execution context**: The caller's current Kilo context: personal or one
  specific organization. Authorization, refresh, token issuance, and runtime
  proxying MUST use authoritative execution context, not route inference alone.
- **Connection instance**: A per-user record associated with one config. In v1,
  there is at most one non-terminal instance for each
  `(owner_scope, owner_id, user_id, config_id)` tuple.
- **Provider grant**: A third-party access/refresh token bundle belonging to
  exactly one connection instance. Provider grants are never exposed to MCP
  clients.
- **Gateway OAuth client**: A dynamically registered OAuth client represented
  externally as `namespace:name`.
- **Gateway access token**: A short-lived app-issued JWT bound to one user, one
  scoped connect resource, one execution context, one instance, and one scope set.
- **Derived connect token**: A short-lived gateway access token minted by the
  app from an existing Kilo session/token for an internal connect-token route.
- **Auxiliary header**: A config-level non-auth header that may be injected
  upstream alongside credentials. It must be valid, non-hop-by-hop, and non-secret.
- **Audit event**: A durable non-secret record of lifecycle, authorization,
  provider, refresh, or runtime activity.

## Architecture And Ownership

1. The app is the only first-level OAuth authorization server in v1.
2. The Worker MAY expose same-origin discovery aliases that redirect to app-owned
   authorization-server metadata, but it MUST NOT implement first-level OAuth
   registration, authorization, token, provider callback, JWKS, user-info, config
   CRUD, assignment CRUD, or app management routes.
3. The Worker is the only upstream credential injection boundary in v1.
4. Postgres is the shared system of record for configs, routes, assignments,
   instances, grants, OAuth artifacts, and audit state.
5. App and Worker may both touch shared gateway tables when natural. Correctness
   comes from transactions, conditional updates, uniqueness constraints, version
   fields, and fresh runtime rechecks, not strict table ownership guards.
6. The app MUST NOT use advisory locks for gateway control-plane mutations.
7. The Worker MUST use Hyperdrive and create a fresh `getWorkerDb(...)` wrapper
   per request or Durable Object use. It MUST NOT cache pools, Drizzle clients,
   transaction objects, or request-scoped IO in module scope.
8. One `MCPGatewayInstance` Durable Object coordinates one non-terminal
   connection instance. Its deterministic key is
   `{owner_scope}:{owner_id}:{config_id}:{user_id}`.
9. The DO is never authoritative for config, assignment, route, identity, or
   grant eligibility. Postgres remains authoritative.
10. The DO MAY cache short-lived version-checked grant state and serialize one
    exact refresh attempt at a time. It MUST permit recovery after eviction or
    failure when Postgres state is still eligible.
11. The Worker scheduled cleanup job MAY delete expired terminal OAuth artifacts,
    stale rate-limit windows, and audit rows older than 60 days. It MUST NOT
    issue, consume, or mutate live first-level OAuth artifacts as part of normal
    authorization.

## Public Surface

| Surface | Owner | Required behavior |
|---|---|---|
| `GET /health` | Worker | Health response only. |
| `GET` or `POST /mcp-connect/user/{user_id}/{config_id}/{route_key}` | Worker | Protected runtime entrypoint. Unauthenticated callers receive an OAuth challenge; authorized callers are proxied. |
| `GET` or `POST /mcp-connect/org/{org_id}/{config_id}/{route_key}` | Worker | Same as personal route, with org eligibility checks. |
| Descendants under scoped connect routes | Worker | Allowed only when config path passthrough is enabled and authorized against the root route. |
| `GET /.well-known/oauth-protected-resource` | Worker | Generic protected-resource metadata for `{base_url}/mcp-connect`. |
| `GET /.well-known/oauth-protected-resource/mcp-connect/...` | Worker | Scoped protected-resource metadata for one canonical route. |
| `GET /.well-known/oauth-authorization-server` | App canonical route, Worker discovery alias | Authorization-server metadata. The Worker alias redirects to the app canonical route. |
| `GET /.well-known/oauth-authorization-server/oauth/authorize` | App canonical route, Worker discovery alias | Metadata alias for clients that discover from the authorization route. The Worker alias redirects to the app canonical route. |
| `GET /.well-known/oauth-authorization-server/mcp-connect/...` | Worker discovery alias | Path-aware compatibility alias for clients that start discovery from one scoped connect URL; redirects to app canonical metadata. |
| `POST /api/mcp-gateway/oauth/register` | App | Dynamic client registration. |
| `POST /api/mcp-gateway/oauth/register/{scope}/{owner_id}/{config_id}/{route_key}` | App | Resource-specific registration after route eligibility discovery. |
| `GET|PUT|DELETE /api/mcp-gateway/oauth/register/{client_id}` | App | Registration management authorized by registration token. |
| `GET /api/mcp-gateway/oauth/authorize` | App | Generic authorization-code flow; requires `resource`. |
| `GET /api/mcp-gateway/oauth/authorize/{scope}/{owner_id}/{config_id}/{route_key}` | App | Route-specific authorization-code flow. |
| `POST /api/mcp-gateway/oauth/token` | App | Authorization-code and refresh-token exchange. |
| `POST /api/mcp-gateway/oauth/token/{scope}/{owner_id}/{config_id}/{route_key}` | App | Route-specific token exchange. |
| `GET /api/mcp-gateway/oauth/mcp/callback` | App | Second-level provider callback. |
| `GET /api/mcp-gateway/oauth/jwks.json` | App | Public JWKS for gateway JWT verification. |
| `GET /api/mcp-gateway/oauth/userinfo` | App | Profile-gated user-info. |
| `GET /api/mcp-gateway/available` | App | Authenticated list of configs usable in the current execution context. |

## Scoped Route Contract

1. Every enabled config MUST have exactly one active scoped connect resource in v1.
2. Personal routes MUST use `/mcp-connect/user/{user_id}/{config_id}/{route_key}`.
3. Org routes MUST use `/mcp-connect/org/{org_id}/{config_id}/{route_key}`.
4. Route scope `user` maps to owner scope `personal`; route scope `org` maps to
   owner scope `organization`.
5. `config_id` MUST be stable and non-sequential.
6. `route_key` MUST be high-entropy and URL-safe.
7. Route knowledge MUST NOT grant access. Every authenticated runtime request
   MUST still verify token, route, owner, context, membership, assignment,
   config status, instance status, and grant state.
8. Rotating a route key MUST immediately invalidate the old URL and any gateway
   token bound to it.
9. Rotating a route key MUST NOT revoke provider grants or connection instances.
10. A config MUST NOT have more than one active route key in v1.
11. The exact canonical scoped URL is the OAuth resource and JWT audience.
12. Descendant paths are allowed only when path passthrough is enabled. They MUST
    be validated as descendant data and MUST NOT escape the configured upstream
    base path through dot segments or encoded path normalization.

## Owner Model And Eligibility

1. Every config is owned by exactly one scope: `personal` or `organization`.
2. A personal config is usable only by its personal owner in personal execution
   context.
3. An org config is usable only by explicitly assigned users in the matching org
   execution context.
4. Org owners and admins may manage org configs, but they are not implicitly
   allowed to use them unless assigned.
5. Assigned org users may use only their own connection instance and provider
   grant. They may not edit configs, assignments, shared credentials, or other
   users' grants.
6. A user that is blocked, soft-deleted, provisional, removed from an org, or
   otherwise ineligible MUST NOT receive a gateway token or runtime access.
7. A valid JWT MUST NOT by itself authorize runtime access after route rotation,
   config disable/delete, membership removal, assignment removal, instance
   removal, grant revocation, or user ineligibility.
8. The Worker MUST re-check current eligibility on every authenticated runtime
   request.

## Config And Connection Lifecycle

1. Each config has one remote URL, one auth mode, one sharing mode, one active
   route, and optional config-level metadata/headers.
2. Supported auth modes are `none`, `static_headers`, `oauth_dynamic`, and
   `oauth_static`.
3. Supported sharing modes are `single_user` and `multi_user`.
4. A personal config MUST use `single_user`.
5. An org `single_user` config MUST have exactly one active assignee at a time.
   Reassignment MUST revoke/remove the prior assignee's instance and grant before
   the new assignment becomes active.
6. An org `multi_user` config may have one non-terminal instance per assigned user.
7. A connection instance is created lazily only after the user is currently
   authorized for the config.
8. An instance may be `active`, `needs_reauth`, `revoked`, or `removed`.
9. Only an `active` instance is usable for runtime access or token issuance.
10. A `needs_reauth` instance may remain as a recoverable non-terminal record but
    MUST require provider reauthorization before becoming usable again.
11. Terminal instances MUST NOT be reused or reactivated for a later assignment.
12. Config changes to remote URL, auth mode, sharing mode, static provider
    credentials, or other material auth inputs MUST revoke dependent grants and
    cancel pending provider authorization before the changed config becomes active.
13. Static header rotation is not a material provider-grant change in v1. It must
    apply to subsequent upstream requests but does not require deleting instances.
14. Registry metadata changes MUST NOT revoke grants, rotate routes, or create
    per-user state.
15. Deleting a config MUST invalidate its route and revoke/delete all dependent
    instances, grants, and pending provider state.

## OAuth Client Registration

1. Dynamic registration is supported and is required for normal MCP clients.
2. Clients use externally visible `namespace:name` IDs.
3. Public registration is allowed before user authentication and MUST be rate
   limited to 10 attempts per minute per trusted client IP bucket.
4. Registration MUST use a trusted platform-provided IP source. Generic
   client-supplied forwarded headers MUST NOT be trusted for this unauthenticated
   rate limit.
5. Registration metadata MUST require at least one redirect URI, supported grant
   types, supported response types, supported token endpoint auth method, and
   scopes from the gateway vocabulary.
6. Unsupported declared scopes MUST be rejected, not silently broadened.
7. Resource-specific registration MUST validate that the referenced scoped route
   exists and is discoverable, but discovery MUST NOT imply runtime authorization.
8. Public clients using `token_endpoint_auth_method=none` MUST use PKCE.
9. Confidential clients MAY use `client_secret_basic` or `client_secret_post`.
10. The token endpoint MUST enforce the registered auth method exactly and reject
    mismatched secret transport.

## First-Level Authorization And Tokens

1. Authorization requests require client ID, redirect URI, response type, and a
   scoped resource identity supplied by route form or `resource` parameter.
2. If both route form and `resource` are supplied, they MUST identify the same
   canonical scoped route.
3. The app MUST validate current execution context, route, owner, membership,
   assignment, config status, user eligibility, and instance state before issuing
   an authorization code.
4. Authorization requests expire within 30 minutes.
5. Authorization codes expire within 10 minutes, are opaque, and MUST be consumed
   atomically with expiry enforced in the conditional update.
6. Authorization codes bind client ID, redirect URI, canonical route URL, route
   key, scopes, PKCE challenge, execution context, user, and instance.
7. Refresh tokens bind the same identity and route context as the original code.
8. Refresh tokens rotate on use and MUST be consumed atomically.
9. Before issuing any access token from a code or refresh token, the app MUST
   re-resolve current route, eligibility, config status, assignment, instance,
   and execution context.
10. Gateway access tokens are RS256 JWTs with a 15-minute lifetime.
11. Gateway JWT claims MUST include `sub`, `aud`, `exp`, `iat`, `scope`, `MCPID`,
    `owner_scope`, `owner_id`, `config_id`, `route_key`, `instance_id`,
    `execution_context`, and `config_version`.
12. `aud` MUST equal the exact canonical scoped route URL.
13. `MCPID` MUST equal `{owner_scope}:{owner_id}:{config_id}:{route_key}`.
14. The Worker MUST verify signature, algorithm, issuer, audience, expiry, route
    identity, owner tuple, instance ID, and execution context before proxying.
15. Derived connect tokens use the same JWT contract and lifetime but do not
    issue refresh tokens.
16. Raw Kilo session/user tokens MUST NOT be accepted as runtime bearer tokens
    on `/mcp-connect/...` and MUST NEVER be forwarded upstream.

## Provider Authorization And Grants

1. Provider OAuth is considered only for `oauth_dynamic` and `oauth_static`
   configs.
2. `none` and `static_headers` configs complete first-level authorization without
   provider OAuth.
3. A provider grant belongs to exactly one connection instance and MUST NOT be
   shared across users, configs, owners, or scopes.
4. Provider access tokens, refresh tokens, provider client IDs, client secrets,
   static header secrets, pending state, authorization codes, refresh tokens,
   and PKCE verifiers are sensitive material.
5. Provider grants and pending provider authorization state MUST be encrypted at
   rest.
6. Pending provider authorization MUST bind owner scope, owner ID, user ID,
   config ID, config version, instance ID, canonical route, remote URL, auth
   mode, provider credentials, authorization endpoint, token endpoint, redirect
   URI, scopes, PKCE verifier, execution context, and first-level authorization
   request ID when applicable.
7. Sensitive provider credentials, including provider client ID, MUST be inside
   encrypted pending state rather than stored as plaintext pending columns.
8. Pending state is opaque, one-time, expires within 30 minutes, and MUST be
   consumed atomically on success, provider error, expiry, or invalid callback.
9. Provider error callbacks MUST consume pending state and MUST NOT create a grant.
10. Provider callback success MUST persist the grant before the app issues a final
    authorization code.
11. Provider responses MUST be size-capped before JSON parsing and validated with
    the relevant schema.
12. Only bearer provider tokens are supported in v1. Non-bearer provider token
    types MUST be rejected.
13. Grant versioning is monotonic per instance. Creating, replacing, revoking, or
    deleting a grant MUST advance the version; replacement MUST NOT reset it.
14. Provider refresh is lazy and happens only during runtime proxying.
15. Refresh failure MUST move the instance to `needs_reauth` without overwriting a
    newer app-side revoke/replacement.
16. A provider grant may be restored only by a successful provider authorization
    for the same non-terminal instance.

## Worker Runtime Proxy

1. The Worker is the only upstream credential injection boundary.
2. On every authenticated runtime request, the Worker MUST verify the gateway JWT
   and fresh Postgres state before proxying.
3. The Worker MUST reject stale route keys, disabled/deleted configs, wrong owner
   scope, wrong execution context, missing membership, missing assignment,
   ineligible users, removed instances, missing grants, and version conflicts.
4. The client `Authorization` header is only for gateway authentication and MUST
   NOT be forwarded upstream.
5. The Worker MUST use an explicit allowlist for transient client headers and
   strip credential-like headers including `Authorization`, `Proxy-Authorization`,
   `Cookie`, `X-API-Key`, `X-Auth-*`, `X-Token-*`, and configured static
   credential names.
6. Static headers and auxiliary headers MUST have valid header names/values and
   MUST NOT be hop-by-hop or credential-confusing.
7. At most one auth source may own upstream `Authorization`.
8. In OAuth modes, the Worker injects the requesting user's bearer provider token.
9. In static-header mode, the Worker injects only the config's static credential
   headers and allowed auxiliary headers.
10. The Worker MUST validate any incoming `Origin` header before credential
    injection. Origin-less non-browser clients are allowed; supplied origins MUST
    match a configured gateway/app origin or be rejected.
11. The Worker MUST stream request and response bodies and MUST NOT buffer unknown
    proxy bodies.
12. The Worker MUST reject non-public HTTPS upstream destinations, including
    loopback, private, link-local, reserved, and non-public IPv4/IPv6 results.
13. DNS validation MUST consider both A and AAAA answers and fail closed when the
    destination cannot be safely validated. Because Workers cannot pin arbitrary
    third-party DNS answers across zones, this is a best-effort defense rather than
    a complete DNS-rebinding guarantee for untrusted external origins.
14. The Worker MUST NOT follow upstream redirects in v1. It may return 3xx
    responses to clients, but it must not forward injected credentials to a
    redirect target.
14. The Worker MUST NOT expose a provider token-exchange API.

## Audit, Privacy, And Cleanup

1. The system MUST record sanitized audit events for config creation/update/
   disable/delete, route rotation/revocation, assignment change, authorization
   outcome, provider authorization outcome, provider grant change, refresh
   outcome, and runtime usage.
2. Audit events MUST include actor when available, owner scope, owner ID, config
   ID, route/instance IDs when applicable, event type, outcome, timestamp, and
   non-secret correlation metadata.
3. Logs, traces, audit events, diagnostics, and user-visible errors MUST NOT
   contain provider tokens, refresh tokens, provider client secrets, static
   header secrets, gateway refresh tokens, authorization codes, PKCE verifiers,
   auth headers, cookies, or raw provider payloads.
4. Soft-delete or anonymization of a user MUST remove or anonymize user-associated
   instances, provider grants, pending provider state, and other sensitive
   gateway material while retaining only non-sensitive audit history where
   required.
5. Org removal MUST revoke/remove the user's org instances, grants, assignments,
   and pending provider state immediately.
6. Audit rows older than 60 days MAY be removed by the Worker cleanup job.

## Error Handling

1. Missing or invalid runtime credentials MUST return a challengeable `401` and
   MUST NOT proxy traffic.
2. A valid JWT whose current route, owner, context, assignment, config, user,
   instance, or grant state is no longer eligible MUST return a generic forbidden
   response and MUST NOT proxy traffic.
3. Unknown, revoked, rotated, or deleted routes MUST fail closed without revealing
   owner details.
4. Invalid registration metadata MUST return a stable client error.
5. Invalid authorization requests before redirect URI trust is established MUST
   return direct bad-request responses.
6. Invalid authorization requests after redirect URI validation MUST return an
   OAuth error through the trusted redirect.
7. Unknown, expired, or consumed authorization codes and refresh tokens MUST NOT
   issue tokens.
8. Unknown, expired, consumed, or context-mismatched provider state MUST NOT
   create grants.
9. Provider refresh failure MUST return a bounded auth failure and MUST NOT expose
   provider secrets or raw provider payloads.
10. Retries and concurrency MUST NOT allow duplicate code consumption, refresh
    token consumption, pending-state use, or cross-user grant effects.

## Out Of Scope For V1

- Opaque `/mcp-connect/{connect_id}` compatibility.
- Worker-owned first-level OAuth endpoints.
- Global gateway Durable Objects or config-level DO serialization.
- D1 as an additional gateway index store.
- Per-user static header inputs or per-user API-key headers.
- Group/team assignment.
- External `/v0.1/servers` registry projection.
- A Worker-side provider token-exchange API.
- Dashboard UI or feature-flagged management pages.
