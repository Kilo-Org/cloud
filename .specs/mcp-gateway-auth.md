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
  Browser OAuth entry points that do not carry an organization header may establish
  org context from an org resource only after authoritative membership and assignment
  authorization against that exact resolved route.
- **Connection instance**: A per-user record associated with one config. In v1,
  there is at most one non-terminal instance for each
  `(owner_scope, owner_id, user_id, config_id)` tuple.
- **Provider grant**: A third-party access/refresh token bundle belonging to
  exactly one connection instance. Provider grants are never exposed to MCP
  clients.
- **Gateway OAuth client**: A dynamically registered OAuth client represented
  externally as `namespace:name`.
- **Gateway OAuth grant**: A durable, revocable authorization from one Kilo user
  to one Gateway OAuth client for one exact scoped connect resource, callback URI,
  execution context, connection instance, and scope set.
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
| `POST /api/mcp-gateway/oauth/register/resource/{scope}/{owner_id}/{config_id}/{route_key}` | App | Resource-specific registration after route eligibility discovery. |
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
6. The gateway scope vocabulary is `mcp:access` for use of the exact scoped MCP
   resource and `profile` for basic `/userinfo` claims. Every registered MCP client
   MUST declare `mcp:access`; `profile` is optional.
7. Unsupported declared scopes or declarations without `mcp:access` MUST be
   rejected, not silently broadened.
8. Resource-specific registration MUST validate that the referenced scoped route
   exists and is discoverable, but discovery MUST NOT imply runtime authorization.
9. Public clients using `token_endpoint_auth_method=none` MUST use PKCE.
10. Confidential clients MAY use `client_secret_basic` or `client_secret_post`.
11. The token endpoint MUST enforce the registered auth method exactly and reject
    mismatched secret transport.
12. Historical clients that declared only `profile` MUST receive
    `unauthorized_client` during authorization so standards-aware clients can discard
    the stale registration and dynamically register again with `mcp:access`.

## First-Level Authorization And Tokens

1. Authorization requests require client ID, redirect URI, response type, and a
   scoped resource identity supplied by route form or `resource` parameter.
2. If both route form and `resource` are supplied, they MUST identify the same
   canonical scoped route.
3. The app MUST validate current execution context, route, owner, membership,
   assignment, config status, user eligibility, and instance state before issuing
   an authorization code.
4. Interactive authorization MUST present dynamically registered client identity as
   unverified and MUST NOT present the self-asserted client name as verified identity.
5. Before approval, the consent screen MUST display the exact validated redirect URI,
   client ID, connection name, configured endpoint host, owner context, granting Kilo
   account, and a truthful description of the effective MCP access.
6. Consent MUST describe the effective MCP access independently of protocol scope
   labels.
7. Consent MUST provide explicit allow and deny actions. Denial MUST return
   `access_denied` only through the validated redirect URI, preserve OAuth `state`,
   and MUST NOT create authorization, provider, grant, or token state.
8. Browser approval MUST be bound to the granting user, exact redirect URI, client,
   resource, scopes, OAuth state, PKCE challenge, and execution context, and MUST
   expire under server-side validation within 5 minutes.
9. Consent responses MUST be non-cacheable, prevent framing, restrict form submission
   and redirects to the app origin, HTTPS destinations, and the exact validated HTTP
   loopback callback origin, suppress referrer disclosure, and avoid loading
   client-controlled remote assets.
10. Authorization requests expire within 30 minutes.
11. Authorization codes expire within 10 minutes, are opaque, and MUST be consumed
    atomically with expiry enforced in the conditional update.
12. Authorization codes bind client ID, redirect URI, canonical route URL, route
    key, scopes, PKCE challenge, execution context, user, and instance.
13. Refresh tokens bind the same identity and route context as the original code.
14. Refresh tokens rotate on use and MUST be consumed atomically.
15. Before issuing any access token from a code or refresh token, the app MUST
    re-resolve current route, eligibility, config status, assignment, instance,
    and execution context.
16. Gateway access tokens are RS256 JWTs with a 15-minute lifetime.
17. Gateway JWT claims MUST include `sub`, `aud`, `exp`, `iat`, `scope`, `MCPID`,
    `owner_scope`, `owner_id`, `config_id`, `route_key`, `instance_id`,
    `execution_context`, and `config_version`.
18. `aud` MUST equal the exact canonical scoped route URL.
19. `MCPID` MUST equal `{owner_scope}:{owner_id}:{config_id}:{route_key}`.
20. The Worker MUST verify signature, algorithm, issuer, audience, expiry, route
    identity, owner tuple, instance ID, and execution context before proxying.
21. Derived connect tokens use the same JWT contract and lifetime but do not
    issue refresh tokens.
22. Raw Kilo session/user tokens MUST NOT be accepted as runtime bearer tokens
    on `/mcp-connect/...` and MUST NEVER be forwarded upstream.
23. Authorization for a scoped MCP resource MUST request and grant `mcp:access`.
    `profile` alone and an omitted scope MUST return `invalid_scope`.
