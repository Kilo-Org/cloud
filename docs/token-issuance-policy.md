# Token Issuance Policy (Phase 1)

## Scope and status

Phase 1 defines an **opt-in** token-policy module, `packages/worker-utils/src/kilo-token-policy.ts`, and documents the issuer-to-consumer boundaries. It is not an enforcement rollout or a security fix. No existing signer or verifier behavior changes in this phase; callers opt in deliberately after their existing verification/authentication flow.

Existing operation-specific audiences remain mandatory and unchanged:

| Existing audience | Current issuer/consumer evidence |
| --- | --- |
| `git-token-service:bitbucket-repositories` | `apps/web/src/lib/integrations/platforms/bitbucket/token-service-client.ts`; `services/git-token-service/src/index.ts` |
| `git-token-service:bitbucket-code-review:pull-request` | `packages/worker-utils/src/internal-service-token-audiences.ts`; `services/git-token-service/src/index.ts` |
| `git-token-service:bitbucket-code-review:webhook-ensure` | `packages/worker-utils/src/internal-service-token-audiences.ts`; `services/git-token-service/src/index.ts` |
| `git-token-service:bitbucket-code-review:webhook-delete` | `packages/worker-utils/src/internal-service-token-audiences.ts`; `services/git-token-service/src/index.ts` |
| `git-token-service:gitlab-credentials` | `apps/web/src/lib/integrations/platforms/gitlab/credential-broker-client.ts`; `services/git-token-service/src/index.ts` |
| `git-token-service:github-user-access-token` | `apps/web/src/lib/integrations/platforms/github/user-token-client.ts`; `services/git-token-service/src/index.ts` |
| `user-data-export` | `apps/web/src/lib/user-data-export-worker-client.ts`; `services/user-data-export/src/index.ts` |
| `session-ingest:user-deletion` | `apps/web/src/lib/user/deletion-queue/handlers/cli-v2.ts`; `services/session-ingest/src/middleware/kilo-jwt-auth.ts` |

The current shared verifier rejects a token with an audience when no audience is expected (`packages/worker-utils/src/kilo-token.ts`); that existing behavior is not altered.

## Historical compatibility

`generateApiToken` originally used `expiresIn: '5y'` in commit `bc8179c70` (2026-02-04). Commit `c6bf3468f` (2026-02-10) changed the default to `5 * 365 * 24 * 60 * 60` seconds.

| Legacy issuer expression | Exact `exp - iat` | Evidence |
| --- | ---: | --- |
| Current numeric five-year default | `157680000` | `apps/web/src/lib/tokens.ts` |
| Historical `'5y'` default | `157788000` | `bc8179c70:src/lib/tokens.ts`; installed `ms` parser defines a year as 365.25 days |

Both values are required for the narrow legacy five-year class. Confidence is limited to repository history plus the presently installed parser: historical production cutovers, issued-token population, and dependency-lockfile history have not been independently confirmed. The class is compatibility evidence, not proof of a human credential: unmarked automation also calls the generic five-year issuer, including `apps/web/src/routers/app-builder-router.ts` and `apps/web/src/routers/cli-sessions-v2-router.ts`.

## Opt-in contract

`kilo-token-policy.ts` exports `KILO_TOKEN_PURPOSES` for the `tokenPurpose` claim:

```text
human-api | device-access | delegated-workload | internal-service
```

It defines boolean `credentialExchange` and two resource audience modes: `required` and `allow-legacy`. None of these helpers is wired into production authentication in Phase 1.

- If either modern claim is present, both `tokenPurpose` and `credentialExchange` are required, and `aud` is required.
- A modern read token accepts `aud` as either a nonempty string or a nonempty, unique string array; access is membership-based.
- The modern payload builder accepts a single audience only; it does not sign or issue tokens. Multi-audience support is read compatibility, not builder output.
- `required` requires a matching explicit audience. Existing operation-audience tokens do not need new purpose claims just to pass this audience policy.
- `allow-legacy` additionally accepts an absent audience for ordinary resource access. An explicit wrong, empty, malformed, or unknown nonmatching audience is never treated as missing. All array entries must be valid and unique; matching uses exact membership, not substring or wildcard rules.
- If modern claims are present, the new verifier validates their completeness and consistency in either mode. Only `human-api` may set `credentialExchange: true`. Resource-specific purpose permissions remain the consumer's responsibility.
- The opt-in verifier requires safe, nonnegative integer `iat`/`exp`, `exp > iat`, an unexpired token, and no future `iat`; it also checks the HS256 signature and any `nbf`. These requirements do not change the existing verifier or its optional-date compatibility.

