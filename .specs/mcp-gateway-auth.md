# Kilo MCP Gateway Authentication and Remote OAuth Brokerage

## Role of This Document

This spec defines the externally observable security, ownership, lifecycle, and
compatibility rules for the Kilo MCP Gateway v1. The gateway is a new
first-class Kilo product that exposes OAuth-protected MCP connect resources and
brokers upstream credentials for remote MCP servers.

The gateway implements a standards-compatible MCP OAuth protected-resource
surface: protected-resource metadata, dynamic OAuth client registration,
authorization-code plus refresh-token flows, second-level upstream OAuth, PKCE,
user-info, and standards-compatible MCP client behavior. Kilo intentionally
does not include server/catalog/instance taxonomy, composite server model, shim
runtime, or an external token-exchange boundary in v1.

This document is the source of truth for what a clean-room-compatible Kilo
implementation must guarantee: public protocol behavior, ownership boundaries,
config lifecycle, assignment rules, remote-provider authorization, token
lifecycle, worker-side credential injection, and secret handling.

It deliberately does not prescribe internal handler names, database tables,
queue wiring, Cloudflare Worker module structure, or Next.js implementation
details. The gateway is expected to be a dedicated Cloudflare Workers service;
the Next.js UI is a client of its internal APIs and is not an authorization
boundary.

## Status

