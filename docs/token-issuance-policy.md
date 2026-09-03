# Token Issuance Policy (Phase 1)

## Scope and status

Phase 1 defines an **opt-in** token-policy module, `packages/worker-utils/src/kilo-token-policy.ts`, and documents the issuer-to-consumer boundaries. It is not an enforcement rollout or a security fix. No existing signer or verifier behavior changes in this phase; callers opt in deliberately after their existing verification/authentication flow.

Existing operation-specific audiences remain mandatory and unchanged:

| Existing audience | Current issuer/consumer evidence |
|---|---|
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
|---|---:|---|
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
- Both bearer classes require a present pepper claim and an explicit allowlist of signed claim names: `version`, `kiloUserId`, `apiTokenPepper`, `env`, `iat`, `exp`, `aud`, `tokenPurpose`, `credentialExchange`, and `deviceAuthRequestCode`. Every other name blocks exchange, even when its value is false, null, or empty. Adding a field to the shared schema does not add it to this allowlist.
- The verifier retains a frozen `claimNames` list from the original signed payload before schema projection. Unknown claim values remain outside the supported claims contract, but their names cannot disappear from exchange classification. Ordinary resource verification is not made strict merely to enforce the narrower exchange policy; unknown claims still block exchange.
- Bearer expiration is checked again at the issuance decision. Original lifetime uses verified `exp - iat`, never remaining validity.

`isKiloCredentialExchangeEligible` assesses credential shape and purpose only; it does not authorize issuance. A token can be shape-eligible yet revoked, have a stale pepper, or belong to a blocked account. Policy inputs must be verified token contexts from either a separate signature-verification result or a trusted existing session-verifier callback. Do not accept raw database `User` records, decoded JWTs, or claims that an existing legacy projection has dropped. Signature verification alone is not account authentication: callers must independently perform user/account, environment, current-pepper equality, and session-revocation checks before issuance.

Use `verifyKiloTokenForPolicy` on the original signed token, not `verifyKiloToken`'s projected payload. Use `verifyKiloSessionForPolicy` only with a trusted session-only verifier, never a generic function that also authenticates bearer tokens. Pass the returned context object itself to `isKiloCredentialExchangeEligible`; cloning or serializing it loses its module-local verified provenance. The context is not a replacement for account authentication and must remain bound to the same authenticated user.

`buildModernKiloTokenPayload` validates a future signer's payload without signing anything. Its strict extras schema rejects reserved identity, pepper, environment, audience, temporal, purpose, exchange, and registered JWT claim overrides, even when their values would otherwise be valid. Exchangeable output additionally requires a pepper claim, the `kilo-api` audience, and only exchange-safe claims; conflicting extras are rejected rather than producing a token the eligibility policy refuses. Known optional extras set to `undefined` are ignored by the builder's exchange-safety check because JWT JSON serialization omits them; false, null, empty, and other defined values do not receive that exemption. Unknown or reserved extras remain rejected even if undefined. The original signed claim-name check remains authoritative at verification. Non-exchangeable output can retain supported workload/scope metadata. The output type preserves the discriminated purpose/exchange relationship. Authoritative fields must come from the builder parameters. Existing signers are intentionally not routed through it in Phase 1.

Verified bearer contexts expose recursively readonly, deeply frozen supported claim values, including the organization-membership array and its entries. This protects the verification snapshot; it does not imply that account state remains current.

No main signer or verifier changes in Phase 1. In particular, this module does not add claims to `apps/web/src/lib/tokens.ts` or `packages/worker-utils/src/kilo-token.ts`.

## Legacy exchange class

`five-year-api` is deliberately narrow. It permits both exact historical durations (`157680000`, `157788000`) and requires all of the following:

- no `aud`;
- no modern policy fields;
- `apiTokenPepper` is present, whether a string or `null`;
- only the exchange-safe claim names listed above; this excludes `tokenSource`, `botId`, `internalApiUse`, `createdOnPlatform`, `deviceSessionId`, `gastownAccess`, `isAdmin`, `orgMemberships`, `organizationId`, `organizationRole`, and any future or unknown claim;
- `deviceAuthRequestCode` is allowed, preserving legacy device authorization output.

