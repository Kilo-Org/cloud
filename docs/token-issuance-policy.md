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

Five-year tokens are no longer minted. `generateApiToken` has no default lifetime, and it, `signKiloToken`, and `signModernKiloToken` refuse a lifetime above 30 days (`KILO_TOKEN_MAX_LIFETIME_SECONDS`). User-held credentials (device authorization, the profile-page API key, editor sign-in, and the native sign-in without a refresh pair) are minted for exactly 30 days. This is an issuance cap only: verification does not reject tokens issued earlier with a five-year lifetime.

| Legacy issuer expression | Exact `exp - iat` | Evidence |
|---|---:|---|
| Numeric five-year default (until the 30-day cap) | `157680000` | `packages/web-shared/src/lib/tokens.ts` history |
| 30-day user credential | `2592000` | `TOKEN_EXPIRY.thirtyDays` in `apps/web/src/lib/auth/kilo-token-signing.ts` |
| Historical `'5y'` default | `157788000` | `bc8179c70:src/lib/tokens.ts`; installed `ms` parser defines a year as 365.25 days |

The two five-year values are required for the narrow legacy five-year class; the 30-day value is the same class as minted now. Confidence is limited to repository history plus the presently installed parser: historical production cutovers, issued-token population, and dependency-lockfile history have not been independently confirmed. The class is compatibility evidence, not proof of a human credential: unmarked automation also called the generic five-year issuer, and unmarked 30-day tokens share the shape (see below).

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

No main signer or verifier changes in Phase 1. In particular, this module does not add claims to `packages/web-shared/src/lib/tokens.ts` or `packages/worker-utils/src/kilo-token.ts`.

## Legacy exchange class

`five-year-api` is deliberately narrow. The name is historical: it permits both exact five-year durations (`157680000`, `157788000`) and the exact 30-day duration minted now (`2592000`), and requires all of the following:

- no `aud`;
- no modern policy fields;
- `apiTokenPepper` is present, whether a string or `null`;
- only the exchange-safe claim names listed above; this excludes `tokenSource`, `botId`, `internalApiUse`, `createdOnPlatform`, `deviceSessionId`, `isAdmin`, `orgMemberships`, `organizationId`, `organizationRole`, and any future or unknown claim;
- `deviceAuthRequestCode` is allowed, preserving legacy device authorization output.

Known marked automation and system-style issuers fail this shape. Device-bound legacy credentials (`deviceSessionId`) are checked separately by the web resource delegation and by `session-sync`, which accept one hour, 30 days, and the five-year `157680000`, each with a live device session. KiloClaw's 30-day runtime keys carry no marker, so since the 30-day duration joined this class they match it. Residual risk remains from historical or current unmarked automation that happens to match it; the class must never be labeled or relied on as definitive human identity.

Future issuance routes should use `legacy: 'deny'` by default. A route requiring proof of human issuance must use trustworthy server-side issuance provenance or fresh session authentication, not enable the shape fallback as a substitute. Any compatibility exception requires an explicit policy decision accepting the documented residual risk. This concerns permission to exchange credentials, not supported ordinary legacy resource access; Phase 1 does not invalidate tokens.

## Issuer and consumer map

This is a concrete, selective map from the shared Kilo token entry points. It does not claim every consumer path is known.

| Flow | Issuer | Known consumers | Existing audience | Proposed canonical boundary | Unresolved split |
|---|---|---|---|---|---|
| Chat fanout | `apps/web/src/lib/kilo-chat/token.ts`; mobile requests through `apps/mobile/src/components/kilo-chat/hooks/use-kilo-chat-token.ts` | Kilo Chat and Event Service via `apps/web/src/contexts/EventServiceContext.tsx`; Notifications badges via `apps/mobile/src/lib/hooks/use-unread-counts.ts` | None | `kilo-chat`, `event-service`, `notifications` | One chat token fans out to three services; decide whether it becomes a single multi-audience read token or separate audience-specific tokens. |
| Cloud Agent control and downstream Kilo access | `apps/web/src/lib/auth/kilo-token-signing.ts` (`generateCloudAgentWorkflowToken`) and Cloud Agent routers | `services/cloud-agent-next/src/validate-kilo-token.ts`; backend balance call; raw runtime bearer or contained capability in `services/cloud-agent-next/src/session-service.ts` | `cloud-agent-next` (workflow control token); None for request-delegated router credentials | `cloud-agent-next`, `kilo-api`, `kilo-gateway`, `session-ingest` | The raw user token can reach multiple downstream routes; contained Kilo capability has separate routing controls. |
| Code Review | `apps/web/src/lib/code-reviews/triggers/prepare-review-payload.ts` | `services/code-review-infra/src/code-review-orchestrator.ts` forwards to Cloud Agent Next | None (legacy) or `cloud-agent-next`; one-hour token with `botId: 'reviewer'` | Cloud Agent control and downstream API/gateway boundaries | Preserve delegated workload purpose through forwarding and renewal. |
| Security Auto Analysis | `services/security-auto-analysis/src/token.ts` | `services/security-auto-analysis/src/launch.ts`, `remediation.ts`, and `manual-analysis.ts` forward user credentials to Cloud Agent Next | None; one-hour marked user tokens and separate minimal internal assertions | Cloud Agent control and downstream API/gateway boundaries for user tokens; identify each internal assertion consumer separately | Keep internal assertions distinct from runtime user credentials. |
| Webhook Agent Ingest | `services/webhook-agent-ingest/src/services/token-minting-service.ts` | `services/webhook-agent-ingest/src/queue-consumer.ts` forwards to Cloud Agent Next | None; one-hour personal/bot-user token branches | Cloud Agent control and downstream API/gateway boundaries | Preserve non-exchangeable classification for both personal and bot-user branches. |
| KiloClaw control and cookie | `apps/web/src/routers/kiloclaw-router.ts`; cookie minted in `services/kiloclaw/src/routes/access-gateway.ts` | `services/kiloclaw/src/auth/middleware.ts` | None | `kiloclaw` | Bearer control and 24-hour cookie share the verifier but may need different later purposes. |
| KiloClaw runtime | `apps/web/src/routers/kiloclaw-router.ts`; reminted in `services/kiloclaw/src/durable-objects/kiloclaw-instance/config.ts` | OpenClaw KiloCode provider configuration in `services/kiloclaw/controller/src/config-writer.ts` | None | `kilo-gateway` | Separate runtime credential from KiloClaw control. |
| Session ingest | `apps/web/src/lib/auth/kilo-token-signing.ts` (`generateInternalServiceToken`) | `services/session-ingest/src/middleware/kilo-jwt-auth.ts` | Generic tokens plus unchanged deletion audience | `session-ingest` | Generic service JWT, deletion JWT, opaque web ticket, and Cloud Agent contained access are different families. |
| Git operations | `apps/web/src/lib/integrations/platforms/{bitbucket,github,gitlab}/`; generic GitHub disconnect in `apps/web/src/lib/integrations/platforms/github/user-authorization-client.ts` | `services/git-token-service/src/index.ts` | Operation-specific values listed above; disconnect has none | Preserve existing values; potential later `git-token-service:github-user-authorizations:disconnect` | Do not replace mandatory operation-specific audiences with broad `git-token-service`. |
| User-data export | `apps/web/src/lib/user-data-export-worker-client.ts` | `services/user-data-export/src/index.ts` | `user-data-export` | Preserve `user-data-export` | Requires its additional internal API key and five-minute assertion limit. |
| Organization and attribution | `apps/web/src/app/api/organizations/[id]/user-tokens/route.ts` | `services/ai-attribution/src/util/auth.ts` | None | `ai-attribution` | Organization-bearing tokens have other valid uses; attribution consumer transport was not fully traced. |
| MCP catalog dump and kilo-app changelog | `apps/web/src/app/api/internal/mcp-catalog/token/route.ts` | `.github/workflows/kilo-mcp-catalog.yml` `kilo run`; `.github/workflows/kilo-app-release.yml` and `.github/workflows/kilo-app-changelog-history.yml` release-notes rewrite (benchmarking service account) | None | `kilo-api` / `kilo-gateway` based on actual downstream call | `tokenSource: 'mcp-catalog'` identifies issuance; the `MCP_CATALOG_TOKEN_SECRET` shared secret only authenticates the mint and is never a Kilo credential. Minting requires an unblocked `bot-internal-*` bot user with a non-empty API-token pepper and an owner or member role in the benchmarking organization, the same rules as the internal-bot mint (`apps/web/src/lib/bot-users/eligibility.ts`); the response names the resolved account id. |
| Internal bot users | `apps/web/src/app/api/internal/bot-token/route.ts` | `services/auto-routing-benchmark/src/benchmark-token.ts` (`kilo-api` for the executable model catalog; `kilo-gateway` for the CLI container behind the case proxy; no audience for the proxy-less `/admin/debug-cli` CLI); other internal workloads running as `bot-internal-*` users | None (legacy); modern: the one requested `audience`, or `kilo-api` + `kilo-gateway` when the request names none | `kilo-api` / `kilo-gateway`, one hour | `tokenSource: 'internal-bot'`; minting requires a `bot-internal-*` bot user with a pepper and no block, plus an owner or member role in the requested organization; `BOT_TOKEN_MINT_SECRET` only authenticates the mint and is never a Kilo credential. Modern shape gated by `INTERNAL_BOT_RESOURCE_TOKENS_ENABLED`. A CLI that holds one key for every route cannot request a single audience until it exchanges per audience. |

