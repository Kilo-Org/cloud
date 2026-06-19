# Contributing a KiloClaw Integration

This guide is for partners and contributors adding an external service to KiloClaw, Kilo's hosted OpenClaw product.

An integration can affect more than the settings UI. It may introduce credentials, OAuth grants, remote MCP traffic, code or instructions inside every customer runtime, recurring infrastructure work, and actions with external side effects. Design the integration as a production service boundary, not only as a successful API connection.

Discuss the architecture with the Kilo team before submitting a large implementation. Early review is especially important for OAuth, payments, personal data, remote MCP servers, new background jobs, image changes, and tools that create irreversible side effects.

## Start With the Smallest Integration

Prefer an integration that is self sufficient and uses existing KiloClaw capabilities.

Before adding code, identify which supported model fits the service:

| Model | Appropriate when | Examples |
|---|---|---|
| Static secret | The provider issues a revocable, persistent credential | Linear API key, 1Password service account |
| Vendor CLI session | A vendor CLI accepts a static credential and owns its resulting session | Composio, GitHub CLI |
| Native MCP OAuth | The MCP client and provider can own discovery, refresh, and token persistence | Preferred for OAuth enabled remote MCP servers |
| On demand token broker | Temporary tokens must remain centrally controlled and be refreshed only when used | Google Workspace |
| Kilo MCP Gateway | Runtime credential injection and lazy provider refresh should stay outside the customer instance | General remote MCP integrations |

An integration specific global polling job is not an accepted default architecture. If the proposed design requires Kilo to periodically scan every connected account, refresh credentials, and push updates through Durable Objects into customer runtimes, stop and review the design with the Kilo team.

## KiloClaw Runtime Model

Each KiloClaw instance is a dedicated OpenClaw runtime with persistent storage. The underlying compute provider is an implementation detail and may vary between environments. Local development uses the `docker-local` provider by default; integration behavior must not depend on one provider.

The main control path is:

```text
Kilo web app
  -> KiloClaw Cloudflare Worker
  -> KiloClawInstance Durable Object
  -> runtime provider
  -> instance controller
  -> OpenClaw gateway and integration client
```

This has several consequences:

- Writing a secret to Durable Object storage does not update a running process environment.
- Environment changes normally take effect when the runtime configuration is rebuilt and the runtime restarts.
- Persisted files survive restarts and must be explicitly updated or removed when credentials change.
- Calls into a running instance cross several network and authorization boundaries and may be delayed or fail independently.
- A control plane write must not be described as a successful runtime update unless the complete propagation path is implemented and tested.

Do not introduce repeated writes between system layers when the integration client or provider can manage its own session locally or credentials can be injected on demand.

## Credential Architecture

### Choose the credential model

There is no universal preference between native MCP OAuth and an on demand broker. Choose the model based on credential ownership, runtime trust, revocation requirements, provider support, and operational complexity.

| Model | Prefer when | Important tradeoffs |
|---|---|---|
| Native MCP OAuth | The provider and pinned MCP client support a reliable headless flow, safe token persistence, refresh token rotation, and concurrent requests | Keeps the integration self sufficient, but places provider grants and refresh behavior inside the hosted runtime and may reduce central visibility and control |
| On demand broker | Kilo needs central grant storage, immediate revocation, consistent reconnect status, auditability, or protection of refresh tokens from the hosted runtime | Adds a Kilo runtime service path, but refresh occurs only when the integration is used and follows existing Google Workspace and MCP Gateway patterns |
| Revocable integration credential | The provider can issue a stable, narrowly scoped credential that remains valid until disconnect or revocation | Simple and reliable, but the persistent credential is available to the hosted runtime |

For sensitive integrations, including payments or tools that expose personal data, prefer the on demand broker unless native MCP OAuth provides equivalent controls and has been validated in the exact client version used by KiloClaw. For lower risk integrations with mature MCP OAuth support, native MCP OAuth may be the simpler design.