`credentialExchange` has one initially defined exchange route:

- Verified session: a context obtained by calling the trusted session verifier, not generic bearer-capable user authentication. A bare database user or fabricated session/bearer object is not a policy context.
- Modern bearer: `tokenPurpose === 'human-api'`, `credentialExchange === true`, and the **sole** audience is `kilo-api` (string or singleton array).
- Legacy bearer: explicitly select `legacy: 'five-year-api'`, described below; `legacy: 'deny'` disables that fallback.
- Both bearer classes require a present pepper claim and reject all of the markers listed in the legacy class below, even if false or empty. This is deliberately conservative: a modern exchangeable human issuer must not add these metadata fields without revisiting that policy.
- Bearer expiration is checked again at the issuance decision. Original lifetime uses verified `exp - iat`, never remaining validity.

Policy inputs must be verified, claim-complete token contexts from either a separate signature-verification result or a trusted existing session-verifier callback. Do not accept raw database `User` records, decoded JWTs, or claims that an existing legacy projection has dropped. Signature verification alone is not account authentication: callers still perform their existing user/account, environment, pepper, and session-revocation checks before using a token to issue another credential.

Use `verifyKiloTokenForPolicy` on the original signed token, not `verifyKiloToken`'s projected payload. Use `verifyKiloSessionForPolicy` only with a trusted session-only verifier, never a generic function that also authenticates bearer tokens. Pass the returned context object itself to `canIssueKiloCredentials`; cloning or serializing it loses its module-local verified provenance. The context is not a replacement for account authentication and must remain bound to the same authenticated user.

`buildModernKiloTokenPayload` validates a future signer's payload without signing anything. Its strict extras schema rejects reserved identity, pepper, environment, audience, temporal, purpose, exchange, and registered JWT claim overrides, even when their values would otherwise be valid. Authoritative fields must come from the builder parameters. Existing signers are intentionally not routed through it in Phase 1.

No main signer or verifier changes in Phase 1. In particular, this module does not add claims to `apps/web/src/lib/tokens.ts` or `packages/worker-utils/src/kilo-token.ts`.

## Legacy exchange class

`five-year-api` is deliberately narrow. It permits both exact historical durations (`157680000`, `157788000`) and requires all of the following:

- no `aud`;
- no modern policy fields;
- `apiTokenPepper` is present, whether a string or `null`;
- no `tokenSource`, `botId`, `internalApiUse`, `createdOnPlatform`, `deviceSessionId`, `gastownAccess`, `isAdmin`, `orgMemberships`, `organizationId`, or `organizationRole`;
- `deviceAuthRequestCode` is allowed, preserving legacy device authorization output.

Known marked automation and system-style issuers fail this shape. Residual risk remains from historical or current unmarked automation that happens to match it; the class must never be labeled or relied on as definitive human identity.

## Issuer and consumer map

This is a concrete, selective map from the shared Kilo token entry points. It does not claim every consumer path is known.