## Existing markers and excluded families

Core optional markers accepted by the shared schema are documented in `packages/worker-utils/src/kilo-token.ts`: `tokenSource`, `botId`, `internalApiUse`, `createdOnPlatform`, `deviceAuthRequestCode`, `deviceSessionId`, admin flags, and organization claims.

- Confirmed `tokenSource` values: `cloud-agent`, `kilo-chat`, `mcp-catalog`, `internal-bot`.
- `webhook-trigger` marks the webhook triggers router's sandbox capability mint in `apps/web/src/routers/webhook-triggers-router.ts`.
- Confirmed `botId` values: `reviewer`, `discord-bot`, `webhook-bot`.
- `internalApiUse` and `createdOnPlatform` are additional automation markers; `services/security-auto-analysis/src/token.ts` emits `internalApiUse: true` and `createdOnPlatform: 'security-agent'`.
- No universal signed system marker or reliable system-user-ID convention was confirmed.

Excluded from the credential-exchange compatibility class or treated as separate token families:

- internal-service tokens with no pepper claim;
- existing operation-audience JWTs;
- KiloClaw cookie and runtime credentials unless a resource opts in with their own modern policy;
- Cloud Agent stream tickets in `services/cloud-agent-next/src/auth.ts`;
- encrypted Git/Kilo session capabilities, which have their own `purpose` field (for example `kilo_api_session`) in `services/git-token-service/src/kilo-session-capability.ts`;
- container, share, repository, and MCP credentials, which require separate family-specific analysis rather than automatic migration as core Kilo API tokens.

KiloClaw's five-minute control tokens (one-hour setup token), 24-hour access cookies, and 30-day runtime keys are distinct. Organization tokens last 15 minutes and internal bot tokens, including the decider benchmark's, one hour. None of those qualifies for the legacy exchange compatibility class, except the unmarked 30-day KiloClaw runtime key, which has the same shape and lifetime as a 30-day user API token.

## Phase 4: web readers

The earlier sections describe the Phase 1 contracts. The web reader integration adds audience-only checks without changing token issuance or adopting the stricter credential-exchange schema for ordinary requests:

- General web/API bearer authentication expects `kilo-api` by default. `validateAuthorizationHeader` checks the audience after signature verification; `getUserFromAuth` passes an optional, server-owned `expectedAudience` override. Cookie-session authentication and existing account/pepper checks are unchanged. A rejected bearer does not fall back to a browser session.
- Model gateway operations explicitly expect `kilo-gateway`: chat/completions, Responses, Messages, embeddings, transcription, FIM, model catalogs/validation, and the billed Exa proxy. Re-exported gateway/v1 handlers inherit the implementation's expectation; request headers and URL paths do not select the audience policy.
- Anonymous access survives only the absence of a credential. A request that sends no bearer, or the `anonymous` sentinel a Kilo client sends when nobody is signed in (`ANONYMOUS_API_KEY` in `packages/kilo-gateway/src/api/constants.ts` of the kilocode repository), keeps the public catalogs and the free-model tier, and carries no user, organization, BYOK, bot, source, or billing identity. apps/ai-gateway serves these operations and does not read the NextAuth session cookie, so a request that carries only a browser session is anonymous there too.
- A rejected bearer fails with `401 INVALID_TOKEN` instead of continuing anonymously. The caller presented a credential and believes it is authenticated, so answering it as anonymous would drop its account, organization, BYOK, bot, source, and billing identity, and would hide the refused credential from the client. This covers an unverifiable, expired, outdated, or revoked token, and an operation-scoped `kilo-api` token sent to a `kilo-gateway` operation; mint that token with `resource: 'gateway'` from `/api/auth/resource-token` or `/api/organizations/[id]/user-tokens`.

Both resource boundaries retain supported audience-less legacy tokens. Explicit audiences require exact matching, or membership in a valid audience array; null, empty, malformed, duplicate, and mismatched audiences are rejected. These changes do not add an environment check to ordinary web authentication, alter its historical timestamp handling, or migrate any signers.