A global refresh scheduler is not an accepted default. It requires prior architectural approval and a demonstrated reason that native client refresh, a revocable credential, and on demand refresh cannot work.

KiloClaw currently installs `mcporter` for remote HTTP MCP servers. The installed version is pinned in `services/kiloclaw/Dockerfile`; verify the capabilities and production behavior of that exact version before relying on an OAuth feature. A normal interactive localhost callback is not sufficient in a headless hosted runtime.

### Static credentials

Static credentials must:

- Be revocable independently of unrelated user sessions.
- Have the minimum scopes needed by the integration.
- Use the existing encrypted KiloClaw secret transport.
- Be classified as sensitive in the secret catalog.
- Never be logged, included in error responses, or copied into documentation and screenshots.
- Be removed from persistent configuration when disconnected.

Avoid copying credential values into generated configuration. Use the credential mechanism supported by the component that owns authentication, such as a native credential store, a secret reference, an environment reference for a static secret, or an on demand broker. Verify the storage, file permissions, rotation behavior, and cleanup behavior of the exact pinned component version. Do not assume that a file under the OpenClaw state directory is managed by OpenClaw or protected by its SQLite credential stores.

### OAuth credentials

OAuth integrations must:

- Use authorization code flow with PKCE for public clients.
- Validate signed state, callback ownership, instance ownership, redirect paths, and scope grants.
- Store refresh tokens encrypted and expose only temporary access tokens at runtime.
- Handle refresh token rotation atomically and prevent concurrent refresh races.
- Mark terminal refresh failures as requiring reauthorization.
- Revoke provider grants during disconnect where the provider supports revocation.
- Remove local and central credentials during disconnect and account deletion.
- Document token lifetimes, refresh token lifetime, rotation behavior, scopes, rate limits, and revocation guarantees.

Do not assume a token lifetime from current behavior or a code comment. The integration contract must remain safe if the provider changes token lifetime or rotation policy.

### On demand refresh

When Kilo must own token refresh, refresh on demand rather than by polling all connections.

The on demand broker model should provide these properties:

- The runtime requests a token only when a tool needs it.
- An unexpired token is cached with a refresh buffer.
- Concurrent refreshes are deduplicated or serialized.
- The refresh token stays in central encrypted storage.
- A rotated refresh token is persisted safely before the new access token is returned.
- A refresh that temporarily fails can fall back to an unexpired cached token when safe.
- Terminal provider errors move the connection to a reconnect state.

The Google Workspace integration demonstrates runtime caching, refresh buffering, request deduplication, and fallback to an unexpired cached token in `services/kiloclaw/controller/src/google-oauth-token-provider.ts`. Its Worker route keeps the refresh token in central encrypted storage, persists rotated tokens, and marks terminal errors for reconnection in `services/kiloclaw/src/routes/controller.ts`.

The Kilo MCP Gateway provides the general pattern for remote MCP servers. It checks current eligibility at runtime, injects provider credentials upstream, and refreshes OAuth grants lazily with coordination for each instance. See `services/mcp-gateway/src/lib/provider-refresh.ts` and `services/mcp-gateway/src/durable-objects/mcp-gateway-instance/refresh.ts`.

## Background Work

New scheduled jobs require explicit architectural approval.

A partner integration must not add a global cron merely to keep its authentication usable. Recurring background work creates permanent Kilo infrastructure ownership and can scale with partner adoption even when users are not using the integration.

If background work is genuinely required, the proposal must document:

- Why native client refresh, durable credentials, and on demand refresh cannot work.
- Expected connected account volume and work per account.
- Database reads and writes per run.
- External requests per run and provider rate limits.
- Maximum runtime, batching, concurrency, timeouts, and backoff.
- Overlap protection and idempotency.
- Circuit breaker behavior and failure isolation.
- Cost estimates at current, projected, and worst case scale.
- How token lifetime or provider behavior changes affect scheduling.
- Monitoring, alerts, ownership, and an operational runbook.
- How the job is disabled safely during an incident.