Known marked automation and system-style issuers fail this shape. Residual risk remains from historical or current unmarked automation that happens to match it; the class must never be labeled or relied on as definitive human identity.

Future issuance routes should use `legacy: 'deny'` by default. A route requiring proof of human issuance must use trustworthy server-side issuance provenance or fresh session authentication, not enable the shape fallback as a substitute. Any compatibility exception requires an explicit policy decision accepting the documented residual risk. This concerns permission to exchange credentials, not supported ordinary legacy resource access; Phase 1 does not invalidate tokens.

## Issuer and consumer map

This is a concrete, selective map from the shared Kilo token entry points. It does not claim every consumer path is known.

| Flow | Issuer | Known consumers | Existing audience | Proposed canonical boundary | Unresolved split |
|---|---|---|---|---|---|
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

## Phase 4: web and HTML-deployment readers

The earlier sections describe the Phase 1 contracts. The web/deployment reader integration adds audience-only checks without changing token issuance or adopting the stricter credential-exchange schema for ordinary requests:

- General web/API bearer authentication expects `kilo-api` by default. `validateAuthorizationHeader` checks the audience after signature verification; `getUserFromAuth` passes an optional, server-owned `expectedAudience` override. Cookie-session authentication and existing account/pepper checks are unchanged. A rejected bearer does not fall back to a browser session.
- Model gateway operations explicitly expect `kilo-gateway`: chat/completions, Responses, Messages, embeddings, transcription, FIM, edit completions, model catalogs/validation, and the billed Exa proxy. Re-exported gateway/v1 handlers inherit the implementation's expectation; request headers and URL paths do not select the audience policy.
- Existing public catalogs and anonymous/free-model behavior remain available after authentication rejection where already supported. Such requests must remain anonymous, without the rejected token's user, organization, BYOK, bot, source, or billing identity.
- HTML deployment expects the dedicated `deploy-builder:html-deploy` audience before rate limiting or deployment work. This does not change the builder's separate backend-secret `/deploy` interface.

All three resource boundaries retain supported audience-less legacy tokens. Explicit audiences require exact matching, or membership in a valid audience array; null, empty, malformed, duplicate, and mismatched audiences are rejected. These changes do not add an environment check to ordinary web authentication, alter its historical timestamp handling, or migrate any signers.

The Gastown Git-credentials callback uses the general `kilo-api` boundary. Its current audience-less runtime token remains accepted, but a future gateway-only token must not retrieve Git credentials. Split those runtime credentials or explicitly authorize the necessary resource set before migrating that issuer. This callback still has its existing integration-ownership checks, not newly added general account/pepper checks.

Do not treat every legacy-only verifier as a resource-migration target. Cloud Agent wrapper fallback must remain audience-less-only; REST `cloud-agent-next` tokens are not wrapper-dispatch capabilities. Existing deletion/export/Git operation audiences stay mandatory. Git user-authorization disconnect currently has a legacy-only contract and needs a dedicated operation-contract decision before its producer adopts an audience; do not widen it with the general API or gateway audience. Stored-token renewal and runtime reuse checks are separate issuer-migration work.

## Migration preconditions

Before moving any resource from `allow-legacy` to `required`:

1. Identify that resource's actual issuer and all consumer paths, including browser, mobile, runtime, and delegated paths.
2. Establish a canonical audience and whether the resource needs one builder-minted audience or read-side membership across multiple audiences.
3. Deploy compatible readers first, then migrate issuers and renewal paths, preserving the mandatory operation-specific audiences above. Renewal must retain non-exchangeable workload purpose; migrating issuers first breaks today's unexpected-audience rejection.
4. Ensure the caller has a verified, non-lossy token context and retains existing account/authentication checks.
5. Measure or otherwise retire the relevant legacy population before enforcing `required` mode.

Before wiring a real credential-issuance route, use an application-owned authentication adapter that validates current account state and records session-versus-bearer provenance. A narrower session-only callback or account-authenticated capability belongs at that integration boundary; a generic database-user callback is not proof of a session. Add route regressions for revoked/blocked accounts, rotated peppers, wrong environments, and bearer-capable authentication incorrectly classified as a session. None of those account checks or route integrations is introduced in this infrastructure-only PR.

## Phase 5.1: bounded internal assertion issuance