24. Authorization-code exchange MUST fail with `invalid_grant` if the persisted code
    does not contain `mcp:access`.
25. Refresh-token exchange MUST fail with `invalid_grant` before route or eligibility
    work and MUST NOT rotate a historical grant that lacks `mcp:access`.
26. Derived connect tokens MUST contain `mcp:access`; they do not implicitly receive
    `profile`.
27. `/userinfo` MUST require `profile`; possession of `mcp:access` alone MUST NOT
    disclose profile claims.
28. Successful interactive approval for a connection that does not require upstream
    provider authorization MUST create or reuse an active Gateway OAuth grant.
    Approval for a connection that still needs upstream provider authorization MUST
    create or reuse a pending Gateway OAuth grant and MUST promote it to active only
    after provider callback success. Denial MUST NOT create a grant.
29. Authorization requests, pending provider authorization, authorization codes,
    refresh tokens, and OAuth-client access JWTs MUST bind the same Gateway OAuth
    grant ID.
30. Reuse is allowed only when client, user, exact callback URI, scoped connect
     resource, connection instance, execution context, config version, and granted
     scopes are unchanged. A material binding change MUST revoke the old grant and
     create a new grant ID; a revoked grant MUST NOT be reactivated. Adding or
     removing `refresh_token` client grant capability is a material client metadata
     change because it changes whether the client can extend the approved access
     duration without another consent prompt.
31. OAuth-client JWTs MUST contain `token_source=oauth_client`, `oauth_grant_id`,
    and the external `client_id`. Derived connect tokens MUST contain
    `token_source=derived_connect` and MUST NOT contain OAuth client grant identity.
32. Code exchange, refresh, provider callback completion, `/userinfo`, and every
    OAuth-client runtime request MUST recheck the bound grant state. Runtime,
    `/userinfo`, code exchange, and refresh require an active grant; provider
    callback completion may consume only the matching pending grant and must leave a
    revoked or missing grant inactive.
33. Revoking a Gateway OAuth grant MUST immediately invalidate pending codes,
    refresh tokens, provider authorization attempts, and otherwise valid access
    JWTs bound to that grant. It MUST NOT revoke the connection instance, provider
    grant, config, route, or another client's Gateway OAuth grant.
34. Users MUST be able to list and revoke only their own Gateway OAuth grants,
    including grants for organization-owned connections they were authorized to use.

## Provider Authorization And Grants

1. Provider OAuth is considered only for `oauth_dynamic` and `oauth_static`
   configs.
2. `none` and `static_headers` configs complete first-level authorization without
   provider OAuth.
3. Gateway client scopes and upstream provider scopes are separate scope systems.
   Gateway client scopes come from the Kilo gateway vocabulary; upstream provider
   scopes come from explicit admin override or the remote MCP server's
   `WWW-Authenticate` challenge.
4. Upstream provider scopes MUST NOT be derived from `scopes_supported`.
5. When no upstream provider scope is known, the provider authorization request
   MUST omit `scope` rather than inventing a gateway scope such as `profile`.
6. The remote protected-resource `resource` value, when available, MUST be
   preserved in upstream provider authorization and token exchange requests.
7. A provider grant belongs to exactly one connection instance and MUST NOT be
   shared across users, configs, owners, or scopes.
8. Provider access tokens, refresh tokens, provider client IDs, client secrets,
   static header secrets, pending state, authorization codes, refresh tokens,
   and PKCE verifiers are sensitive material.
9. Provider grants and pending provider authorization state MUST be encrypted at
   rest.
10. Pending provider authorization MUST bind owner scope, owner ID, user ID,
    config ID, config version, instance ID, canonical route, remote URL, auth
    mode, provider credentials, authorization endpoint, token endpoint, redirect
    URI, upstream provider scopes, upstream provider resource when present, PKCE
    verifier, execution context, and first-level authorization request ID when
    applicable.
11. Sensitive provider credentials, including provider client ID, MUST be inside
    encrypted pending state rather than stored as plaintext pending columns.
12. Pending state is opaque, one-time, expires within 30 minutes, and MUST be
    consumed atomically on success, provider error, expiry, or invalid callback.
13. Provider error callbacks MUST consume pending state and MUST NOT create a grant.
14. Provider callback success MUST persist the grant before the app issues a final
    authorization code.
15. Provider responses MUST be size-capped before JSON parsing and validated with
    the relevant schema.
16. Only bearer provider tokens are supported in v1. Non-bearer provider token
    types MUST be rejected.
17. Grant versioning is monotonic per instance. Creating, replacing, revoking, or
    deleting a grant MUST advance the version; replacement MUST NOT reset it.
18. Provider refresh is lazy and happens only during runtime proxying.
19. Refresh failure MUST move the instance to `needs_reauth` without overwriting a
    newer app-side revoke/replacement.
20. A provider grant may be restored only by a successful provider authorization
    for the same non-terminal instance.
21. Changing upstream provider scopes, provider scope source, provider resource,
    provider authorization endpoint, provider token endpoint, or provider credentials
    is a material config change and MUST revoke pending provider authorization state,
    revoke active grants, and advance config version.