Scheduled cleanup of expired artifacts is different from active credential maintenance. Cleanup may be appropriate when it is bounded and does not issue, refresh, or propagate live credentials.

## Remote MCP Servers

KiloClaw uses `mcporter` for remote HTTP MCP servers because the packaged OpenClaw MCP runtime does not currently provide the required remote transport for these integrations.

A remote MCP integration must document:

- The canonical MCP endpoint and discovery metadata.
- Transport type and compatibility with the pinned client.
- Authentication mode and credential ownership.
- Tool names, schemas, and stability expectations.
- Provider timeouts, rate limits, and availability expectations.
- Whether requests are idempotent.
- Whether tools return secrets, personal data, payment data, or other sensitive values.
- Disconnect and revocation behavior.

Do not hardcode provider URLs that are specific to one environment in the controller. Production, sandbox, and local testing must use an intentional configuration model, and authorization tokens must never be sent to an endpoint other than the one for which they were issued.

Managed MCP entries must be removed when the integration is disconnected. Preserve unrelated MCP entries added by users.

## Agent Tools and Skills

An agent skill is executable policy from the agent's perspective. Treat it as part of the security boundary, not as marketing copy.

Skills must:

- Describe only tools that exist in the live provider schema.
- Instruct the agent to inspect live tool schemas rather than guess arguments.
- Distinguish read only, mutating, destructive, financial, and irreversible actions.
- Require explicit user confirmation before destructive or financially consequential actions where appropriate.
- Avoid presenting provider limits as a substitute for user authorization.
- Minimize retrieval or display of sensitive data such as tokens, full payment card details, or personal information.
- Explain test and production modes clearly.
- Provide a safe disconnected or reauthorization path.
- Avoid instructing the agent to accept terms, submit personal information, change billing plans, or switch to production mode without explicit user action.

For payment integrations, document both the limit enforced by the provider and the aggregate risk model. A spend cap on one card limits that card but may not limit repeated card creation, subscription changes, payment method changes, or disclosure of card details.

Skills copied into the image require an image release to update. Tool contracts that may change independently should be discovered at runtime where possible.

## Security and Privacy Requirements

The integration PR must include a review focused on these threats:

- Account and instance ownership checks.
- Organization membership and authorization.
- CSRF, OAuth state, PKCE, callback replay, and redirect validation.
- Credential storage, transport, rotation, revocation, and deletion.
- Prompt injection and malicious MCP tool output.
- Sensitive data returned to the model or written to logs and files.
- Provider compromise or endpoint substitution.
- Rate abuse and cost amplification.
- Irreversible or external side effects.
- Failure behavior when Kilo, the provider, the runtime, or the network is unavailable.

Never log tokens, credentials, authorization headers, cookies, payment card data, or webhook secrets. Use existing redaction utilities when headers must be logged or stored.

When adding personal data to Postgres, update the GDPR soft delete flow in `apps/web/src/lib/user/index.ts` and add corresponding tests. Foreign key cascade behavior is not a substitute unless deletion of the parent is guaranteed by the account deletion flow.

## Lifecycle Requirements

The design must cover the entire lifecycle, not only initial connection:

1. Connect or install
2. Initial credential delivery
3. Normal runtime use
4. Token or credential rotation
5. Provider outage
6. Instance stopped or unavailable
7. Instance restart, restore, and image upgrade
8. User or organization ownership change
9. Reauthorization
10. Disconnect and provider revocation
11. Kilo account deletion
12. Provider deprecation or integration shutdown

UI status must reflect actual runtime usability. A database row marked `active` is insufficient if the running instance did not receive or cannot use the credential.

## Scope and Change Boundaries

Keep integration PRs narrow and reviewable. Avoid combining all of the following in one unreviewed change:

- New OAuth framework code
- New database tables
- New scheduled infrastructure
- New controller routes
- New runtime configuration propagation
- New image dependencies
- New skills with sensitive actions
- Broad settings UI redesign