| Flow | Issuer | Known consumers | Existing audience | Proposed canonical boundary | Unresolved split |
| --- | --- | --- | --- | --- | --- |
| Chat fanout | `apps/web/src/lib/kilo-chat/token.ts`; mobile requests through `apps/mobile/src/components/kilo-chat/hooks/use-kilo-chat-token.ts` | Kilo Chat and Event Service via `apps/web/src/contexts/EventServiceContext.tsx`; Notifications badges via `apps/mobile/src/lib/hooks/use-unread-counts.ts` | None | `kilo-chat`, `event-service`, `notifications` | One chat token fans out to three services; decide whether it becomes a single multi-audience read token or separate audience-specific tokens. |
| Cloud Agent control and downstream Kilo access | `apps/web/src/lib/tokens.ts` (`generateCloudAgentToken`) and Cloud Agent routers | `services/cloud-agent-next/src/validate-kilo-token.ts`; backend balance call; raw runtime bearer or contained capability in `services/cloud-agent-next/src/session-service.ts` | None | `cloud-agent-next`, `kilo-api`, `kilo-gateway`, `session-ingest` | The raw user token can reach multiple downstream routes; contained Kilo capability has separate routing controls. |
| App Builder | `apps/web/src/routers/app-builder-router.ts`; `apps/web/src/routers/organizations/organization-app-builder-router.ts` | `apps/web/src/lib/app-builder/app-builder-service.ts` forwards to `services/cloud-agent-next/src/middleware/auth.ts` | None; default five-year token, often unmarked | Cloud Agent control and downstream API/gateway boundaries | Unmarked tokens can match the legacy exchange class; separate control assertions from runtime credentials. |
| Code Review | `apps/web/src/lib/code-reviews/triggers/prepare-review-payload.ts` | `services/code-review-infra/src/code-review-orchestrator.ts` forwards to Cloud Agent Next | None; default five-year token with `botId: 'reviewer'` | Cloud Agent control and downstream API/gateway boundaries | Preserve delegated workload purpose through forwarding and renewal. |
| Auto Fix | `apps/web/src/lib/auto-fix/triggers/prepare-fix-payload.ts` | `services/auto-fix-infra/src/services/cloud-agent-next-client.ts` forwards to Cloud Agent Next | None; default five-year token with `botId: 'auto-fix'` | Cloud Agent control and downstream API/gateway boundaries | Do not bind only to the infrastructure service when the token reaches the runtime. |
| Auto Triage | `apps/web/src/lib/auto-triage/triggers/prepare-triage-payload.ts` | `services/auto-triage-infra/src/triage-orchestrator.ts` forwards to Cloud Agent Next | None; default five-year token with `botId: 'auto-triage'` | Cloud Agent control and downstream API/gateway boundaries | Same control/runtime separation as other Cloud Agent workflows. |
| Security Auto Analysis | `services/security-auto-analysis/src/token.ts` | `services/security-auto-analysis/src/launch.ts`, `remediation.ts`, and `manual-analysis.ts` forward user credentials to Cloud Agent Next | None; one-hour marked user tokens and separate minimal internal assertions | Cloud Agent control and downstream API/gateway boundaries for user tokens; identify each internal assertion consumer separately | Keep internal assertions distinct from runtime user credentials. |
| Webhook Agent Ingest | `services/webhook-agent-ingest/src/services/token-minting-service.ts` | `services/webhook-agent-ingest/src/queue-consumer.ts` forwards to Cloud Agent Next | None; one-hour personal/bot-user token branches | Cloud Agent control and downstream API/gateway boundaries | Preserve non-exchangeable classification for both personal and bot-user branches. |
| Gastown and Wasteland control | `apps/web/src/app/api/gastown/token/route.ts`; `apps/web/src/app/api/wasteland/token/route.ts` | `services/gastown/src/middleware/kilo-auth.middleware.ts`; `services/wasteland/src/middleware/kilo-auth.middleware.ts` | None | `gastown`; `wasteland` | Keep the two control planes separate. |
| Gastown agent runtime | `services/gastown/src/util/kilo-token.util.ts` | Kilo LLM gateway through the stored `kilocode_token` path | None | `kilo-gateway` | Runtime token is distinct from Gastown control despite its issuer. |
| KiloClaw control and cookie | `apps/web/src/routers/kiloclaw-router.ts`; cookie minted in `services/kiloclaw/src/routes/access-gateway.ts` | `services/kiloclaw/src/auth/middleware.ts` | None | `kiloclaw` | Bearer control and 24-hour cookie share the verifier but may need different later purposes. |
| KiloClaw runtime | `apps/web/src/routers/kiloclaw-router.ts`; reminted in `services/kiloclaw/src/durable-objects/kiloclaw-instance/config.ts` | OpenClaw KiloCode provider configuration in `services/kiloclaw/controller/src/config-writer.ts` | None | `kilo-gateway` | Separate runtime credential from KiloClaw control. |
| Session ingest | `apps/web/src/lib/tokens.ts` (`generateInternalServiceToken`) | `services/session-ingest/src/middleware/kilo-jwt-auth.ts` | Generic tokens plus unchanged deletion audience | `session-ingest` | Generic service JWT, deletion JWT, opaque web ticket, and Cloud Agent contained access are different families. |
| Git operations | `apps/web/src/lib/integrations/platforms/{bitbucket,github,gitlab}/`; generic GitHub disconnect in `apps/web/src/lib/integrations/platforms/github/user-authorization-client.ts` | `services/git-token-service/src/index.ts` | Operation-specific values listed above; disconnect has none | Preserve existing values; potential later `git-token-service:github-user-authorizations:disconnect` | Do not replace mandatory operation-specific audiences with broad `git-token-service`. |
| User-data export | `apps/web/src/lib/user-data-export-worker-client.ts` | `services/user-data-export/src/index.ts` | `user-data-export` | Preserve `user-data-export` | Requires its additional internal API key and five-minute assertion limit. |
| Organization and attribution | `apps/web/src/app/api/organizations/[id]/user-tokens/route.ts` | `services/ai-attribution/src/util/auth.ts` | None | `ai-attribution` | Organization-bearing tokens have other valid uses; attribution consumer transport was not fully traced. |
| Auto-routing benchmark | `apps/web/src/app/api/internal/auto-routing-benchmark/token/route.ts` | `services/auto-routing-benchmark/src/run.ts` decider CLI | None | `kilo-api` / `kilo-gateway` based on actual downstream call | `tokenSource: 'auto-routing-benchmark'` identifies issuance, not an authorization audience; full CLI call graph is unresolved. |