Draft -- revised 2026-06-02 for the Kilo MCP Gateway v1 product model.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in BCP 14
[RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as
shown here.

## Definitions

- **Gateway**: The Kilo MCP-facing worker service that authenticates callers,
  resolves connect resources, enforces ownership and assignment, injects
  upstream credentials, and proxies authorized traffic to a remote MCP server.
- **Connect resource**: A protected MCP resource exposed at
  `/mcp-connect/{connect_id}`. A connect resource identifies exactly one
  gateway config in v1 and resolves at runtime through that config to the
  caller's connection instance.
- **Gateway config**: A first-class Kilo connection definition that owns one
  configured remote MCP endpoint, one auth mode, one connection sharing mode,
  one stable connect resource, one ownership scope, any config-level
  credentials or auxiliary headers, and optional registry metadata. A config may
  be user-specific in `single_user` mode or shared across users in `multi_user`
  mode.
- **Connection instance**: A per-user record associated with one gateway config.
  In v1, at most one non-terminal connection instance may exist for each
  `(owner_scope, owner_id, user_id, config_id)` tuple. It holds per-user
  connection state, provider-grant association, and lifecycle metadata. It
  inherits the config's remote endpoint and has no per-user header inputs in
  v1.
- **Connection sharing mode**: Either `single_user` or `multi_user`. This
  describes who shares a configured remote endpoint, independent of where the
  remote MCP server runs.
- **Single-user connection**: A config relationship in which one config is used
  by exactly one user and has at most one non-terminal connection instance at a
  time. A personal config has one instance for its owner once instantiated. An
  org single-user config has one instance for one explicitly assigned user once
  instantiated. If another user needs the same upstream, they receive a separate
  config and connection instance.
- **Multi-user connection**: A config relationship in which one org config may
  be assigned to multiple users and all of their connection instances use one
  shared configured remote endpoint. Per-user OAuth grants may still distinguish
  users upstream, while config-level static headers represent one shared
  upstream identity.
- **Owner scope**: Either `personal` or `organization`. Every config and every
  connect resource has exactly one owner scope.
- **Execution context**: The caller's active Kilo context for a request: either
  personal context or one specific organization context. OAuth authorization,
  refresh, derived-token minting, and runtime proxying MUST each resolve or
  carry an execution context from authoritative Kilo identity data.
- **Personal owner**: The Kilo user who owns a personal gateway config.
- **Organization owner**: The Kilo organization that owns an org gateway
  config.
- **Assigned user**: A user explicitly allowed to use an org-owned gateway
  config. Group assignment is out of scope for v1.
- **Gateway OAuth client**: An MCP client registered with the gateway OAuth
  authorization server. Its identity is represented externally as
  `namespace:name`.
- **Gateway authorization request**: The first-level OAuth authorization-code
  transaction between an MCP client and the gateway.
- **Gateway authorization token**: A short-lived gateway-issued bearer JWT
  bound to one user, one connect resource, one owner scope, one scope set, and
  one expiration.
- **Kilo user token**: An existing Kilo-issued user JWT carrying at least
  `kiloUserId`, `apiTokenPepper`, and `version`, with optional organization
  context. It is used only to mint a derived connect-scoped gateway token for
  non-OAuth clients.
- **Derived connect token**: A short-lived gateway authorization token minted
  from a valid Kilo user token. It is not the Kilo user token itself.
- **Remote provider**: A third-party OAuth authorization server used by a
  remote MCP server.
- **Remote provider authorization**: The second-level OAuth transaction that
  obtains a provider grant for a remote MCP server after gateway authorization
  has identified the user and config.
- **Pending remote authorization**: An opaque one-time state value that binds
  a remote-provider callback to the owner scope, owner ID, user ID, config ID,
  config version or material-state fingerprint, connection instance ID, connect
  ID, remote URL, OAuth client credentials, scopes, redirect URI, and PKCE
  verifier.
- **Provider grant**: A third-party access/refresh token set held on behalf of
  one user for one connection instance.
- **Static provider credential**: A config-level upstream OAuth client ID and
  client secret used as the provider app identity for a static OAuth config.
- **Static header credential**: A config-level fixed secret header set, such as
  `Authorization` or `X-API-Key`, injected by the gateway on upstream requests.
- **Registry metadata**: Optional display and discovery fields attached to a
  gateway config: `title`, `description`, `iconUrl`, `vendor`, `tags`, and
  `registryName`. Registry metadata is not an authorization boundary and is not
  used for runtime routing.
- **Registry name**: An optional stable discovery name for a gateway config.
  Registry names are used only in list and display projections. Runtime access
  MUST continue to use the opaque connect ID.
- **Audit event**: A durable, non-secret record of a gateway lifecycle,
  authorization, grant, assignment, or usage event. An audit event identifies
  actor, owner scope, owner ID, config ID, connect ID when applicable, event
  type, outcome, timestamp, and correlation metadata, but never contains
  credentials or raw token material.
- **Auxiliary header**: A config-level non-auth header that may be sent upstream
  alongside an auth credential. Auxiliary headers are not secrets and MUST NOT
  include `Authorization`, `Proxy-Authorization`, or any header name reserved
  for a static header credential.
- **Provisional identity**: An identity that is not eligible to receive a
  user-facing gateway authorization result, including bootstrap-style or
  otherwise incomplete identities.

## Overview

The gateway has three distinct auth boundaries:

1. An MCP client obtains a short-lived gateway authorization token for one
   connect resource.
2. The gateway resolves the opaque connect ID to one config, resolves or creates
   the caller's connection instance, and enforces owner scope, org membership,
   assignment, config status, and user eligibility.
3. If the config requires upstream OAuth, the gateway brokers a separate
   provider authorization for that connection instance and injects the resulting
   provider token on upstream requests.

The key separation is that the gateway authorization token is not the provider
credential. The MCP client authenticates to the gateway, not directly to the
remote provider. A provider grant belongs to one connection instance and is
never exposed to the client. Static provider credentials and static headers are
config-level secrets, while provider grants remain per-user.

Remote endpoint location and connection sharing are separate concerns. A remote
config may represent a single-user connection or a shared multi-user endpoint.
In `single_user` mode, one user receives one config and one connection instance.
In `multi_user` mode, multiple user instances share one configured upstream
endpoint. A shared endpoint is safe when the upstream supports per-user OAuth or
another intentional shared identity model. If a shared endpoint uses only one
static credential and no user-distinguishing upstream auth, all assigned users
act as that same upstream identity.

In v1, the worker itself is the upstream credential boundary. Kilo does not
expose provider tokens through an external token-exchange API. The worker
resolves the config and current user's connection instance, checks the caller,
loads or refreshes the upstream credential, injects it, and proxies the request.

## Rules

### Scope and Compatibility Boundary

1. The system MUST provide one stable connect-resource surface at
   `/mcp-connect/{connect_id}` for every enabled gateway config.
2. Each gateway config MUST own exactly one stable connect resource in v1.
3. A connect ID MUST be a high-entropy URL-safe opaque identifier and MUST NOT
   reveal a user ID, org ID, config ID, or creation order.
4. A connect ID MUST remain stable for the lifetime of its config unless an
   owner explicitly rotates or revokes it.
5. The system MUST support the connect root path for the methods required by
   Streamable HTTP and SSE MCP clients.
6. The system MUST support descendant paths on the connect surface, but it MUST
   preserve a descendant path only when the config explicitly enables path
   passthrough.
7. The system MUST expose an OAuth authorization-server metadata surface,
   protected-resource metadata surface, dynamic client registration surface,
   OAuth authorization surface, token surface, JWKS, user-info surface, and
   upstream OAuth callback surface with the following public shape:

   | Surface | Required behavior |
   |---|---|
   | `GET` or `POST /mcp-connect/{connect_id}` | Protected resource entrypoint; unauthenticated callers receive an OAuth challenge and authorized callers are proxied to the config's remote MCP endpoint. |
   | `GET /.well-known/oauth-authorization-server` | Returns authorization-server metadata. |
   | `GET /.well-known/oauth-authorization-server/oauth/authorize` | Returns authorization-server metadata as an alias for clients that discover metadata from the authorization route. |
   | `GET /.well-known/oauth-protected-resource` | Returns generic gateway protected-resource metadata. |
   | `GET /.well-known/oauth-protected-resource/mcp-connect/{connect_id}` | Returns connect-specific protected-resource metadata. |
   | `POST /oauth/register` and `POST /oauth/register/{connect_id}` | Creates a gateway OAuth client registration. The resource-specific form supports clients that do not use protected-resource metadata. |
   | `GET`, `PUT`, and `DELETE /oauth/register/{client_id}` | Reads, updates, or deletes an existing dynamic registration when authorized by its registration token. |
   | `GET /oauth/authorize` and `GET /oauth/authorize/{connect_id}` | Starts the first-level authorization-code flow. The generic form requires a `resource` parameter. |
   | `GET /oauth/callback/{request_id}` | Completes first-level login and decides whether upstream OAuth is required. |
   | `POST /oauth/token` and `POST /oauth/token/{connect_id}` | Issues access tokens for authorization-code and refresh-token grants. |
   | `GET /oauth/mcp/callback` | Completes second-level provider authorization. |
   | `GET /oauth/jwks.json` | Publishes verification keys for gateway JWTs. |
   | `GET /oauth/userinfo` | Returns user information for authorized tokens with the required scope. |
   | `GET /api/mcp-gateway/available` | Returns the gateway configs currently usable by the authenticated user in the current execution context. |

8. The system MUST support dynamic registration for Kilo's normal MCP client
   flow. Kilo is a normal dynamically registered public OAuth client in v1,
   not a hardcoded first-party client.
9. A clean-room implementation MAY add internal APIs or additional public
   endpoints, but it MUST NOT change the semantics of the compatibility surface
   above.
10. The system MUST NOT treat internal package names, database rows, worker
    module layout, or UI routing as part of the public contract.
11. Kilo profiles are out of scope for this product. A gateway config MUST NOT
    inherit ownership, authorization, or credential behavior from a profile in
    v1.

### Owner Model and Cross-Scope Restrictions

1. Every gateway config MUST be owned by exactly one owner scope: `personal` or
   `organization`.
2. Every connect resource MUST inherit the owner scope and owner ID of its
   config.
3. Every authorization, refresh, derived-token minting, and runtime request
   MUST resolve an execution context before evaluating config access.
4. A personal config MUST be usable only in personal execution context.
5. An org config MUST be usable only in org execution context.
6. Cross-scope use is not allowed in v1. A personal config MUST NOT be used in
   an org context, and an org config MUST NOT be used in a personal context.
7. A personal config MUST be usable only by its personal owner.
8. An org config MUST be usable only by users explicitly assigned to it.
9. Organization owners and admins MUST be able to create, edit, disable,
   delete, rotate, and assign org configs.
10. Organization owners and admins MUST NOT be implicitly allowed to use an org
    config unless they are also explicitly assigned to it.
11. Assigned org users MUST be able to use an org config and manage only their
    own connection instance and provider grant for that config.
12. Assigned org users MUST NOT be able to edit the config, change assignments,
    rotate shared credentials, or revoke another user's connection instance or
    provider grant.
13. Org configs MUST be visible to unassigned org members but unavailable to
    them.
14. A personal config MUST be visible only to its owner.
15. Group-based assignment is out of scope for v1.
16. The gateway MUST re-check owner scope, current org membership, assignment,
    config status, and user eligibility on every authenticated runtime request.
17. A valid gateway token MUST NOT by itself authorize access to a config when
    current ownership, membership, assignment, or config status has changed.

### Connection Sharing Model

1. Every gateway config MUST declare a connection sharing mode: `single_user` or
   `multi_user`.
2. A personal config MUST use `single_user` sharing mode and MUST have at most
   one non-terminal connection instance for its personal owner.
3. An org config MAY use either `single_user` or `multi_user` sharing mode.
4. An org `single_user` config MUST have exactly one assigned user and at most
   one non-terminal connection instance at a time.
5. Reassigning an org `single_user` config to a different user MUST revoke or
   delete the prior user's connection instance and provider grant before the new
   assignment becomes active.
6. If a second user needs the same upstream as an org `single_user` config, the
   system MUST create or require a separate config and connection instance for
   that user.
7. Two `single_user` configs MAY point at the same remote URL, but they MUST
   remain separate config and connection-instance boundaries.
8. In `multi_user` mode, each assigned user MAY have an independent connection
   instance. When an instance exists, it MUST use the config's shared remote
   endpoint and shared config-level connection definition.
9. An org `multi_user` config MAY be assigned to one or more users, and all
   assigned users' instances route to the same configured remote endpoint.
10. Connection sharing mode MUST NOT weaken owner scope, org membership,
    assignment, config status, connection-instance lifecycle, or runtime
    authorization checks.
11. A config using OAuth MUST inject the requesting user's provider grant and MAY
    therefore preserve per-user upstream identity, whether the config is
    single-user or multi-user.
12. Any config using `static_headers` or `none` MUST be treated as a shared
    upstream identity unless the upstream service independently distinguishes
    users.
13. Static header credentials are config-level only in v1. The system MUST NOT
    support per-user static header inputs or per-user API-key header values in
    v1.
14. If a shared remote endpoint requires per-user header secrets instead of
    OAuth, that capability is out of scope for v1 and the config MUST NOT claim
    to provide per-user upstream identity.
15. The three supported v1 scenarios are:
    - a personal user adding a personal single-user config with one instance
    - a user adding an org-owned single-user config for their own instance
    - a user adding an org-owned multi-user config for shared endpoint use with
      per-user instances

### Config and Connect Lifecycle

1. A config MUST have exactly one configured remote endpoint URL and exactly one
   auth mode in v1.
2. A config MUST be a connection definition and MUST NOT directly store per-user
   provider grant state, per-user connection status, or per-user header inputs.
3. The supported auth modes in v1 are:
   - `none`
   - `static_headers`
   - `oauth_dynamic`
   - `oauth_static`
4. A config MAY carry auxiliary non-auth headers in addition to its auth mode.
   Auxiliary headers MUST be distinct from static header credentials and MUST
   NOT contain `Authorization`, `Proxy-Authorization`, or any configured
   credential header name.
5. A config in `none` mode MUST proxy without an upstream credential, but it
   MUST still enforce gateway authentication and assignment.
6. A config in `static_headers` mode MUST inject only its config-level header
   credentials and auxiliary headers and MUST NOT create provider grants.
7. A config in `oauth_dynamic` mode MUST broker provider OAuth using dynamic
   provider-side registration or provider metadata discovery where supported.
8. A config in `oauth_static` mode MUST use its config-level static provider
   credential as the provider app identity.
9. Disabling a config MUST immediately block runtime use and new gateway token
   issuance, but MUST retain connection instances and provider grants for later
   re-enable.
10. Deleting a config MUST invalidate its connect resource and MUST revoke or
    delete all connection instances and provider grants associated with that
    config.
11. Rotating a connect ID MUST invalidate the old public connect resource and
    any outstanding gateway tokens bound to the old connect ID.
12. Revoking a connect resource without replacement MUST block runtime use and
    new gateway token issuance until a new connect ID is explicitly issued.
13. Rotating or revoking a connect resource MUST NOT automatically revoke
    connection instances or provider grants, because they are keyed to config
    identity rather than public connect identity.
14. A personal owner MAY explicitly revoke their own provider grant independently
    of connect rotation or connect revocation. Org owners and admins MAY bulk
    revoke all provider grants for an org config, but MUST NOT selectively revoke
    one other user's provider grant in v1 except as the required cleanup
    consequence of assignment removal, reassignment, org removal, config
    deletion, or material config mutation.
15. A disabled config, deleted config, or revoked connect resource MUST NOT be
    usable through a stale gateway token, stale Kilo token, stale provider
    grant, stale connection instance, or stale connect URL.
16. Changing a config's remote endpoint URL, auth mode, sharing mode, or any
    static provider credential field including client ID or client secret MUST
    revoke or delete all provider grants and cancel or delete all pending remote
    authorization state for that config before the edited config becomes active.
17. Changing a config from `multi_user` to `single_user` MUST reconcile
    assignments and connection instances so that exactly one assigned user and
    at most one non-terminal instance remain before the edited config becomes
    active.
18. Changing a config from `single_user` to `multi_user` MAY retain the existing
    assigned user's connection instance and MAY allow additional assigned users
    to create their own instances after the transition.
19. Editing registry metadata fields MUST NOT revoke provider grants, cancel
    pending authorization state, rotate connect IDs, or create per-user state.
20. Changing config-level auxiliary headers or static header credentials MUST be
    applied to subsequent upstream requests without creating per-user header
    state. Rotating static header credentials MAY trigger an owner-initiated
    incident response, but it MUST NOT require deleting connection instances.

### Connection Instance Lifecycle

1. The system MUST maintain at most one non-terminal connection instance for
   each `(owner_scope, owner_id, user_id, config_id)` tuple in v1.
2. A `single_user` config MUST have at most one non-terminal connection
   instance.
3. A `multi_user` config MAY have one non-terminal connection instance per
   assigned user.
4. A connection instance MUST be created lazily only after the user is currently
   authorized for the config and when first-level authorization begins, before
   upstream OAuth begins, during derived-token minting, or on a first
   authenticated runtime request.
5. The system MUST NOT create a connection instance for an unauthenticated,
   unassigned, cross-scope, disabled, or otherwise unauthorized user.
6. A connection instance MUST inherit the config's configured remote endpoint,
   auth mode, sharing mode, shared credentials, and auxiliary headers in v1.
7. A connection instance MAY hold per-user status, provider-grant association,
   last-used metadata, and non-secret connection metadata.
8. A connection instance MUST NOT hold any stored per-user header inputs in v1,
   including static header values, API-key header values, or per-instance
   auxiliary headers.
9. A connection instance MUST NOT hold per-user remote endpoint overrides in v1.
10. Allowlisted client-supplied upstream headers MAY be forwarded as transient
    request data, but MUST NOT be persisted as connection-instance header
    configuration.
11. Removing a user from an org config assignment MUST revoke or delete that
   user's connection instance and provider grant for that config immediately.
12. Removing a user from an org MUST revoke or delete all of that user's
    connection instances and provider grants for org-owned configs in that org
    immediately.
13. Disabling a config MUST retain its connection instances and provider grants
    for later re-enable.
14. Deleting a config MUST revoke or delete all of its connection instances and
    provider grants.
15. A connection instance MAY be in `active`, `needs_reauth`, or terminal
    `revoked`/`removed` state.
16. An `active` instance is usable only while its config, assignment, owner
    scope, and user eligibility remain current.
17. A `needs_reauth` instance remains present but MUST NOT be treated as having
    a usable provider grant until the user completes provider authorization
    again.
18. A `revoked` or `removed` instance MUST be terminal and MUST NOT be reused or
    reactivated for a later assignment. A later authorized connection requires a
    fresh non-terminal instance.
19. A terminal instance MAY be physically deleted or retained as a tombstone for
    audit purposes, but it MUST NOT count toward the non-terminal uniqueness
    rule and MUST NOT be usable for runtime access.
20. A user MAY revoke only their own provider grant for an allowed connection
    instance. Revoking a grant MUST NOT delete the connection instance unless
    the user explicitly removes the connection instance.
21. Org owners and admins MAY bulk revoke all provider grants for an org config,
    but MUST NOT selectively revoke one other user's connection instance or
    provider grant in v1 except as the required cleanup consequence of assignment
    removal, reassignment, org removal, config deletion, or material config
    mutation.

### Public Route Shape and Internal Management APIs

1. Public runtime and OAuth routes MUST be scope-agnostic and MUST NOT expose
   raw org IDs, user IDs, or owner scope in the path.
2. Any public route path segment that carries a resource identity MUST use only
   the opaque connect ID as that path-segment identity.
3. A full `resource` parameter MAY carry the canonical connect resource URL,
   but it MUST NOT carry any owner-specific path segment or arbitrary host.
4. Internal management APIs MUST use explicit owner namespaces in v1.
5. The recommended personal management route family is:
   - `GET /api/mcp-gateway/personal/configs`
   - `POST /api/mcp-gateway/personal/configs`
   - `GET /api/mcp-gateway/personal/configs/{config_id}`
   - `PATCH /api/mcp-gateway/personal/configs/{config_id}`
   - `DELETE /api/mcp-gateway/personal/configs/{config_id}`
6. The recommended org management route family is:
   - `GET /api/mcp-gateway/organizations/{org_id}/configs`
   - `POST /api/mcp-gateway/organizations/{org_id}/configs`
   - `GET /api/mcp-gateway/organizations/{org_id}/configs/{config_id}`
   - `PATCH /api/mcp-gateway/organizations/{org_id}/configs/{config_id}`
   - `DELETE /api/mcp-gateway/organizations/{org_id}/configs/{config_id}`
   - `GET` and `PATCH /api/mcp-gateway/organizations/{org_id}/configs/{config_id}/assignments`
7. The internal derived-token minting surface SHOULD use the same explicit
   owner namespaces, for example:
   - `POST /api/mcp-gateway/personal/configs/{config_id}/connect-token`
   - `POST /api/mcp-gateway/organizations/{org_id}/configs/{config_id}/connect-token`
8. `GET /api/mcp-gateway/available` MUST be an authenticated internal API that
   returns only configs the current user can actually use in the current
   execution context. It MUST NOT return org configs that are merely visible but
   unassigned.
9. Internal API route names MAY evolve without changing the public OAuth and
   MCP compatibility surface, but they MUST preserve the explicit owner
   namespace distinction.
10. The UI MUST NOT be treated as an authorization boundary. The worker MUST
   enforce all owner, membership, assignment, and config checks independently
   of the UI.

### Registry Metadata and Discovery

1. A gateway config MAY carry optional registry metadata fields: `title`,
   `description`, `iconUrl`, `vendor`, `tags`, and `registryName`.
2. Registry metadata MUST be display and discovery data only. It MUST NOT affect
   runtime authorization, connect resolution, provider grant ownership, or
   upstream credential injection.
3. A `registryName`, when present, MUST be stable, URL-safe, non-secret, and
   unique across the full set of configs usable by a given user in a given
   execution context. It MUST NOT encode owner IDs, config IDs, connect IDs, or
   other internal routing identifiers.
4. A config without `registryName` MAY still be usable through its connect
   resource and MAY appear in the internal available list, but it MUST NOT be
   projected into the external registry list unless it has an explicit stable
   discovery name.
5. The internal available list MUST authenticate through the standard Kilo user
   identity/session boundary and MUST NOT accept a connect-scoped gateway token
   as its listing credential.
6. The internal available list MUST include enough information for a Kilo client
   or UI to connect to a usable config, including at least `connectId`, canonical
   connect URL, owner scope, auth mode, sharing mode, registry metadata, and the
   current user's grant or authorization status.
7. The internal available list MUST NOT expose raw upstream URLs, owner IDs,
   config IDs, provider credentials, static header secrets, provider grant
   contents, or other users' grant state.
8. The system MAY add `GET /v0.1/servers` as a standard MCP registry list
   projection in a future revision, but it is not required in v1.
9. If an external registry projection is added later, it MUST use an explicit
   discovery authentication contract distinct from a connect-scoped gateway
   token.
10. If an external registry projection is added later, each entry MUST use
    `registryName` only as a discovery name and MUST point its remote URL at the
    canonical `/mcp-connect/{connect_id}` endpoint.
11. Registry names MUST NOT be accepted as runtime identifiers. Runtime access
    MUST continue to use only the opaque connect ID.
12. An external registry projection MAY support search, filtering, and
    pagination, but those features MUST NOT alter authorization semantics.

### Protected Resource and Gateway Authentication

1. An unauthenticated request to a connect resource MUST be treated as a
   challengeable request, not as successful remote MCP access.
2. A challengeable connect request MUST return `401` with
   `WWW-Authenticate` metadata that identifies the protected resource and the
   gateway authorization server.
3. Generic protected-resource metadata MUST identify the resource as
   `{base_url}/mcp-connect`.
4. Connect-specific protected-resource metadata MUST identify the resource as
   `{base_url}/mcp-connect/{connect_id}`.
5. A missing or invalid gateway credential MUST be treated as unauthenticated
   unless a system failure prevents verification.
6. A valid gateway authorization token MUST resolve to one authenticated user,
   one connect resource, one owner scope, one scope set, one execution context,
   and one expiration.
7. A gateway authorization token MUST include at least `sub`, `aud`, `exp`,
   `scope`, and `MCPID` claims.
8. The `aud` claim MUST equal the exact canonical connect resource URL
   `{base_url}/mcp-connect/{connect_id}`.
9. The `MCPID` claim MUST equal the opaque `connect_id` for the request.
10. The worker MUST compare the canonical root connect resource against both
    `aud` and `MCPID` before proxying.
11. A descendant request path, when allowed by config passthrough, MUST be
    authorized against the canonical root connect resource and then preserved
    separately as request path data.
12. The system MAY include internal config identity, owner scope, owner ID, and
    auth-source claims, but those claims MUST NOT replace runtime resolution and
    authorization checks.
13. Gateway authorization tokens issued through OAuth authorization-code,
    OAuth refresh-token, or Kilo-token-derived flows MUST use a 15-minute
    access-token lifetime in v1.
14. The system MUST publish a JWKS suitable for verifying gateway-issued JWTs.
15. The system MUST NOT issue a gateway authorization result to a provisional
    identity.
16. The system MUST NOT expose provider access tokens, refresh tokens, static
    provider client secrets, static header secrets, authorization codes, or
    PKCE verifiers to a normal MCP client.

### Client Registration and First-Level Authorization

1. The system MUST support dynamic registration of gateway OAuth clients.
2. A dynamically registered client MUST receive an externally usable client
   identifier in `namespace:name` form.
3. Dynamic registration MUST be allowed before the user is authenticated,
   because Kilo's MCP client registers before it has a gateway user session.
4. Public dynamic registration MUST be rate limited and MUST validate client
   metadata before accepting registration.
5. Registration validation MUST require at least one redirect URI, a supported
   token endpoint auth method, and scope values drawn from the gateway's
   supported scope vocabulary.
6. A resource-specific registration request MUST validate that the referenced
   connect ID exists and is eligible for discovery, meaning the config is
   enabled and the connect resource is not revoked. Discovery eligibility MUST
   NOT imply runtime authorization.
7. A resource-specific registration request MUST create a global gateway OAuth
   client registration rather than a client permanently bound to that connect
   resource.
8. The system MUST support Kilo's normal public-client metadata shape:
   `authorization_code` and `refresh_token` grants, `code` response type,
   `token_endpoint_auth_method=none`, and localhost redirect URIs.
9. The system MAY support confidential clients using `client_secret_post` or
   `client_secret_basic` when those methods are advertised by metadata.
10. A first-level authorization request MUST require `client_id`,
    `redirect_uri`, `response_type`, and a connect resource identity.
11. The system MUST reject a `client_id` that is not in `namespace:name` form.
12. The system MUST require the requested `redirect_uri` to match one of the
    registered redirect URIs exactly.
13. A connect identity MAY be supplied by the route-specific `{connect_id}` form
    or by the `resource` parameter.
14. If both `{connect_id}` and `resource` are supplied, the system MUST require
    them to refer to the same connect resource.
15. If neither route-specific connect ID nor `resource` identifies a connect
    resource, the system MUST reject the request with `invalid_request`.
16. The system MUST derive the final connect identity from the opaque connect ID
    and MUST NOT silently substitute one config for another because of a
    malformed resource, stale state, or fallback lookup.
17. A route-specific `resource` MUST use the gateway host and
    `/mcp-connect/{connect_id}` path shape. The gateway MUST reject a resource
    whose host or path does not exactly match the requested connect resource.
18. Public clients using `token_endpoint_auth_method=none` MUST provide PKCE.
19. Requested scopes MUST be filtered to the scopes declared by the registered
    client.
20. Unsupported requested scopes MUST be dropped rather than broadened or added
    to the authorization request.
21. Scope strings MUST NOT by themselves authorize a config. Actual access MUST
    come from connect resolution, owner scope, membership, assignment, and
    config status.
22. The system MUST NOT issue an authorization code until the user is
    authenticated, the config is resolved, the user is authorized for that
    config, and any required provider authorization is complete.
23. A first-level authorization request ID MUST be an opaque, unpredictable,
    one-time value.
24. A first-level authorization request MUST bind client ID, redirect URI,
    requested scopes, connect ID, canonical resource URL, OAuth state, PKCE
    challenge, execution context, and the eventual authenticated user.
25. A first-level authorization request MUST expire within 30 minutes and MUST
    be consumed atomically when it reaches a terminal success or error result.
26. A callback for a missing, expired, consumed, or context-mismatched request
    MUST fail without issuing a code or creating provider state.
27. Authorization codes MUST be opaque, one-time-use values and MUST be
    consumed atomically.
28. Authorization codes MUST expire within 10 minutes of issuance.
29. An authorization code MUST bind client ID, redirect URI, connect ID,
    canonical resource URL, granted scopes, PKCE challenge, execution context,
    and authenticated user identity.
30. The token endpoint MUST verify the code's client ID, redirect URI, connect
    ID, resource, scopes, execution context, and PKCE verifier before issuing
    an access token.
31. Before issuing any access token from an authorization code or refresh token,
    the token endpoint MUST re-resolve the bound connect resource and reject the
    request if the connect ID is rotated, revoked, deleted, disabled, or no
    longer authorized for the current user and execution context.
32. A token request to a route-specific `/oauth/token/{connect_id}` endpoint
    MUST match the connect ID bound to the authorization code or refresh token.
33. Refresh tokens MUST rotate on use and MUST be consumed atomically.
34. A refresh token MUST bind the same client ID, user, connect ID, canonical
    resource URL, owner scope, granted scopes, and execution context as the
    original authorization result.
35. A refresh-token request MUST present the same bound client identity and
    registered token endpoint auth method as the refresh token before the token
    is consumed.
36. Before issuing an access token from a refresh token, the system MUST
    re-check current execution context, owner scope, membership, assignment,
    config status, and user eligibility.
37. The authorization-code token response MUST return a bearer access token,
    an expiration, and a refresh token. The token type in this response MUST be
    lowercase `bearer`.
38. The refresh-token response MUST return a new access token, a new refresh
    token, an expiration, and lowercase `bearer` token type, and MUST preserve
    the same user, connect resource, owner scope, and config authorization
    context as the original result.

### Token Endpoint Client Authentication

1. The token endpoint MUST support `token_endpoint_auth_method=none` for public
   clients.
2. The token endpoint MUST NOT require a client secret when the registered
   client uses `none`.
3. The token endpoint MAY support `client_secret_post` and
   `client_secret_basic` for confidential clients when those methods are
   advertised in authorization-server metadata.
4. If a registered client uses a secret-based method, the token endpoint MUST
   verify the client secret before redeeming an authorization code or refresh
   token.
5. A confidential client with a missing, expired, or invalid secret MUST be
   rejected before any code or refresh token is consumed.
6. A token endpoint request with a malformed client ID, unsupported auth method,
   or unsupported grant type MUST be rejected before any code or refresh token
   is consumed.

### Scope and User Info

1. The gateway MUST publish a supported scope vocabulary in its authorization-
   server metadata.
2. A registered client MAY declare a subset of that vocabulary in its manifest
   or registration metadata.
3. The gateway MUST issue only the intersection of requested scopes and the
   client-declared subset.
4. The `profile` name in this section is an OAuth scope, not a Kilo profile
   feature.
5. The gateway MUST support `profile` as a meaningful scope for user-info and
   MAY support additional configured scope values.
6. The user-info surface MUST require `profile` scope. A token without that
   scope MUST receive `401 invalid_scope`.
7. A token whose user cannot be resolved MUST receive `403 invalid_token` from
   user-info without revealing whether the user exists.
8. When `profile` scope is present, `/oauth/userinfo` MUST return a response
   with required `sub` and MAY include the following fields when available:
   - `name`
   - `preferred_username`
   - `picture`
   - `zoneinfo`
   - `updated_at`
   - `email`
   - `email_verified`
9. The gateway MUST NOT expose additional user fields through user-info in v1.
10. A future `email` scope MAY further narrow email disclosure, but v1 retains
    email fields in the `profile`-gated user-info payload when available.

### Target Resolution and Authorization

1. In Kilo v1, a connect ID resolves to exactly one gateway config and one
   configured remote MCP endpoint.
2. The system MUST resolve a connect ID to its config before issuing a final
   gateway authorization result or proxying runtime traffic.
3. After resolving the config and authorizing the user, the system MUST resolve
   or create the caller's connection instance before starting upstream OAuth or
   proxying runtime traffic.
4. If a connect ID cannot be resolved safely, the system MUST fail closed and
   MUST NOT create a connection instance, provider state, authorization code,
   gateway token, or proxy traffic.
5. A config resolved from a connect ID MUST be checked for enabled status,
   owner scope, owner ID, current membership, assignment, and user eligibility.
6. A valid gateway token MUST be rejected when it refers to a rotated connect
   ID, disabled config, deleted config, missing membership, missing assignment,
   wrong execution scope, a revoked connection instance, or a connection
   instance that cannot be resolved or created for the currently authorized
   user.
7. An authenticated but unassigned user MUST receive a generic forbidden
   response and MUST NOT receive config details, connection-instance state,
   provider state, or a gateway token.
8. An unauthenticated request MAY receive the normal OAuth challenge even when
   the eventual user might not be assigned.
9. The system MUST NOT create a connection instance, provider state, or start
   upstream OAuth for a user who is not currently authorized for the config.

### Kilo Token Fallback

1. The Kilo user token fallback is not a separate gateway API-key subsystem.
2. The system MUST accept an existing Kilo user token only on the internal
   derived-token minting surface, not as a normal bearer credential on
   `/mcp-connect/{connect_id}`.
3. The system MUST validate the Kilo user token's signature, algorithm,
   expiry, version, `apiTokenPepper`, configured issuer and audience
   constraints, and current user status before minting a derived connect token.
4. For an org config, the system MUST also validate current org membership,
   organization execution context, and config assignment against authoritative
   Kilo data, not only token claims.
5. For a personal config, the system MUST validate that the token user is the
   personal owner and is in personal execution context.
6. Before minting a derived connect token, the system MUST resolve or create the
   caller's authorized connection instance for the config.
7. A derived connect token MUST be bound to exactly one connect resource and
   one owner scope.
8. A derived connect token MUST use the same 15-minute lifetime as OAuth-issued
   gateway access tokens.
9. The fallback flow MUST NOT issue a refresh token.
10. A non-OAuth client MUST renew by re-presenting a valid Kilo user token to
    the derived-token minting surface.
11. The derived-token minting surface MUST re-check current ownership,
    membership, assignment, config status, connection instance status, and user
    eligibility on every renewal.
12. The raw Kilo user token MUST NOT be forwarded to the remote MCP server.

### Remote Provider Authorization

1. Second-level provider authorization MUST be considered only for connection
   instances whose config is in `oauth_dynamic` or `oauth_static` mode.
2. Connection instances whose config is in `none` or `static_headers` mode MUST
   complete the first-level authorization flow without prompting for provider
   OAuth.
3. If a connection instance already has a valid provider grant, the system MUST
   NOT require an interactive provider prompt for that instance.
4. If a connection instance lacks a usable provider grant, the system MUST
   return an upstream authorization URL and MUST NOT issue the final gateway
   authorization code until provider authorization completes.
5. The provider callback URL MUST be stable and compatible with
   `/oauth/mcp/callback`.
6. A pending remote authorization MUST bind at least owner scope, owner ID,
   user ID, config ID, config version or material-state fingerprint, connection
   instance ID, connect ID, remote URL, auth mode, OAuth client credentials,
   authorization endpoint, token endpoint, redirect URI, scopes, PKCE verifier,
   and first-level authorization request ID when the provider flow was initiated
   from a first-level authorization flow.
7. A pending remote authorization state MUST be unpredictable, opaque,
   one-time-use, and consumed atomically.
8. The system MUST use pending state as the callback correlation key and MUST
   NOT rely only on a browser session to decide which grant is being authorized.
9. A pending state MUST expire within 30 minutes and MUST be rejected on read
   after expiry.
10. A pending remote authorization MUST be rejected if the bound config has been
    materially edited, disabled, deleted, or had its pending authorization state
    cancelled since the state was created.
11. A successful provider callback MUST exchange the provider code using the
    stored verifier and MUST persist the resulting provider grant on the bound
    connection instance before resuming the first-level authorization flow.
12. A successful provider callback initiated outside a first-level
    authorization flow MUST redirect to a completion page rather than issuing a
    gateway authorization code.
13. A successful provider callback initiated from a first-level authorization
    flow MUST resume that flow only when the current callback session is
    non-provisional, matches the initiating user, and the config and connection
    instance remain authorized.
14. A provider error or failed provider code exchange MUST consume the pending
    state and MUST NOT create a provider grant.
15. If provider-grant persistence fails after a successful provider exchange,
    the system MUST NOT pretend the flow completed successfully.
16. The system MUST NOT reuse a provider grant across two different configs or
    connection instances, even when their remote URLs or provider apps match.

### Static Provider Credentials and Static Headers

1. Static provider credentials MUST be allowed on both personal and org configs
   in v1.
2. Static provider credentials MUST be owned by the config owner, not by an
   individual assigned user.
3. A personal owner MUST be able to configure static provider credentials for
   their personal config.
4. Org owners and admins MUST be able to configure static provider credentials
   for an org config.
5. Static provider credentials MUST be shared only as the upstream app
   identity; each authorized user MUST still complete an individual provider
   authorization flow.
6. A config that requires static provider credentials and has none configured
   MUST NOT be usable for provider authorization by ordinary users.
7. The system MUST NOT reveal a static provider client secret after initial
   configuration.
8. Rotating or clearing static provider credentials MUST bulk revoke dependent
   provider grants and cancel or delete all pending remote authorization state
   for that config.
9. Static header credentials MUST be config-level secrets and MUST NOT be
   user-specific in v1.
10. A personal static-header config MUST be usable only by its owner.
11. An org static-header config MUST be usable only by assigned users.
12. Static header credentials MUST NOT be returned to clients, logs, audits,
    user-info, or error responses.
13. The system MUST reject hop-by-hop headers and MUST NOT allow a config to
    inject headers that break the gateway's security boundary.

### Provider Grant Storage and Refresh

1. Every provider grant MUST belong to exactly one connection instance.
2. In v1, the non-terminal connection instance identity MUST be
   `(owner_scope, owner_id, user_id, config_id)` and there MUST be at most one
   active provider grant for each non-terminal instance. Terminal tombstones MAY
   retain a distinct immutable instance ID for audit purposes without blocking a
   fresh non-terminal instance for the same tuple.
3. Provider grants MUST NOT be shared across users, connection instances,
   configs, owner scopes, or owners.
4. Replacing a provider grant for the same connection instance MUST replace the
   prior grant for that instance.
5. A remote URL MAY be retained as metadata, but it MUST NOT expand grant reuse
   across configs, instances, or owners.
6. Provider access tokens, refresh tokens, provider client IDs, provider client
   secrets, static header secrets, and pending-state secrets MUST be treated as
   sensitive material.
7. Provider grants and pending remote authorization state MUST be encrypted at
   rest in Kilo v1.
8. Provider refresh MUST be lazy: the worker MUST refresh only when an upstream
   request needs a token and the current token is expired or insufficient.
9. If refresh returns a changed access token, refresh token, or expiry, the
   stored provider grant MUST be updated on the same connection instance.
10. If refresh fails, the system MUST NOT return an unrelated token or silently
    treat the grant as valid. The user MUST be placed into a `needs_reauth`
    state for that connection instance.
11. A user MUST be able to revoke only their own provider grant for an allowed
    connection instance.
12. Org owners and admins MAY bulk revoke all provider grants for an org config,
    but MUST NOT selectively revoke one other user's connection instance or
    provider grant in v1 except as the required cleanup consequence of assignment
    removal, reassignment, org removal, config deletion, or material config
    mutation.
13. Removing a user from an org config assignment MUST revoke or delete that
    user's connection instance and provider grant for that config immediately.
14. Removing a user from an org MUST revoke or delete all of that user's
    connection instances and provider grants for org-owned configs in that org
    immediately.
15. Deleting a config MUST revoke or delete all connection instances and
    provider grants for that config.

### Worker-Side Credential Injection

1. The gateway worker MUST be the only component that injects upstream provider
   tokens or static header credentials in v1.
2. The worker MUST resolve the connect ID, verify the gateway token, re-check
   owner scope, membership, assignment, config status, execution context, and
   user eligibility, resolve the current user's connection instance, and then
   load the upstream credential before proxying each authenticated request.
3. The client-provided `Authorization` header MUST be used only for gateway
   authentication and MUST NOT be forwarded upstream.
4. The worker MUST use an explicit allowlist for client-supplied upstream
   headers and MUST strip all client-supplied credential or auth-like headers,
   including `Authorization`, `Proxy-Authorization`, `Cookie`, `X-API-Key`,
   `X-Auth-*`, `X-Token-*`, and any header name configured as a static header
   credential.
5. At most one auth source MAY own the upstream `Authorization` header.
6. In OAuth modes, the worker MUST inject the requesting user's provider access
   token as upstream `Authorization`.
7. In `static_headers` mode, the worker MUST inject the configured static
   header credential. If that credential uses `Authorization`, it MUST own the
   upstream `Authorization` header.
8. If a config is in an OAuth mode, configured auxiliary headers MAY be sent
   upstream, but they MUST NOT override the provider access token.
9. If a config is in static-header mode, configured auxiliary headers MAY also
   be sent upstream, but they MUST NOT override the configured static
   credential.
10. The worker MUST NOT expose provider tokens or static header secrets through
    response headers, response bodies, logs, traces, or diagnostics.
11. The worker MUST support both Streamable HTTP and SSE proxying in v1.
12. The worker MUST reject remote endpoints that are not public HTTPS endpoints,
    including loopback, private, link-local, or non-public destinations.
13. Redirects from a remote endpoint MUST satisfy the same public HTTPS policy
    before the worker follows them.
14. The worker MUST NOT expose an external provider token-exchange API in v1.

### Privacy, Audit, and Observability

1. The system MUST record an AuditEvent for config creation, update, disable,
   delete, connect rotation or revocation, assignment change, authorization
   outcome, provider authorization outcome, provider grant revocation, bulk
   revocation, and runtime usage.
2. Each AuditEvent MUST include actor identity when available, owner scope,
   owner ID, config ID, connect ID when applicable, event type, outcome,
   timestamp, and non-secret correlation metadata.
3. Logs, metrics, traces, audit records, diagnostics, and user-visible errors
   MUST NOT contain provider access tokens, refresh tokens, provider client
   secrets, static header secrets, gateway refresh tokens, authorization codes,
   raw bearer headers, PKCE verifiers, or raw provider callback payloads.
4. Personal users MUST be able to see their own config changes, auth events,
   grant state, and usage events for personal configs.
5. Org owners and admins MUST be able to see org config changes, assignment
   changes, bulk revocations, and aggregate usage for org configs.
6. Assigned users MUST be able to see only their own auth events, grant state,
   and usage events for org configs they are allowed to use.
7. Org owners and admins MUST NOT receive raw provider tokens, refresh tokens,
   static header secrets, authorization codes, or per-user secret material
   through audit visibility.
8. The system MUST retain only the minimum durable state required to resume
   authorization, refresh tokens, enforce ownership, support audit, and recover
   from failures.
9. Provider authorization failures and token refresh failures MUST be observable
   to operators without exposing secrets.
10. The system MUST avoid exposing whether another user's provider grant exists
    through error messages, timing-dependent behavior, or diagnostics.
11. When a user is deleted or anonymized, connection instances, provider grants,
    and pending state associated with that user MUST be removed or anonymized
    according to Kilo's privacy policy, while retaining only non-sensitive audit
    history where required.

## Error Handling

1. When a connect request has no valid gateway credential, the system MUST
   return a challengeable `401` response and MUST NOT proxy an authenticated
   upstream request.
2. When a connect request has a valid gateway token but owner scope,
   membership, assignment, config status, or connect ID validation fails, the
   system MUST return a generic forbidden response and MUST NOT create provider
   state or proxy traffic.
3. When a connect ID is unknown, revoked, rotated, or deleted, the system MUST
   return a stable not-found or forbidden result and MUST NOT disclose owner
   details.
4. When a config is disabled, the system MUST return a stable unavailable or
   forbidden result and MUST NOT issue a gateway token or proxy traffic.
5. When client registration metadata is invalid, the system MUST reject the
   registration with `invalid_client_metadata` or an equivalent stable client
   error.
6. When an authorization request is malformed before a redirect URI is trusted,
   the system MUST return a direct bad-request response.
7. When an authorization request fails after a redirect URI is validated, the
   system MUST return an OAuth error through that redirect URI.
8. When an authorization request has no connect identity, the system MUST
   return `invalid_request` and MUST NOT create an authorization request.
9. When a confidential token-endpoint client using a secret-based method has
   missing or invalid credentials, the system MUST return an unauthorized
   client-credential error.
10. When an authorization code is unknown, expired, or already consumed, the
    system MUST reject it and MUST NOT issue a token.
11. When a refresh token is unknown, expired, or already consumed, the system
    MUST reject it and MUST NOT issue a token.
12. When a Kilo user token is missing, invalid, stale, revoked, wrong-scope, or
    no longer authorized for the config, the derived-token minting surface MUST
    reject it and MUST NOT issue a gateway token.
13. When provider callback state is unknown, expired, or already consumed, the
    system MUST return a bad-request result and MUST NOT create a grant.
14. When a provider returns an OAuth error or the provider code exchange fails,
    the system MUST return a bad-request result, consume the pending state, and
    MUST NOT create a grant.
15. When provider refresh fails, the system MUST return a bounded upstream-auth
    failure and MUST NOT expose provider secrets or raw provider payloads.
16. Duplicate delivery, retries, and concurrent requests MUST NOT allow an
    authorization code, refresh token, pending state, or provider grant to be
    consumed in a way that produces duplicate or cross-user side effects.

## Protocol Baseline and Intentional Kilo Boundaries

Kilo v1 implements the following externally useful behaviors:

1. Protected-resource metadata and OAuth challenge behavior.
2. Generic and resource-specific OAuth route families for clients with and
   without protected-resource metadata support.
3. Dynamic OAuth client registration and registration management.
4. Authorization-code plus refresh-token OAuth flows.
5. PKCE for public clients using `token_endpoint_auth_method=none`.
6. Second-level upstream OAuth with `/oauth/mcp/callback`.
7. Client-declared scope filtering and profile-gated user-info.
8. JWKS publication and bearer JWT access tokens.
9. Authenticated available-MCP discovery through the internal available API.

Kilo v1 intentionally limits the product boundary to the following:

1. Kilo has first-class personal/org config ownership and does not introduce a
   server/catalog taxonomy in v1.
2. Kilo uses per-user connection instances under a shared config definition,
   rather than server-instance deployment records.
3. Kilo does not support composites, server hosting, or shim-based execution in
   v1.
4. Kilo injects upstream credentials in the worker and does not expose an
   external provider token-exchange API in v1.
5. Kilo keys connection instances and provider grants by owner scope, owner ID,
   user ID, and config ID.
6. Kilo requires encrypted provider secrets and pending state at rest in v1.
7. Kilo requires atomic consumption of authorization codes, refresh tokens, and
   pending remote state.
8. Kilo rejects provider callback state on read after expiry.
9. Kilo requires a route-specific resource to use the gateway host and exact
   connect path shape.
10. Kilo uses the existing Kilo user token only to mint a derived connect token,
    not as a direct runtime bearer credential.
11. Kilo does not implement generic API-key token exchange in v1.

## Not Yet Implemented

The following capabilities are intentionally out of scope for v1 and MAY be
added in a future revision:

1. Group-based org config assignment.
2. Cross-scope config use, including personal configs in org execution context
   or org configs in personal execution context.
3. Multiple connect resources per config.
4. Per-user connection-instance header inputs, including per-user static API-key headers.
5. Private or non-public remote endpoint allowlists.
6. Composite MCP configs and per-component upstream authorization.
7. External provider token exchange for a separate runtime component.
8. A first-party pre-registered Kilo OAuth client distinct from dynamic
   registration.
9. Per-config custom gateway scope policies beyond client-declared scope
   filtering.
10. External standard registry projection at `/v0.1/servers` and its dedicated
    discovery authentication contract.
11. Full registry management, catalog ingestion, publisher workflows, or server
    packaging beyond the lightweight config metadata and internal available list.
12. A separate `email` scope that narrows email disclosure beyond the v1
    profile-gated user-info payload.