`signModernKiloToken` signs the validated modern payload with explicit audience, purpose, exchange permission, and positive lifetime. It does not change `signKiloToken` or the web's existing human/organization/shared signers. Web's synchronous `generateBoundedInternalServiceToken` uses the same payload builder, fixes `internal-service` / `credentialExchange: false`, and permits only the enumerated bounded service audiences. It requires a positive explicit lifetime, capped at 3600 seconds for generic Session Ingest and 300 seconds for the other bounded operations, in both rollout modes.

Activation is **default-off**. `BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED=true` enables modern payloads at 16 selected web mint sites. Unset, `false`, or any other value retains their existing legacy shape, TTL, and audience behavior. The flag is server configuration, not a request option. No tracked dotenv values or external deployments are changed by this implementation.

| Producer group | Raw mint sites | Lifetime | Audience behavior |
|---|---:|---|---|
| Bitbucket repositories and code-review broker helper | 2 | 300 seconds | Existing exact operation audience in both modes |
| GitLab credential broker and GitHub user access-token broker | 2 | 300 seconds | Existing exact operation audience in both modes |
| GitHub user-authorization disconnect | 1 | 300 seconds | Legacy absent audience; enabled mode uses `git-token-service:github-user-authorizations:disconnect` |
| User export client and deletion-queue leaf-session cleanup | 2 | 300 seconds | Existing `user-data-export` and `session-ingest:user-deletion` audiences in both modes |
| Session Ingest client, active-session/ticket router, rename notification | 9 | 3600 seconds | Legacy absent audience; enabled mode uses `session-ingest` |

These assertions continue to omit pepper and environment, preserving the exact receiver contracts. Organization identity is preserved where already supplied. This is trusted backend assertion issuance for existing authorized operations, not a user-returned token-exchange endpoint or a new general delegation grant. Generic Session Ingest assertions are resource-scoped, not single-session or single-route capabilities; incoming-request authorization and receiver ownership checks still matter. Returned Git provider credentials, opaque web/share tickets, and export responses remain separate credential families.

The disconnect reader accepts its dedicated operation audience or legacy audience-less assertions only on its existing POST route. Other Git broker endpoints retain mandatory operation audiences. Token identity, not a user ID supplied in the body, controls disconnect. Deploy this compatible reader before enabling the new producer; do not use a broad API/gateway/Git-service audience as a substitute.

### Activation and rollback

1. Confirm Phase 4 readers (including the web wrap-up) and the dedicated Git-disconnect reader are merged and deployed to every receiving environment. Building the shared workspace package does not deploy a Worker.
2. Run issuer/reader and rollback tests with the flag off and on. Verify unchanged TTLs and omissions, exact audiences, internal/non-exchangeable claims, receiver acceptance, and cross-operation/exchange rejection.
3. An operator can run `pnpm web:env set BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED` and choose `true` only after deployment readiness is confirmed. Agents must not execute that interactive, external-system-changing command.
4. Observe request success and sanitized audience-rejection metrics. Roll back the flag to `false` if required, retaining the defensive readers. Already-issued modern assertions expire after their existing 5-minute/1-hour lifetime and remain accepted by those readers; rollback does not revoke them.

### Explicit PR 5.2 allocation

Gastown/Wasteland control issuers are deferred with their delegation adapters: current paths discard bearer expiry/signed restrictions into a bare user record, and Gastown can derive and renew broader 30-day runtime credentials. A source/audience stamp alone would not close that path. Modern-builder organization roles also require a deliberate compatibility decision for web `admin` memberships; do not cast or promote them to owner. The generic organization-token issuer is not proven attribution-only and is likewise deferred. User/native credentials, Chat fan-out, Cloud Agent/App Builder/automation runtime forwarding, Gastown renewal, and other shared credentials remain PR 5.2 work. The separate Worker-local `services/security-auto-analysis/src/token.ts` snapshot assertion is not one of these 16 web callsites; migrate it with that Worker's other token paths and rollout configuration in PR 5.2. KiloClaw stays minimal for its October EOL. These reallocations keep Phase 5 at exactly two PRs, rather than claiming unsafe control-plane migrations are bounded.

This PR does not retire legacy native exchange, shorten user credentials, change global pepper/session semantics, or remove ordinary legacy resource access.