## Existing markers and excluded families

Core optional markers accepted by the shared schema are documented in `packages/worker-utils/src/kilo-token.ts`: `tokenSource`, `botId`, `internalApiUse`, `createdOnPlatform`, `deviceAuthRequestCode`, `deviceSessionId`, admin/Gastown flags, and organization claims.

- Confirmed `tokenSource` values: `cloud-agent`, `kilo-chat`, `auto-routing-benchmark`.
- Confirmed `botId` values: `reviewer`, `auto-fix`, `auto-triage`, `discord-bot`, `webhook-bot`.
- `internalApiUse` and `createdOnPlatform` are additional automation markers; `services/security-auto-analysis/src/token.ts` emits `internalApiUse: true` and `createdOnPlatform: 'security-agent'`.
- No universal signed system marker or reliable system-user-ID convention was confirmed.

Excluded from the credential-exchange compatibility class or treated as separate token families:

- internal-service tokens with no pepper claim;
- existing operation-audience JWTs;
- KiloClaw cookie and runtime credentials unless a resource opts in with their own modern policy;
- Cloud Agent stream tickets and wrapper-dispatch tickets in `services/cloud-agent-next/src/auth.ts`;
- encrypted Git/Kilo session capabilities, which have their own `purpose` field (for example `kilo_api_session`) in `services/git-token-service/src/kilo-session-capability.ts`;
- container, share, repository, and MCP credentials, which require separate family-specific analysis rather than automatic migration as core Kilo API tokens.

KiloClaw's five-minute control tokens (one-hour setup token), 24-hour access cookies, and 30-day runtime keys are distinct. Gastown runtime credentials also last 30 days; organization tokens last 15 minutes and benchmark tokens six hours. None qualifies for the five-year exchange compatibility class.

## Migration preconditions

Before moving any resource from `allow-legacy` to `required`:

1. Identify that resource's actual issuer and all consumer paths, including browser, mobile, runtime, and delegated paths.
2. Establish a canonical audience and whether the resource needs one builder-minted audience or read-side membership across multiple audiences.
3. Deploy compatible readers first, then migrate issuers and renewal paths, preserving the mandatory operation-specific audiences above. Renewal must retain non-exchangeable workload purpose; migrating issuers first breaks today's unexpected-audience rejection.
4. Ensure the caller has a verified, non-lossy token context and retains existing account/authentication checks.
5. Measure or otherwise retire the relevant legacy population before enforcing `required` mode.