Do not treat every legacy-only verifier as a resource-migration target. Existing deletion/export/Git operation audiences stay mandatory. Git user-authorization disconnect currently has a legacy-only contract and needs a dedicated operation-contract decision before its producer adopts an audience; do not widen it with the general API or gateway audience. Stored-token renewal and runtime reuse checks are separate issuer-migration work.

### Q9 admission observation

Q9 refuses a legacy token that names more than one audience. Before any verifier refuses one, `KILO_TOKEN_ADMISSION_OBSERVATION_ENABLED=true` measures who still presents such tokens and how the CLI-based internal bots use `kilo-api`. It never changes a verdict, `isKiloResourceAudienceAllowed` stays a pure predicate, and the flag is off by default. When it is off, each verified token costs one `process.env` read and nothing is built. The optional `KILO_TOKEN_ADMISSION_CONTROL_SUBJECT` names one owned synthetic account whose ordinary tokens prove that lines still reach the logs; it is read only while the flag is on.

**Boundaries.** A line is written only after the signature verified, so a forged or expired token never produces one.

| `boundary` | Where | Written for | `outcome` |
|---|---|---|---|
| `web_bearer` | `validateAuthorizationHeader`, only when `getUserFromAuth` calls it (`observeAdmission: true`); the gateway rate-limit key reads the same header without reporting | a multi-audience token, an internal bot token presented to `kilo-api`, or an admitted control token | `admitted`, or the refusal reason after the signature: `audience_not_allowed`, `token_version_outdated`, `cloud_agent_authority_denied`, `runtime_attestation_required` |
| `resource` | `verifyKiloTokenForResource` | an accepted multi-audience or control token | `admitted` |
| `policy` | `verifyKiloTokenForPolicy` | an accepted multi-audience or control token | `admitted` |
| `exact_audience` | `verifyKiloToken` with an `audience` option | an accepted multi-audience or control token | `admitted` |

`web_bearer` observes before the audience refusal, so a bot that loses `kilo-api` access after per-audience minting shows up as `audience_not_allowed` instead of disappearing. Account checks that run later (pepper, blocked account, organization) can still refuse an `admitted` token.

**Fields.** `event: "kilo_token_admission"`, `v: 1`, `boundary`, `policy_audience` (`kilo-api`, `kilo-gateway`, `session-ingest`, `cloud-agent-next`, else `other`), `outcome`, `multi` (`true` when the `aud` claim is an array of two or more entries, decided before any labelling), `control` (see below), `aud_set` (the labelled audiences in fixed order joined with `+`, `other` for any unlisted name, `more` when the claim has more names than the read cap, `none` when absent; at most eight names are read), and `issuer` (`runtime_authorization`, `cloud_agent_authority`, `internal_bot`, `unknown`, from signed claims). `web_bearer` adds `cohort` and `client`. Count multi-audience tokens with `multi`, never from `aud_set`: repeated names (`["kilo-api","kilo-api"]`) and several unlisted names collapse to one label there. The token, subject, organization, raw claims, headers, route and address are never written; the log pipeline attaches its own request metadata, which queries must not project.

**Control lines.** `control` is `true` only for a token whose signed subject equals `KILO_TOKEN_ADMISSION_CONTROL_SUBJECT`, that is not an internal bot token, that names one audience or none, and that the boundary admitted; a refused `web_bearer` decision is never a control line. The variable holds exactly one subject: an empty value, whitespace, a comma or the `bot-` prefix configures none. The code checks only that shape. Before the value is set, the operator confirms that the subject is exactly one owned synthetic account approved for this use, with no other traffic and no bot or service role; a subject that fails that check must not be configured, and its days are unmeasured. The subject is never written. A control line has `multi: false` and `cohort: not_internal_bot`, so it never enters a multi-audience or cohort count; a multi-audience token of the control subject stays an ordinary multi line with `control: false`. Control lines prove only that the flag is read, that the observer runs after verification on that version, and that the line reaches the log; unit tests prove the multi-audience branch.

**Cohorts** come from signed claims. A cohort requires the signed `tokenSource: 'internal-bot'` that only `POST /api/internal/bot-token` sets. The default benchmark user (`DEFAULT_BENCHMARK_USER_ID`) is `benchmark`. Other subjects come from the server-owned `KILO_TOKEN_ADMISSION_COHORTS` list of `label=subject` entries, with labels `bouncer_watch`, `kwf_work_sessions` and `kwf_other`; it is parsed once per distinct value. A malformed entry, an unknown label, a repeated subject or the default benchmark user refuses the whole list. Unset or refused, every other internal bot is `internal_bot_unlisted`; everything else is `not_internal_bot`. The list only labels lines and never affects what a verifier accepts.

**Clients** come from unsigned headers and are observed labels, not proof. `cli_marked` means a Kilo CLI marker (`X-KILOCODE-EDITORNAME: Kilo CLI …`, or a user agent starting `opencode-kilo-provider` or `Kilo-Code/`); `unmarked` means other client headers; `unknown` means neither header. Any caller holding the token can set or omit these headers, and the CLI itself sends some calls with only its runtime's user agent. The exact number of CLI calls therefore cannot be proved: report each signed cohort's total and its `cli_marked`, `unmarked` and `unknown` counts, and treat the split as observed only.

**Counting zero.** This section describes a planned measurement capability, not measured production coverage: no surface is measured until it passes every rule below. A zero supports Q9 only for a surface, cohort and window that all pass every rule. Anything else is "not measured", and an unmeasured surface or cohort cannot pass the Q9 gate. Strict refusal also needs the gates under "Before strict refusal".

1. **Window.** One representative run of consecutive measured days, 14 by default. It starts after the last issuer and client change, is at least as long as the longest remaining legacy token lifetime plus one re-mint cycle of every covered client, and it includes days on which each covered cohort actually ran its normal schedule. A day that fails any rule breaks the run. For Cloud Agent runtime tokens the last issuer change is the moment the last serving `cloud-agent-next` version with `RUNTIME_TOKEN_AUDIENCE_MODE` other than `per-destination` (unset means `combined`) stopped serving. A runtime token lives at most one hour and stays in use until its normal renewal, five minutes before expiry, because a mode change renews nothing early. The window therefore starts no earlier than one hour, plus ingestion lag, after that moment; until then multi-audience runtime lines are expected.
2. **Serving versions.** Every version that served traffic on the surface during the window, including canaries, rollbacks and instant rollbacks, contains this code, shown by the deployment history. One unproven serving version makes its days unmeasured.
3. **Flag.** The flag reads exactly `true` on every serving version for the whole window, shown by that version's own configuration, checked again after every deploy in the window. Do not assume a value set only in a dashboard survives a deploy: a Worker deploy replaces variables that its configuration does not declare unless it keeps them explicitly. A Worker reads the flag from `process.env`, which `nodejs_compat` fills for compatibility dates from 2025-04-01 or with the compatibility flag that enables it; a Worker without that, or without log export, is unmeasured until its configuration changes. Unmeasured Workers cannot pass Q9.
4. **Control line per serving version.** Each day, every serving version of every measured surface (`vercel.deploymentId`, `ScriptVersion.ID`) produces at least one control line from a legitimate, scoped test request that also got its expected application success (an HTTP 2xx on the same request). A version without one that day is unmeasured. A refused control token never counts.
   - The request uses only a token that a normal, authorized issuer already mints for the control account, through that surface's ordinary path. Never sign or mint a multi-audience credential for coverage.
   - A surface without such a path stays unmeasured, and a staging control never makes a production surface measured.
   - Covered cohorts are exercised by their own traffic: each mapped cohort and, separately, `benchmark` must produce at least one line that day, or the cohort is unmeasured for it.