## Worker Runtime Proxy

1. The Worker is the only upstream credential injection boundary.
2. On every authenticated runtime request, the Worker MUST verify the gateway JWT
   and fresh Postgres state before proxying.
3. After JWT verification and before fresh runtime-state resolution, credential
   loading, provider refresh, or upstream access, the Worker MUST require
   `mcp:access`.
4. Before loading credentials, refreshing provider authorization, or proxying, the
   Worker MUST fresh-check the active Gateway OAuth grant for OAuth-client tokens
   against the JWT user, client, connection instance, exact connect resource,
   execution context, and scopes. Derived connect tokens skip only this grant check.
5. The Worker MUST reject stale route keys, disabled/deleted configs, wrong owner
   scope, wrong execution context, missing membership, missing assignment,
   ineligible users, removed instances, missing grants, and version conflicts.
6. The client `Authorization` header is only for gateway authentication and MUST
   NOT be forwarded upstream.
7. The Worker MUST use an explicit allowlist for transient client headers and
   strip credential-like headers including `Authorization`, `Proxy-Authorization`,
   `Cookie`, `X-API-Key`, `X-Auth-*`, `X-Token-*`, and configured static
   credential names.
8. Static headers and auxiliary headers MUST have valid header names/values and
   MUST NOT be hop-by-hop or credential-confusing.
9. At most one auth source may own upstream `Authorization`.
10. In OAuth modes, the Worker injects the requesting user's bearer provider token.
11. In static-header mode, the Worker injects only the config's static credential
    headers and allowed auxiliary headers.
12. The Worker MUST validate any incoming `Origin` header before credential
    injection. Origin-less non-browser clients are allowed; supplied origins MUST
    match a configured gateway/app origin or be rejected.
13. The Worker MUST stream request and response bodies and MUST NOT buffer unknown
    proxy bodies.
14. The Worker MUST reject non-public HTTPS upstream destinations, including
    loopback, private, link-local, reserved, and non-public IPv4/IPv6 results.
15. DNS validation MUST consider both A and AAAA answers and fail closed when the
    destination cannot be safely validated. Because Workers cannot pin arbitrary
    third-party DNS answers across zones, this is a best-effort defense rather than
    a complete DNS-rebinding guarantee for untrusted external origins.
16. The Worker MUST NOT follow upstream redirects in v1. It may return 3xx
    responses to clients, but it must not forward injected credentials to a
    redirect target.
17. The Worker MUST NOT expose a provider token-exchange API.

## Audit, Privacy, And Cleanup

1. The system MUST record sanitized audit events for config creation/update/
   disable/delete, route rotation/revocation, assignment change, authorization
   outcome, Gateway OAuth grant creation/revocation, provider authorization outcome,
   provider grant change, refresh outcome, and runtime usage.
2. Audit events MUST include actor when available, owner scope, owner ID, config
   ID, route/instance IDs when applicable, event type, outcome, timestamp, and
   non-secret correlation metadata.
3. Logs, traces, audit events, diagnostics, and user-visible errors MUST NOT
   contain provider tokens, refresh tokens, provider client secrets, static
   header secrets, gateway refresh tokens, authorization codes, PKCE verifiers,
   auth headers, cookies, or raw provider payloads.
4. Soft-delete or anonymization of a user MUST remove or anonymize user-associated
   instances, Gateway OAuth grants, provider grants, pending provider state, and
   other sensitive gateway material while retaining only non-sensitive audit
   history where required.
5. Org removal MUST revoke/remove the user's org instances, Gateway OAuth grants,
   provider grants, assignments, and pending provider state immediately.
6. Active Gateway OAuth grants MUST NOT be removed by age. Revoked grants MAY be
   deleted under an explicit retention policy.
7. Audit rows older than 60 days MAY be removed by the Worker cleanup job.

## Error Handling

1. Missing or invalid runtime credentials MUST return a challengeable `401` and
   MUST NOT proxy traffic.
2. A valid audience-bound JWT without `mcp:access` MUST return `403` with a
   `WWW-Authenticate` challenge containing `error="insufficient_scope"` and
   `scope="mcp:access"`, and MUST NOT resolve runtime state or proxy traffic.
3. A valid JWT whose current route, owner, context, assignment, config, user,
   instance, or grant state is no longer eligible MUST return a generic forbidden
   response and MUST NOT proxy traffic.
4. Unknown, revoked, rotated, or deleted routes MUST fail closed without revealing
   owner details.
5. Invalid registration metadata MUST return a stable client error.
6. Invalid authorization requests before redirect URI trust is established MUST
   return direct bad-request responses.
7. Invalid authorization requests after redirect URI validation MUST return an
   OAuth error through the trusted redirect.
8. Unknown, expired, or consumed authorization codes and refresh tokens MUST NOT
   issue tokens.
9. Unknown, expired, consumed, or context-mismatched provider state MUST NOT
   create grants.
10. Provider refresh failure MUST return a bounded auth failure and MUST NOT expose
    provider secrets or raw provider payloads.
11. Retries and concurrency MUST NOT allow duplicate code consumption, refresh
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