Large integrations should begin with a short architecture proposal agreed with Kilo maintainers. The proposal should identify the credential model, runtime boundary, data model, failure modes, operational ownership, and rollout plan before implementation begins.

Do not duplicate an existing abstraction without explaining why it cannot support the integration. In particular, evaluate the existing Google token broker, Kilo MCP Gateway, encrypted secret catalog, controller bootstrap, and `mcporter` configuration before adding infrastructure for one specific partner.

## Testing Expectations

An integration must be tested through a path that represents production. Tests without a Worker are useful for UI development but do not validate credential propagation into a running OpenClaw instance.

At minimum, verify:

- OAuth or credential connection using the real provider sandbox.
- Ownership rejection for another user and another organization.
- Restart and restore with persisted credentials.
- Use after access token expiry or credential rotation.
- Concurrent calls during refresh token rotation.
- Provider timeout, 4xx, 5xx, rate limit, and malformed response handling.
- Disconnect while the instance is running and while it is unavailable.
- Removal of credentials from central state and persistent runtime configuration.
- Account deletion and GDPR cleanup.
- No secret leakage in logs, errors, telemetry, screenshots, or generated config.
- Agent behavior for sensitive, destructive, financial, and irreversible tools.
- Mobile and desktop settings behavior if UI is added.

For controller or image changes, rebuild the image and run the relevant KiloClaw controller smoke tests. Follow `DEVELOPMENT.md`, `AGENTS.md`, and the commands for each package when running type checks, linting, formatting, and tests.

## Pull Request Checklist

A partner integration PR should include:

- [ ] An approved architecture description for OAuth, payments, new infrastructure, or other significant risk.
- [ ] A concise explanation of why an existing integration model is or is not sufficient.
- [ ] Complete credential and data flow diagrams.
- [ ] Provider documentation for OAuth metadata, scopes, token lifetime, rotation, revocation, and rate limits.
- [ ] A complete connect, runtime, refresh, reconnect, disconnect, and deletion lifecycle.
- [ ] No integration specific global token refresh cron unless explicitly approved.
- [ ] Runtime status based on actual usability rather than only database state.
- [ ] Sensitive values registered with the secret catalog and redaction systems.
- [ ] GDPR deletion logic and tests for newly stored personal data.
- [ ] Tests for ownership, callback validation, expiry, rotation, concurrency, and provider failures.
- [ ] Validation through a running KiloClaw instance in an environment that represents production.
- [ ] Controller/image smoke evidence when runtime files, tools, or skills change.
- [ ] A changelog entry visible to users.
- [ ] Screenshots for settings and connection states, with secrets and personal data removed.
- [ ] Rollout, monitoring, incident ownership, and rollback notes.

## Relevant Repository Areas

| Area | Location |
|---|---|
| KiloClaw architecture and invariants | `services/kiloclaw/AGENTS.md` |
| Local testing and testing that represents production | `services/kiloclaw/DEVELOPMENT.md` |
| Controller behavior | `.specs/kiloclaw-controller.md` |
| General MCP gateway authentication | `.specs/mcp-gateway-auth.md` |
| Secret catalog | `packages/kiloclaw-secret-catalog/` |
| Web integration routes and services | `apps/web/src/lib/integrations/` and `apps/web/src/app/api/integrations/` |
| KiloClaw web to Worker client | `apps/web/src/lib/kiloclaw/kiloclaw-internal-client.ts` |
| Instance secret persistence | `services/kiloclaw/src/durable-objects/kiloclaw-instance/` |
| Runtime environment construction | `services/kiloclaw/src/gateway/env.ts` |
| Controller for each instance | `services/kiloclaw/controller/src/` |
| Managed remote MCP configuration | `services/kiloclaw/controller/src/config-writer.ts` |
| KiloClaw skills | `services/kiloclaw/skills/` |
| General MCP runtime gateway | `services/mcp-gateway/` |

When a proposed integration conflicts with this guide, raise the conflict during architecture review rather than silently introducing a new operating model.