5. **Mapping.** The cohort list is accepted, unchanged for the whole window, and names every subject of each covered cohort. A cohort under a refused or changed list is not eligible for a zero claim. Any `internal_bot_unlisted` line in the window makes every internal-bot zero claim ineligible: an unlisted signed internal bot may be a covered client under a subject the list does not name.
6. **Loss and precision.** No sampling on the drain or Logpush, and no `unparsed` lines (a line cut by a size limit fails `parse_json`). A matched version-day whose Logpush events contain a truncation marker is also unmeasured, per the truncation preflight under Queries: a Logpush field truncation is valid JSON, so `parse_json` does not fail and `unparsed` does not see it. `dcount` is an estimate and never decides the gate: every number that decides it, and every zero, comes from the exact queries below, which also report the lines without a request id as loss. A zero means `lines = 0` in the exact query, never `requests = 0`: a line without a request id is never ignored, and any such line makes the count nonzero. `request.id` exists in the `vercel` schema but can be null; such lines cannot be joined or deduplicated, so any nonzero loss is reported with the result. Worker lines carry no request id and count verifier passes, not unique calls; one call can pass several verifiers, and a Worker zero means `passes = 0`. Whole dropped lines are not detectable from the event schema. A Logpush truncation marker is the one event-level completeness signal; a control line proves that lines reached the dataset, not that no line was dropped.

**Queries** (replace `START`, `END` and the script names; run only with explicit approval). Nothing is subtracted: control lines carry `multi: false` and `cohort: not_internal_bot`, so the gate queries never count them.

**Logpush truncation (run first).** Cloudflare limits the `Logs` and `Exceptions` fields together to 16,384 characters, counted in the order `exception.name`, `exception.message`, then `log.message`. At that limit it replaces or cuts the affected fields with `<<<Logpush: *field* truncated>>>` for one message before it drops the remaining logs or exceptions ([Workers Logpush limits](https://developers.cloudflare.com/workers/observability/logs/logpush/#limits)). A marker, or any text from the marker family, therefore shows that at least one log or exception of that invocation was truncated or dropped. The documented shapes are a standalone log element (`<<<Logpush: messages truncated>>>`), a partial message with the marker appended (`unable to <<<Logpush: exception messages truncated>>>`), and an exception field carrying the marker after all later logs were dropped. Because the budget is shared, exception volume alone can exhaust it and drop the admission line of an invocation that logged little. The marker is valid JSON, so `parse_json` succeeds and `unparsed` stays 0; it can also sit in a log element after `Logs.Message[0]`, which the admission queries do not read. A dataset can store `<` and `>` escaped in the serialized arrays, so the match below uses the case-sensitive marker family `Logpush:` instead of the full literal; an application log that happens to contain that family can only make its day unmeasured.

Run the one query below on the same fixed window, before any admission prefix filter. It selects the matched scripts and the events with no script name before it serializes the arrays, then reads every `Logs` element and the whole `Exceptions` array. Do not infer completeness from absent parsed admission lines, from `unparsed = 0`, from a control 2xx, or by subtracting counts.

```kusto
// Workers preflight: Logpush truncation-family markers per script, version and day (decides coverage)
['cloudflare-logpush']
| where _time between (datetime(START) .. datetime(END))
| where ScriptName in ('WORKER_A', 'WORKER_B') or isempty(ScriptName)
| extend logs_text = tostring(Logs), exceptions_text = tostring(Exceptions)
| where logs_text contains_cs 'Logpush:' or exceptions_text contains_cs 'Logpush:'
| summarize marker_events = count()
    by day = bin(_time, 1d), script = ScriptName, version = ['ScriptVersion.ID']
```

This query decides coverage. It returns only marker-family events; every other event is invisible to it, which is why a zero needs the capture proof below. `marker_events` counts events, not requests.

- A row with `marker_events > 0` and a matched script is unmeasured for that `script|version|day`, whatever its admission counts, `unparsed` count or control result.
- A row with an empty `version` belongs to no serving version, so every serving version of that script is unmeasured for that day.
- A row with an empty `script` cannot be attributed; it makes every matched surface unmeasured for that day. The query selects empty names on purpose and cannot filter them out before the marker test.
- A matched `script|version|day` with no row is usable only when marker capture is established for that script (below). Otherwise it stays unmeasured, because the query cannot distinguish "no truncation" from "no marker recorded".

**Marker capture.** A zero marker count supports a coverage claim only if Cloudflare's marker would have reached the dataset. Capture is established for a script on `['cloudflare-logpush']` only by one of:

- at least one marker-family event from that script observed in an approved, bounded historical window since the last change to the Logpush job, the dataset schema or the ingestion pipeline, using the same query with that window's `START` and `END`; do not scan the full retained history; or
- a written Cloudflare or Axiom confirmation that the dataset keeps `Logs[].Message[]` and `Exceptions` verbatim, including the marker literal.

Field presence is not capture: an untruncated event exposes `Logs` and `Exceptions` without a marker. This document contains no live query and no observed marker, so marker capture, every version-day count and every truncation-free claim are unmeasured until an approved query establishes them.

```kusto
// Vercel: signed bot cohorts at kilo-api, raw lines and an estimate (not for the gate)
['vercel']
| where _time between (datetime(START) .. datetime(END))
| where isnotnull(['vercel.projectName']) and ['vercel.environment'] == 'production'
| where message startswith '{"event":"kilo_token_admission"'
| extend m = parse_json(message)
| where tostring(m.boundary) == 'web_bearer' and tostring(m.policy_audience) == 'kilo-api'
    and tostring(m.cohort) != 'not_internal_bot'
| summarize lines = count(), requests_estimate = dcount(['request.id']),
    cli_marked_lines = countif(tostring(m.client) == 'cli_marked'),
    unmarked_lines = countif(tostring(m.client) == 'unmarked'),
    unknown_lines = countif(tostring(m.client) == 'unknown')
    by day = bin(_time, 1d), surface = ['vercel.projectName'], deployment = ['vercel.deploymentId'], cohort = tostring(m.cohort), outcome = tostring(m.outcome), multi = tobool(m.multi), aud_set = tostring(m.aud_set)
```

```kusto
// Vercel: exact cohort request counts with request-id loss (decides the gate)
['vercel']
| where _time between (datetime(START) .. datetime(END))
| where isnotnull(['vercel.projectName']) and ['vercel.environment'] == 'production'
| where message startswith '{"event":"kilo_token_admission"'
| extend m = parse_json(message)
| where tostring(m.boundary) == 'web_bearer' and tostring(m.policy_audience) == 'kilo-api'
    and tostring(m.cohort) != 'not_internal_bot'
| extend request = tostring(['request.id'])
| summarize lines = count()
    by day = bin(_time, 1d), surface = ['vercel.projectName'], cohort = tostring(m.cohort), outcome = tostring(m.outcome), client = tostring(m.client), request
| summarize requests = countif(isnotempty(request)), lines_without_request_id = sumif(lines, isempty(request)), lines = sum(lines)
    by day, surface, cohort, outcome, client
```

```kusto
// Vercel: multi-audience lines, unparsed lines and an estimate, per surface and day (not for the gate)
['vercel']
| where _time between (datetime(START) .. datetime(END))
| where isnotnull(['vercel.projectName']) and ['vercel.environment'] == 'production'
| where message startswith '{"event":"kilo_token_admission"'
| extend m = parse_json(message)
| summarize multi_lines = countif(tobool(m.multi)),
    multi_requests_estimate = dcountif(['request.id'], tobool(m.multi)),
    unparsed = countif(isnull(m.boundary))
    by day = bin(_time, 1d), surface = ['vercel.projectName'], deployment = ['vercel.deploymentId'], boundary = tostring(m.boundary), policy_audience = tostring(m.policy_audience), outcome = tostring(m.outcome), aud_set = tostring(m.aud_set), issuer = tostring(m.issuer)
```

```kusto
// Vercel: exact multi-audience request counts with request-id loss (decides a nonzero count)
['vercel']
| where _time between (datetime(START) .. datetime(END))
| where isnotnull(['vercel.projectName']) and ['vercel.environment'] == 'production'
| where message startswith '{"event":"kilo_token_admission"'
| extend m = parse_json(message)
| where tobool(m.multi)
| extend request = tostring(['request.id'])
| summarize lines = count()
    by day = bin(_time, 1d), surface = ['vercel.projectName'], policy_audience = tostring(m.policy_audience), outcome = tostring(m.outcome), issuer = tostring(m.issuer), request
| summarize requests = countif(isnotempty(request)), lines_without_request_id = sumif(lines, isempty(request)), lines = sum(lines)
    by day, surface, policy_audience, outcome, issuer
```

```kusto
// Workers: exact multi-audience verifier passes (not unique calls) and unparsed lines, per surface and day
['cloudflare-logpush']
| where _time between (datetime(START) .. datetime(END))
| where ScriptName in ('WORKER_A', 'WORKER_B')
| mv-expand Logs
| extend line = tostring(Logs.Message[0])
| where line startswith '{"event":"kilo_token_admission"'
| extend m = parse_json(line)
| summarize passes = countif(tobool(m.multi)), unparsed = countif(isnull(m.boundary)),
    passes_without_ray_id = countif(tobool(m.multi) and isempty(tostring(['Event.RayID'])))
    by day = bin(_time, 1d), surface = ScriptName, version = ['ScriptVersion.ID'], boundary = tostring(m.boundary), policy_audience = tostring(m.policy_audience), aud_set = tostring(m.aud_set), issuer = tostring(m.issuer)
```

`multi_lines` and `passes` are exact line counts. A Worker result is reported as raw passes. `Event.RayID` is present only on HTTP invocations; Durable Object, queue and RPC invocations carry none, which `passes_without_ray_id` reports. The `unparsed` count here covers only admission-prefixed lines whose JSON does not fully parse, so it cannot observe a Logpush field-truncation marker: the marker is valid JSON and appears outside that prefix. A version-day stays unmeasured from the truncation preflight even when `unparsed = 0` and the control query below finds a 2xx on another invocation.

**Control coverage.** One row per serving version and day; a version or day without a row is unmeasured. On Vercel each accepted control request is identified by the exact key `project|deployment|request id`. The key set is formed first and capped at 1,000; the status side then reads only rows whose key is in that set, so no unrelated row is read and no join runs. Run the preflight first, on the same fixed window:

```kusto
// Vercel preflight: exact number of distinct accepted control keys, capped (0 or 1,000 means unmeasured)
['vercel']
| where _time between (datetime(START) .. datetime(END))
| where ['vercel.projectName'] in ('PROJECT_A', 'PROJECT_B') and ['vercel.environment'] == 'production'
| where message startswith '{"event":"kilo_token_admission"'
| extend m = parse_json(message)
| where tobool(m.control) and tostring(m.outcome) == 'admitted' and isnotempty(['request.id'])
| extend key = strcat(['vercel.projectName'], '|', ['vercel.deploymentId'], '|', tostring(['request.id']))
| summarize by key
| take 1000
| count
```

A result of 0 means no control evidence; a result of 1,000 means the cap may have truncated the set. Either way the window is unmeasured and the coverage query below is not used.

```kusto
// Vercel: accepted control requests whose own status rows are all 2xx, per deployment and day
let control_ids = ['vercel']
| where _time between (datetime(START) .. datetime(END))
| where ['vercel.projectName'] in ('PROJECT_A', 'PROJECT_B') and ['vercel.environment'] == 'production'
| where message startswith '{"event":"kilo_token_admission"'
| extend m = parse_json(message)
| where tobool(m.control) and tostring(m.outcome) == 'admitted' and isnotempty(['request.id'])
| extend key = strcat(['vercel.projectName'], '|', ['vercel.deploymentId'], '|', tostring(['request.id']))
| summarize by key
| take 1000;
['vercel']
| where _time between (datetime(START) .. datetime(END))
| where ['vercel.projectName'] in ('PROJECT_A', 'PROJECT_B') and ['vercel.environment'] == 'production'
| extend key = strcat(['vercel.projectName'], '|', ['vercel.deploymentId'], '|', tostring(['request.id']))
| where key in (control_ids)
| where isnotnull(['request.statusCode'])
| summarize first_seen = min(_time),
    success_rows = countif(toint(['request.statusCode']) between (200 .. 299)),
    other_rows = countif(not(toint(['request.statusCode']) between (200 .. 299)))
    by key, surface = ['vercel.projectName'], deployment = ['vercel.deploymentId']
| where success_rows > 0 and other_rows == 0
| summarize accepted = count() by day = bin(first_seen, 1d), surface, deployment
```

```kusto
// Workers: admitted control lines in HTTP invocations that returned a 2xx, per version and day
['cloudflare-logpush']
| where _time between (datetime(START) .. datetime(END))
| where ScriptName in ('WORKER_A', 'WORKER_B')
| where EventType == 'fetch' and Outcome == 'ok' and toint(['Event.Response.Status']) between (200 .. 299)
| mv-expand Logs
| extend line = tostring(Logs.Message[0])
| where line startswith '{"event":"kilo_token_admission"'
| extend m = parse_json(line)
| where tobool(m.control)
| summarize control_lines = count() by day = bin(_time, 1d), surface = ScriptName, version = ['ScriptVersion.ID']
```

A control count needs only to be nonzero. A request counts only when it has at least one 2xx status row and no other status row; any conflicting status for the same key fails closed. A control key without a status row in the window, whether the row was not ingested or carries another project or deployment, is not counted, and its version stays unmeasured. Compare the `surface` and `deployment` values, and the Worker `surface` and `version` values, with the deployment history of rule 2: every serving version needs its own row.

Non-fetch gap: the Worker query counts only HTTP (`fetch`) invocations, because only they carry a response status. A verifier that runs inside a Durable Object call, an RPC, a queue consumer or a scheduled event is not proved by a control line, even when the same Worker version is; those paths stay unmeasured unless a fetch on the same version reaches the same verifier code path.

Source fields: `message`, `vercel.projectName`, `vercel.environment`, `vercel.deploymentId`, `request.id`, `request.statusCode` (Vercel); `ScriptName`, `ScriptVersion.ID`, `EventType`, `Outcome`, `Event.Response.Status`, `Event.RayID`, `Logs[].Message[0]`, and the whole `Logs` and `Exceptions` arrays for the truncation preflight (Logpush). The `deployment` and `version` columns are compared against the deployment history of rule 2. Confirm the field names, the `EventType` value for HTTP invocations, the `Exceptions` element keys the dataset preserves, and the production project and script names before running.

**Sources.** From source configuration only; nothing here is measured coverage. The combined legacy issuers name only `kilo-api`, `kilo-gateway` and `session-ingest`, so only verifiers of those audiences can receive their tokens:

| Class | Surfaces | Boundaries | Policy audiences |
|---|---|---|---|
| Affected: Vercel web | `apps/web` | `web_bearer`, `policy` | `kilo-api` (the Pages exchange's audiences are labelled `other`) |
| Affected: Vercel gateway | `apps/ai-gateway` | `web_bearer` | `kilo-gateway` |
| Affected Workers | `services/session-ingest`, `services/session-sync`, `services/cloud-agent-next`, `services/auto-routing` | `resource`, `policy`, `exact_audience` (only the `session-ingest` deletion check, labelled `other`) | `session-ingest`, `kilo-api`, `kilo-gateway` (`cloud-agent-next` also its own audience) |
| Observable Workers on other audiences | `services/event-service`, `services/kilo-chat`, `services/user-data-export` | `resource`, `exact_audience` | their own audiences only |

All seven Workers have `nodejs_compat`, a compatibility date from 2025-04-01 and `"logpush": true` in their configuration. The three on other audiences would write a line only for a multi-audience token naming their audience, which no current issuer mints, so they are optional and are not evidence about the combined issuers. Excluded and unmeasured until their configuration changes (rule 3): `ai-attribution` (compatibility date before 2025-04-01), `git-token-service` and `notifications` (no Logpush). `kiloclaw` runs the same shared verifier and could write lines once enabled, but it is outside phase 4 coverage: it is not a candidate and its flag stays off.

Control paths (rule 4), each the control account's own normally issued token on an ordinary route, never a production mint for coverage:

| Surface | Control path | Status |
|---|---|---|
| `apps/web` | the account's API token on a read route such as `GET /api/profile` (`web_bearer`, `kilo-api`) | available |
| `apps/ai-gateway` | the account's token on a model catalogue route (`web_bearer`, `kilo-gateway`), no inference | available |
| `services/session-sync` | the account's human API token requesting a sync grant (`policy`, `kilo-api`, `allow-legacy`) | available |
| `services/session-ingest` | the account's CLI token on a session route (`resource`, `session-ingest`, `allow-legacy`); writes only the account's own synthetic session data unless a read route serves | available |
| `services/auto-routing` | the account's gateway token on its caller-authenticated route (`resource`, `kilo-gateway`, `allow-legacy`) | route to be confirmed; unmeasured until then |
| `services/cloud-agent-next` | none read-only confirmed: a workflow or runtime token needs a session, which costs compute | unmeasured |

**Cost.** No network call, SQL statement, Durable Object hop, database connection, audit row, queue message, scheduled job or new service. Over a window, let `M` be the shared-verifier passes of a multi-audience token, `W` the `web_bearer` decisions on a multi-audience token, `B` the `kilo-api` presentations of an internal bot token, and `K` the control requests times their verifier passes. Lines written = `M + W + B + K`. Each line also carries the log pipeline's own metadata, `D` bytes per line (the Vercel drain's request and deployment fields, or the Logpush trace event around `Logs`), so bytes ≈ `(L + D) × (M + W + B + K)` for an event of `L` bytes. `K` is about one request per serving version per surface per day, independent of the client count. One request can pass more than one verifier; the exact queries count requests. Single-audience and audience-less tokens of anyone but the control account write nothing. While observation is on, each verified single-audience or audience-less token adds one `process.env` read of the control variable and one string compare; the value is parsed once per distinct value. A multi-audience token skips both.

Until every serving `cloud-agent-next` version runs `RUNTIME_TOKEN_AUDIENCE_MODE=per-destination` and the one-lifetime drain of rule 1 completes, `M + W` is dominated by runtime tokens, which name three audiences in `combined` mode and pass a verifier on many runtime requests. It therefore grows with the number of clients that run Cloud Agent sessions, not only with bot traffic:

- `M + W ≈ C × s × r × v`: `C` active clients, `s` the share running Cloud Agent sessions, `r` runtime requests per such client per day that reach a verifier, `v` verifier passes per request.
- `B ≈ n × b`: `n` internal bots, `b` `kilo-api` calls per bot per day; independent of `C`.

Hypothetical example, not a production measurement: with `s = 0.1`, `r = 200`, `v = 2`, `L + D = 1.25 KB` and `B` negligible:

| `C` (hypothetical) | Lines per day | Bytes per day |
|---:|---:|---:|
| 10,000 | 400,000 | 0.5 GB |
| 50,000 | 2,000,000 | 2.5 GB |
| 200,000 | 8,000,000 | 10 GB |

Replace `s`, `r`, `v` and `D` with staging measurements before approving a window.

**Enablement.** No deploy beyond the consumers that already ship these packages, which pick up the code on their normal deploy. Turning the flag on, and again off, changes the environment of each surface, and each change creates a new serving version and cold starts: a Vercel project takes the value on its next deployment, and a Worker var change creates a new Worker version that restarts its isolates. The affected scope (two Vercel projects, four Workers) is twelve serving-version changes per on-and-off cycle; each optional Worker on another audience adds two. All four affected Workers, `event-service` and `kilo-chat` host Durable Objects, so their flag changes happen only off-peak, matching the off-peak rule for Worker deploys; `user-data-export` hosts none but still restarts its isolates. Enablement is bounded: no production enablement that incurs cost before an explicit approval based on the staging estimate; one surface class at a time; a fixed window that ends with the flag off; and an early stop when daily lines exceed twice the approved estimate. The queries run by hand; no monitor or scheduled query is created.

The control subject is set in the same environment change as the flag, so it adds no serving-version change; control requests run by hand through the approved credential workflow, not from a scheduled job.

**Before strict refusal.** The measurement is one input. Strict refusal of multi-audience legacy tokens also needs: every serving `cloud-agent-next` version on `RUNTIME_TOKEN_AUDIENCE_MODE=per-destination` with the one-lifetime drain of rule 1 complete; first-party clients minting one token per audience from `POST /api/internal/bot-token`; and, for the CLI-based bot cohorts (Bouncer Watch, the benchmark CLI, kilo-workflow work sessions), the phase 5 CLI release that presents one credential per audience, because one CLI process sends its one key to the gateway, `kilo-api` and Session Ingest. Until that release, such a cohort's `kilo-api` calls are measured, not refused. The decision then needs explicit approval.

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

Activation is **default-off**. `BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED=true` enables modern payloads at 17 selected web mint sites. Unset, `false`, or any other value retains their existing legacy shape, TTL, and audience behavior. The flag is server configuration, not a request option. No tracked dotenv values or external deployments are changed by this implementation.

| Producer group | Raw mint sites | Lifetime | Audience behavior |
|---|---:|---|---|
| Bitbucket repositories and code-review broker helper | 2 | 300 seconds | Existing exact operation audience in both modes |
| GitLab credential broker and GitHub user access-token broker | 2 | 300 seconds | Existing exact operation audience in both modes |
| GitHub user-authorization disconnect | 1 | 300 seconds | Legacy absent audience; enabled mode uses `git-token-service:github-user-authorizations:disconnect` |
| User export client and deletion-queue leaf-session cleanup | 2 | 300 seconds | Existing `user-data-export` and `session-ingest:user-deletion` audiences in both modes |
| Session Ingest client, active-session/ticket router, active-session list, rename notification | 10 | 3600 seconds | Legacy absent audience; enabled mode uses `session-ingest` |

These assertions continue to omit pepper and environment, preserving the exact receiver contracts. Organization identity is preserved where already supplied. This is trusted backend assertion issuance for existing authorized operations, not a user-returned token-exchange endpoint or a new general delegation grant. Generic Session Ingest assertions are resource-scoped, not single-session or single-route capabilities; incoming-request authorization and receiver ownership checks still matter. Returned Git provider credentials, opaque web/share tickets, and export responses remain separate credential families.

The disconnect reader accepts its dedicated operation audience or legacy audience-less assertions only on its existing POST route. Other Git broker endpoints retain mandatory operation audiences. Token identity, not a user ID supplied in the body, controls disconnect. Deploy this compatible reader before enabling the new producer; do not use a broad API/gateway/Git-service audience as a substitute.

### Activation and rollback

1. Confirm Phase 4 readers (including the web wrap-up) and the dedicated Git-disconnect reader are merged and deployed to every receiving environment. Building the shared workspace package does not deploy a Worker.
2. Run issuer/reader and rollback tests with the flag off and on. Verify unchanged TTLs and omissions, exact audiences, internal/non-exchangeable claims, receiver acceptance, and cross-operation/exchange rejection.
3. An operator can run `pnpm web:env set BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED` and choose `true` only after deployment readiness is confirmed. Agents must not execute that interactive, external-system-changing command.
4. Observe request success and sanitized audience-rejection metrics. Roll back the flag to `false` if required, retaining the defensive readers. Already-issued modern assertions expire after their existing 5-minute/1-hour lifetime and remain accepted by those readers; rollback does not revoke them.

### Explicit PR 5.2 allocation

Modern-builder organization roles also require a deliberate compatibility decision for web `admin` memberships; do not cast or promote them to owner. The generic organization-token issuer is not proven attribution-only and is likewise deferred. User/native credentials, Chat fan-out, Cloud Agent/automation runtime forwarding, and other shared credentials remain PR 5.2 work. The separate Worker-local `services/security-auto-analysis/src/token.ts` snapshot assertion is not one of these 17 web callsites; it is always the modern `session-ingest` assertion (see Current-pepper rule). That Worker's control and triage tokens remain PR 5.2 work. KiloClaw stays minimal for its October EOL. These reallocations keep Phase 5 at exactly two PRs, rather than claiming unsafe control-plane migrations are bounded.

This PR does not retire legacy native exchange, shorten user credentials, change global pepper/session semantics, or remove ordinary legacy resource access.

Workflow issuance reads the existing primary user pepper, including explicit `null`, without initializing or rotating it. Modern workflow tokens retain their audience, purpose, exchange restrictions, and bounded lifetime. This requires no migration and must not reset already initialized peppers; genuine pepper rotation continues to revoke previously issued credentials.

The gateway credential issued for a queued workflow is limited to one hour, and it carries the caller's organization, in both issuance modes. A requested lifetime that is not positive is rejected in both modes. Its compatibility shape omits the audience for receivers that require that shape.

The Cloud Agent workflow credential applies the same one-hour lifetime bound and the same non-positive-lifetime refusal in both issuance modes. Its compatibility shape also omits the audience for receivers that require that shape.

Discord session operations use `generateCloudAgentWorkflowToken` for the installation's
acting user, with the installation's organization scope and a one-hour lifetime.
The shared Cloud Agent rollout flags select the credential format. Model calls retain
their separate API credential; session preparation and initiation use the workflow
credential and the shared model-eligibility policy.

## Current-pepper rule

A pepper rotation revokes every user credential in the web and in every Worker. `packages/worker-utils/src/kilo-token-pepper.ts` owns the decision:

- A present `apiTokenPepper` claim, a string or `null`, must equal the account's current pepper. A claim that is `null` stops working when the pepper changes from `null` to a value.
- `isKiloUserCredentialPepperCurrent` also refuses an absent claim. The web gateway, `auto-routing`, `ai-attribution`, KiloClaw and `verifyKiloBearerAgainstCurrentPepper` (cloud-agent-next, event-service, kilo-chat, notifications) use it. No claimless token is addressed to these receivers.
- `isKiloTokenPepperCurrent` also accepts an absent claim on a short-lived internal assertion (`isKiloClaimlessInternalAssertion`, one hour). Only Session Ingest uses it, through `verifyKiloBearerOrInternalAssertionAgainstCurrentPepper`. The assertion needs `exp - iat` of at most 3600 seconds, `iat` at most 60 seconds ahead, at most 3600 seconds of remaining validity, and either `tokenPurpose: 'internal-service'` with an audience or no `tokenPurpose` (the legacy shape, with or without an audience).
- The legacy shape is temporary. `BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED` is off in production, so the 17 `generateBoundedInternalServiceToken` sites emit it. Remove the branch one hour after the flag is on in production. The one direct `generateInternalServiceToken` caller (Bitbucket workspace access-token release, 300 seconds) does not depend on it: git-token-service verifies that token with its exact operation audience, and the token reaches neither Session Ingest nor the disconnect route.
- `internal-service` does not mean claimless. Workflow control tokens and the security-auto-analysis control and triage assertions carry the pepper claim. The triage assertion goes to the gateway.

The git-token-service GitHub disconnect route accepts only the web's claimless assertion, through the same `isKiloClaimlessInternalAssertion` with a 300-second lifetime and the disconnect audience. A token with a pepper claim is refused. The assertion's `iat` must be at most 60 seconds ahead, and it must be `tokenPurpose: 'internal-service'` with the disconnect audience or, temporarily, have no `tokenPurpose` and either no audience or the disconnect audience. The other git-token-service routes require an exact operation audience, which no user credential carries.

`generateInternalServiceToken` refuses a lifetime above 3600 seconds.

Before this rule, the web accepted any token for an account without a pepper, including one with a stale string claim. Workers and `ai-attribution` skipped the comparison for an absent claim on every account. KiloClaw treated an absent claim as `null`, so it accepted a claimless token for an account without a pepper.

## Dedicated Home widget credential

`activeSessions.widgetCredential({ organizationId })` issues a 30-day,
HS256-signed `kilo-home-widget` audience credential and returns
`{ token, expiresAt }`, where `expiresAt` is epoch milliseconds. Issuance uses
`getResourceDelegationAuthority` and requires a verified native device session.
Browser sessions and human API credentials cannot mint it. Every read rechecks
that device session, its live refresh credential, the account pepper, and exact
organization membership.

This credential is not a general mobile access or refresh token. It cannot
authenticate ordinary tRPC or mutate agent/session state. Only
`GET /api/mobile/widgets` reads Home widget data, and
`POST /api/mobile/widgets/push-token` accepts `{ token, enabled }` to register or
remove an `ios_widget` APNs reload-hint token. A device token moves to the account
that currently holds that device's widget credential; Live Activity rows are never
changed by this route. Both dedicated routes authenticate
the widget audience and derive the exact user/organization scope from signed
claims, rather than client body/query values. Responses use `Cache-Control:
no-store, private`; auth, reads, and registration have a ten-second request bound.

Home widget data may carry `approvalKey`: SHA-256 (lowercase hex) of
`JSON.stringify([kiloSessionId, permissionId])` for the one oldest approvable
cloud permission. The web backend obtains it from the Cloud Agent Worker's
`POST /internal/widgets/approval-key`, gated by `x-internal-api-key` and never
reachable with the widget credential. The Worker re-checks user, exact
organization scope with live membership, and the Kilo/cloud session pairing,
then reads only the control-plane Session DO's stored pending set (no sandbox
wake) and returns the binding, never the raw permission. The key grants no
authority: the app approves only after re-reading the live pending permission
through its ordinary authenticated routes and matching the same key.

Every dedicated request verifies signature, algorithm, audience, environment,
purpose, issuance/expiry/lifetime, the current user and pepper, account blocking,
and actual organization membership (including organization deletion). A
device-bound credential additionally requires its owned unrevoked device session
and a live unconsumed refresh credential. Device sessions have no independent
expiry column, so the refresh credential's expiry defines their usable lifetime.
Widget code never reads, consumes, or rotates the app refresh token itself.
Pepper rotation, account blocking/deletion, organization access loss, session
revocation, or refresh expiry immediately invalidates subsequent reads.

Native storage must protect the credential and clear it with account/scope
changes. Unregister the widget push token before clearing a still-valid
credential where possible. Reload pushes contain no private Home data and are
not authority to restore a cleared account. The native renderer retains its
last-confirmed Home data on transient failures, ages using shared/server-derived
presentation timeline boundaries, and clears private data on explicit auth or
privacy failure.

## MCP account approval

MCP sign-in uses apps/web for account approval and the worker for organization
selection and OAuth issuance. The approval page presents app-provided connection
details for the user to confirm. The worker retains the display code for approval
links and the polling value for the server-side status read, including when the
user returns to an unfinished request.

Deploy the shared database migration, apps/web, then the MCP worker. The worker's
SQLite migration runs on first access to its authorization store.

## GitHub GraphQL session identity

GraphQL redemption preserves the credential source selected when the session capability is issued.
Webhook runs with selected user authorization perform approvals as that user, not the installation bot.
This is intentional: substituting an installation token changes the reviewer and can prevent approvals of bot-authored pull requests.

GraphQL has no repository URL scope.
User-source GraphQL requests retain the user's GitHub permissions; they are not restricted to the capability's repository.
Repository-only and installation-source capabilities continue to use their scoped installation credentials.
Redemption still checks the container binding, current authorization, integration, and recorded identity.
If the selected user authorization disappears, redemption fails without falling back to the bot.

## Native passkey management

A device-session bearer identifies the caller but cannot authorize a passkey change alone.
Adding, renaming, or removing a passkey also requires fresh primary verification.
Email codes and passkey assertions use the existing sign-in proof checks.
Accounts that require SSO approve the change through a fresh browser SSO session for the required organization.
The browser verifies the same account and current SSO policy; management then finishes in the native app.

Each opaque authorization is bound to the account, device session, and operation.
Enrollment also binds its registration challenge.
Only the authorization digest is stored, and successful mutation consumes it atomically.
An authorization expires after five minutes; an SSO approval request expires after ten minutes.
Revocation and account recovery invalidate outstanding authorizations.
Approval URLs carry no authorization secret, and this flow issues no access or refresh token.

`device_auth_request_id` is not an app-versus-CLI security boundary: mobile browser sign-in also sets it.
Authorization depends on the live owned session and independent primary proof, never a user-agent label.
