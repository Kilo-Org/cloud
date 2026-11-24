# Kilo token signing: retire the shared `NEXTAUTH_SECRET`

## Goal

`NEXTAUTH_SECRET` is one HS256 secret shared by apps/web, apps/ai-gateway and
13 Workers in this repository. Any deployable that verifies a Kilo token can also mint
any Kilo token for any user and any audience. This plan splits the secret by
purpose:

1. **NextAuth session cookie**: unchanged in apps/web. `NEXTAUTH_SECRET` stays,
   used only by NextAuth in apps/web. apps/ai-gateway stops reading browser
   sessions (see [ai-gateway: no browser sessions](#ai-gateway-no-browser-sessions)),
   so after cutover it holds no secret that can mint Kilo tokens. A later rotation of
   `NEXTAUTH_SECRET` logs everyone out and is out of scope.
2. **Same-service tokens** (minted and verified by one deployable): a dedicated
   symmetric secret per deployable.
3. **Cross-service tokens** (minted by one deployable, verified by another):
   ES256, one private key per issuing deployable. Each issuer is limited to
   allowed audiences and token purposes, and each verification call site
   accepts only the issuers it names.

Every existing token keeps working until a single planned cutover. After the
cutover, HS256 Kilo tokens signed with `NEXTAUTH_SECRET` are refused everywhere,
and clients must re-authenticate. That includes five-year CLI and editor tokens.

apps/ai-gateway does not mint Kilo tokens today, and it must not after this
work: it gets public keys only. It also stops accepting the NextAuth session
cookie, so it authenticates callers by bearer token alone.

## Non-goals

- Changing token lifetimes, claims, the pepper model or `KILO_TOKEN_VERSION`
  semantics, beyond what is listed here. Replacing the five-year user token
  lifetime is planned separately.
- Client changes. How the CLI, the extensions and the mobile app react to the
  cutover's 401 (refresh, or send the user back to sign-in) is handled outside
  this plan.
- Changing the NextAuth session cookie or the secrets that are already
  dedicated: `SESSION_SYNC_SECRET`, `SESSION_SHARE_JWT_SECRET_PROD`,
  `CALLBACK_TOKEN_SECRET`, `BOT_TOKEN_MINT_SECRET`, `MCP_CATALOG_TOKEN_SECRET`,
  `PAGES_AUTH_SECRET`, `PAGES_DEV_AUTH_SECRET`, `GATEWAY_TOKEN_SECRET`,
  `INTERNAL_API_SECRET`.
- A central token-minting service. The `KiloTokenSigner` interface in this plan
  is the seam where one could be added later.

## Inventory

### Issuers of cross-service tokens

Each issuer gets an issuer ID, used as the `kid` prefix, and one ES256 key pair
per environment. The issuer ID is not written into the token as a claim: the
`kid` sits in the signed protected header and is authoritative.

Each issuer is limited to a set of audiences and a set of `tokenPurpose`
values. Only `kilo-web` may sign the legacy shape (no `tokenPurpose`) or omit
`aud`.

| Issuer ID | Deployable | Allowed audiences | Allowed purposes | Legacy shape and audience-less? |
|---|---|---|---|---|
| `kilo-web` | apps/web | `kilo-api`, `kilo-gateway`, `cloud-agent-next`, `session-ingest`, `session-ingest:user-deletion`, `user-data-export`, `ai-attribution`, `kiloclaw`, `kilo-chat`, `event-service`, `notifications`, `pages`, `pages-dev`, every `git-token-service:*` operation audience, `cloud-agent-stream`, `cloud-agent-terminal`, `cloud-agent-preview`, `session-sync:transcript` | All: `human-api`, `device-access`, `delegated-workload`, `internal-service` | Yes. User API tokens, organization tokens, chat tokens, kiloclaw control tokens and the flag-off legacy branches of workflow and internal-service tokens use them today. |
| `cloud-agent-next` | services/cloud-agent-next | `kilo-api`, `kilo-gateway`, `session-ingest` (runtime token array, runtime-proxy attestation, workspace MCP grant) | `delegated-workload` | No |
| `security-auto-analysis` | services/security-auto-analysis | `cloud-agent-next`, `kilo-gateway`, `session-ingest` | `internal-service` | No |
| `webhook-agent-ingest` | services/webhook-agent-ingest | `cloud-agent-next` | `internal-service` | No |
| `kiloclaw` | services/kiloclaw | `kilo-gateway`, `kilo-api`, `session-ingest` for the 30-day machine key | `delegated-workload` | No |

Stream tickets, transcript tokens and runtime-proxy attestations are not Kilo
bearer tokens and carry no `tokenPurpose`. Their dedicated audiences
(`cloud-agent-stream`, `cloud-agent-terminal`, `cloud-agent-preview`,
`session-sync:transcript`) belong to one issuer each. The attestation verifier
accepts only a `cloud-agent-next` key.

`kilo-chat`, `event-service`, `notifications` and `kiloclaw` are allowed for
`kilo-web` ahead of use. apps/web does not mint those audiences yet; those
verifiers accept audience-less tokens (`allow-legacy`) today.

apps/ai-gateway is deliberately absent. Today it only verifies Kilo tokens. Its
one ES256 signer is the Anthropic federation JWT (`CLAUDE_FEDERATION_PRIVATE_KEY`),
which no Kilo service accepts and which is out of scope.

Under these rules, the following existing behaviour changes with ES256:

- Non-web issuers must always set an explicit audience and an allowed
  `tokenPurpose`. security-auto-analysis and webhook-agent-ingest already do:
  `SHARED_RESOURCE_TOKENS_ENABLED` is `"true"` in both environments of their
  `wrangler.jsonc`, so they mint the modern shape today. Their legacy-shape
  branch behind that flag is unused; delete it when they switch to ES256
  rather than keep it HS256-only.

security-auto-analysis runs no Kilo CLI itself. It is a cron- and queue-driven
Worker that triages and extracts findings with direct LLM calls to the gateway
(`/api/openrouter/chat/completions`, `aud: kilo-gateway`), launches Cloud Agent
sessions for analysis and remediation through the `CLOUD_AGENT_NEXT` binding
(`aud: cloud-agent-next`), and reads session transcripts from session-ingest
(`aud: session-ingest`). The Kilo CLI runs inside those Cloud Agent sessions
with a runtime token minted by `cloud-agent-next`, not with a
security-auto-analysis token.
- The kiloclaw machine key moves from the legacy shape to the modern shape
  (`signModernKiloToken`) with `tokenPurpose: 'delegated-workload'`,
  `credentialExchange: false` and the audience array
  `['kilo-gateway', 'kilo-api', 'session-ingest']`.
  `buildModernKiloTokenPayload` emits a single audience today; extend it to
  arrays the way the cloud-agent-next runtime token already uses them. Because
  the key is no longer `human-api`-shaped, the account-bearer, credential
  exchange and session-sync exchange paths refuse it, which is intended. The
  machine presents it to
  the gateway, to apps/web's Exa route
  (`services/kiloclaw/plugins/kiloclaw-customizer/src/kilo-exa-web-search-provider.ts`,
  which apps/web checks for `kilo-gateway`), and, when `KILOCLAW_KILO_CLI=true`,
  to the Kilo CLI inside the instance as `KILO_API_KEY`
  (`controller/src/bootstrap.ts`). The plan assumes that flag is in use, so the
  key keeps `kilo-api` and `session-ingest`. apps/web also mints machine keys (`apps/web/src/routers/kiloclaw-router.ts`,
  `generateApiToken`); it must mint them in the same modern shape with the same
  audience array, so an instance's key has the same scope whichever side minted
  it last. The kiloclaw
  controller routes compare the key as an opaque string against Durable Object
  state, so the audience change does not affect them.

### Verifiers of cross-service tokens

Each verifier needs the public key set (JWKS) and the shared issuer policy. On
top of the issuer policy, each verification call site passes its own issuer
allow-list, so the last column is enforced, not derived. A token is accepted
only when its issuer is in the call site's list and the issuer policy allows
its audience and purpose. These lists apply to ES256 tokens only (HS256 tokens
carry no issuer), so they are enforced from Phase 1. A missing entry surfaces
when that issuer flips in Phase 3, and turning its flag back off rolls it back.

| Verifier | Audience (call site) | Accepted issuers |
|---|---|---|
| apps/web | `kilo-api`, general bearer authentication (`validateAuthorizationHeader`) | `kilo-web`, `cloud-agent-next` (runtime token, workspace MCP grant), `kiloclaw` (in-instance CLI) |
| apps/web | `kilo-api`, credential exchange, account bearers, resource delegation (`verifyKiloTokenForPolicy` in `user/server.ts` and `resource-delegation.ts`) | `kilo-web` |
| apps/web | `kilo-gateway`, Exa route | `kilo-web`, `cloud-agent-next`, `kiloclaw` (security-auto-analysis's gateway token only calls chat completions) |
| apps/web | `cloud-agent-next`, balance route | `kilo-web`, `security-auto-analysis`, `webhook-agent-ingest` |
| apps/web | `pages`, `pages-dev` | `kilo-web` |
| apps/web | runtime-proxy attestation | `cloud-agent-next` |
| apps/ai-gateway | `kilo-gateway` | `kilo-web`, `cloud-agent-next`, `security-auto-analysis`, `kiloclaw` |
| apps/ai-gateway | `kilo-api`, organization model routes (tRPC `getUserFromAuth` default audience) | `kilo-web` |
| apps/ai-gateway | runtime-proxy attestation | `cloud-agent-next` |
| services/session-ingest | `session-ingest` | `kilo-web`, `cloud-agent-next`, `security-auto-analysis`, `kiloclaw` |
| services/session-ingest | `session-ingest:user-deletion` | `kilo-web` |
| services/session-ingest | runtime-proxy attestation | `cloud-agent-next` |
| services/cloud-agent-next | `cloud-agent-next` (control tokens) | `kilo-web`, `security-auto-analysis`, `webhook-agent-ingest` |
| services/cloud-agent-next | `kilo-api`, `kilo-gateway` (balance and model validation, workspace) | `kilo-web`, `cloud-agent-next` |
| services/cloud-agent-next | stream, terminal and preview tickets | `kilo-web` |
| services/kiloclaw | `kiloclaw` | `kilo-web` |
| services/kilo-chat | `kilo-chat` | `kilo-web` |
| services/event-service | `event-service` | `kilo-web` |
| services/notifications | `notifications` | `kilo-web` |
| services/ai-attribution | `ai-attribution` | `kilo-web` |
| services/auto-routing | `kilo-gateway` | `kilo-web`, `security-auto-analysis`, `kiloclaw` |
| services/git-token-service | the `git-token-service:*` operation audiences | `kilo-web` |
| services/user-data-export | `user-data-export` | `kilo-web` |
| services/session-sync | `kilo-api` at credential exchange | `kilo-web` |
| services/session-sync | `session-sync:transcript` | `kilo-web` |
| Test: cloud-agent-next fake-llm Worker | as the gateway | as the gateway |

Because credential exchange, account bearers, resource delegation, Pages
exchange and session-sync exchange accept only `kilo-web`, a non-web key can
never be exchanged for a broader credential, whatever claims it carries.

These deployables carry or present tokens without verifying them, so they need
no key changes:

- code-review-infra stores the web-minted token and forwards it to
  cloud-agent-next.
- services/kilo-mcp relays the cloud-agent-next workspace MCP grant to apps/web.
- auto-routing-benchmark presents bot tokens.
- kiloclaw machines and the controller treat the machine key as an opaque string.
- Cloud Agent sandboxes and the wrapper.
- The mobile app, which only base64-decodes token payloads.

Tokens that are forwarded keep their original signature and `kid`, so the
verifier's issuer, audience and purpose checks still apply:

- cloud-agent-next forwards the caller's legacy token unchanged to the sandbox.
- code-review-infra forwards web tokens.
- kiloclaw machines present a key that either kiloclaw or web minted.

### Same-service uses and their new secrets

Each deployable gets one new secret. Each purpose derives its own subkey with
HKDF-SHA256 under a fixed per-purpose label, so a token minted for one purpose
can never verify as another. A shared `deriveServiceKey(secret, purpose)` helper
in `packages/worker-utils` provides the derivation.
`apps/web/src/lib/claude-billing/pending.ts` already does a hand-rolled version.

**apps/web** gets `WEB_INTERNAL_SECRET`, a Vercel env var on `kilocode-app`
only. It is read from `apps/web/src/lib/web-config.server.ts`; where the code
lives in web-shared, it is read through a lazy getter so apps/ai-gateway never
requires it.

| Use | Location | Mechanism | Lifetime | Output persisted? |
|---|---|---|---|---|
| Turnstile cookie | `app/api/auth/verify-turnstile/route.ts`, `lib/auth/verify-turnstile-jwt.ts`, `lib/user/next-auth-options.ts` | HS256 JWT | 1h | No |
| Account-linking cookie | `lib/account-linking-session.ts` | HS256 JWT | 15m | No |
| Agent-briefing estimate token | `lib/agent-briefing/summary.ts` | HS256 JWT | 15m | No |
| Home-widget credential | `lib/auth/home-widget-credential.ts` | HS256 JWT, `aud: kilo-home-widget` | 30 days | On devices |
| Generic signed token: bot link tokens and state (Linear, GitHub, bot identity), OAuth `state`, app-shell cookies, pages auth code, device-auth viewer token, Bitbucket inbox cursor | `lib/signed-token.ts` and its 11 consumers | HMAC-SHA256 | 60s to 1h | No |
| Claude billing pending cookie | `lib/claude-billing/pending.ts` | A256GCM JWE, key derived from the secret | 10m | No |
| Sign-in code hash | `packages/web-shared/src/lib/auth/magic-link-tokens.ts` | HMAC-SHA256 | 10m | **Yes**, `magic_link_tokens.token_hash` |
| Data-export download code hash | `lib/auth/data-export-download-codes.ts` | HMAC-SHA256 | 10m | **Yes**, `magic_link_tokens` |
| Rate-limit keys (native token, magic-link email, device-auth deny and cancel) | `lib/auth/native-token-rate-limit.ts`, `lib/auth/email-signin-eligibility.ts`, `app/api/device-auth/codes/[code]/route.ts` | HMAC-SHA256 | n/a | In Vercel Firewall counters |
| Org permission-policy ETag | `app/api/organizations/[id]/policy/permission/route.ts` | HMAC-SHA256 | n/a | In client caches |

**services/cloud-agent-next** gets `CLOUD_AGENT_NEXT_INTERNAL_SECRET`, a Secrets
Store binding with `_PROD` and `_DEV` secret names.

| Use | Location | Lifetime | Rotation hazard |
|---|---|---|---|
| Runtime-credential-proxy handle | `runtime-credential-proxy.ts`, `runtime-credential-proxy-rpc.ts`; verified in `server.ts`, `sandbox-do.ts`, `session-sync-authorization.ts` | ≤24h lease | Stored in Sandbox DO state (accepted handles) and **embedded in the Vercel network policy** |
| Wrapper launch credential | `sandbox-control/credential.ts` | **No `exp`** | Held by running wrappers |
| Sandbox transfer and control-log grants | `sandbox-control/sandbox-transfer-grant.ts` | 4h | In the sandbox env |
| Runtime artifact grant | `sandbox-control/runtime-artifact-grant.ts` | Until the first-connect deadline | In-flight startups |
| Environment-build runner credential | `environment-build/runner-credential.ts` | **No `exp`** | In-flight builds |
| Preview session cookie | `auth.ts`, `preview/route.ts` | 1h | Open previews |
| Runtime-authorization seal | `packages/worker-utils/src/runtime-authorization.ts` (`sealRuntimeAuthorization`) | 5m | Negligible |
| Runtime-proxy origin proof | `runtime-credential-proxy-origin.ts`; set by `sandbox-containers/containers-outbound.ts` and `sandbox-control/vercel-network-policy.ts` | Deterministic | **Embedded in the Vercel network policy**. Not verified yet. |
| Wrapper dispatch ticket | `auth.ts` (`mintWrapperDispatchTicket`, `validateWrapperDispatchTicket`) | 4h | Dead code: neither has a production caller. Delete both rather than migrate them. |

Today `createRuntimeAuthorization` and `renewRuntimeAuthorization` take one
`secret` that is used to verify the caller's token (cross-service), to seal the
record (same-service) and to mint the runtime Kilo token (cross-service). Split
it into a `verifier`, a `sealSecret` and a `signer`.

**services/kiloclaw** gets `KILOCLAW_COOKIE_SECRET`, a Worker secret like the
other kiloclaw secrets.

| Use | Location | Lifetime |
|---|---|---|
| `kilo-worker-auth` access cookie | `src/auth/jwt.ts` (`signKiloToken`), `routes/access-gateway.ts`, `src/auth/middleware.ts` | 24h |

`authMiddleware` currently verifies both the web-minted bearer and this cookie
with `NEXTAUTH_SECRET`. After the split, it verifies the bearer through the
ES256 path and the cookie with `KILOCLAW_COOKIE_SECRET`.

**Pages tokens (`pages`, `pages-dev`).** apps/web mints them through the
delegated-resource signer and verifies them itself
(`app/api/pages-auth/exchange/route.ts`). They are same-service by definition,
but they share the Kilo token builder and the audience map with cross-service
delegated tokens. Decision: sign them with the `kilo-web` ES256 key. Verifying
your own token with its public key costs nothing, and keeping them in this
family avoids a second signer and verifier in `resource-delegation.ts` and the
exchange route. They are user-held bearer tokens that pass through a Pages
deployment, like other delegated tokens; the exchange call site accepts only
`kilo-web` and keeps its strict claim set, so the choice of key gives no extra
reach.

**No other Worker has a same-service use of `NEXTAUTH_SECRET`.**

## Design

### Token format

ES256 tokens carry:

- the header `{ alg: 'ES256', kid: '<issuer-id>:<key-version>' }`;
- an `aud` claim, which is mandatory for every issuer except `kilo-web`, whose
  user, organization and chat tokens stay audience-less until a separate
  audience migration;
- for Kilo bearer tokens from non-web issuers, a `tokenPurpose` the issuer is
  allowed to sign.

No new claims are added; in particular there is no new `iss` claim. The
verifier resolves the issuer from `kid` only, and the verified context exposes
it as `issuer` for call sites that need it. Because no claim is added, the
claim-name allowlists and strict claim parsers need no changes. The two
existing `iss` claims keep their current meaning and checks: the runtime-proxy
attestation's `iss: 'kilocode-runtime-proxy'` (`runtime-proxy-attestation.ts`)
and the session-sync transcript token's `iss: 'kilo-web'`
(`session-transcript.ts`).

The ES256 signer itself refuses to sign, for any issuer other than `kilo-web`,
a payload that is audience-less, lacks `tokenPurpose`, or uses an audience or
purpose outside that issuer's policy. A non-web issuer therefore cannot
produce a legacy-shape token even while its rollout flag for the modern shape
is off.

### Issuer policy

`packages/worker-utils/src/kilo-token-issuers.ts` is the single source of truth.
It maps each issuer ID to its allowed audiences, its allowed purposes, and
whether it may sign the legacy shape or omit `aud`, as in the issuer table
above. Because the policy is compiled into every verifier and signer, widening
an issuer means a code change and a redeploy, which is intended.

An ES256 token verifies only if:

1. `alg` is `ES256` and `kid` resolves to a key in the configured JWKS;
2. the signature is valid;
3. the key's issuer is in the call site's issuer allow-list (verifier table
   above);
4. every `aud` entry, or the absence of `aud`, is allowed for that issuer;
5. for Kilo bearer tokens, `tokenPurpose` is allowed for that issuer, or is
   absent and the issuer may sign the legacy shape;
6. the existing resource-audience check passes (`isKiloResourceAudienceAllowed`
   with `required` or `allow-legacy`, unchanged).

### Keys

- **Private keys:** one JWK per issuer and environment, containing `kid`.
  - Workers: Secrets Store bindings `KILO_TOKEN_SIGNING_KEY`, with secret names
    `KILO_TOKEN_SIGNING_KEY_<ISSUER>_PROD` and `_DEV`.
  - apps/web: the Vercel env var `KILO_TOKEN_SIGNING_KEY`, set **only** on
    `kilocode-app`.
- **Public keys:** `KILO_TOKEN_PUBLIC_JWKS`, a JSON JWKS containing the public
  keys of every issuer for that environment. It is not secret.
  - Workers: a wrangler `vars` entry per environment.
  - Vercel: an env var on both `kilocode-app` and `kilocode-ai-gateway`.
- **Distribution:** use env vars rather than a JWKS endpoint, so verification
  has no runtime dependency on apps/web.
- **Rotation:** add the new public key to the JWKS everywhere, switch the
  issuer's private key, then remove the old public key after the longest
  lifetime that issuer mints. Key IDs carry a version so old and new keys can
  coexist. While the `kilo-web` key still signs five-year tokens, retiring one
  of its keys forces re-authentication like this cutover. The separate work to
  replace the five-year lifetime removes that constraint.

### Verification paths during the transition

The shared signature step, `verifyKiloTokenSignature` in
`packages/worker-utils/src/kilo-token-verification.ts`, becomes a dispatcher:

- `alg: ES256` → JWKS path plus issuer policy.
- `alg: HS256` → legacy path with `NEXTAUTH_SECRET`, exactly as today, while
  `KILO_TOKEN_LEGACY_HS256` is enabled. The flag defaults to enabled until
  cutover, and the path is deleted after it.
- Any other `alg` → reject.

A key is never used outside its algorithm: the HS256 path never sees a public
key, and the ES256 path never sees the HMAC secret. This prevents algorithm
confusion attacks.

The other HS256 verifiers move onto the same dispatcher:

- `packages/web-shared/src/lib/tokens.ts` `tryJwtVerify`
- cloud-agent-next `validateStreamTicket`, the preview-entry path and
  `server.ts` ticket checks
- session-sync's transcript verification (`src/auth.ts`)
- kiloclaw `src/auth/jwt.ts`
- runtime-proxy attestation verification

apps/web verifies on two paths: synchronously with `jsonwebtoken`
(`tryJwtVerify`), and asynchronously through the worker-utils `jose` helpers
(`verifyKiloTokenForPolicy`, `verifyRuntimeProxyAttestation`). The synchronous
path imports the JWKS once into `KeyObject`s with
`crypto.createPublicKey({ key, format: 'jwk' })`. The `jose` path uses
`createLocalJWKSet`, as Workers do. `verifyKiloTokenSignature` and every helper
built on it (`verifyKiloToken*`, `verifyKiloBearerAgainstCurrentPepper`) take a
key-material object (legacy secret plus JWKS) instead of `secret: string`, and
a required `acceptedIssuers` list, so no call site can forget its allow-list.

Each verifier logs a sanitized counter per verification, with the algorithm,
the issuer, the expected audience, a coarse lifetime bucket, and whether
`botId`, `internalApiUse` and `tokenPurpose` are present. The booleans separate
five-year automation tokens from five-year user tokens, which lifetime alone
cannot. It never logs user IDs or token content. These counters drive the
cutover decision.

### Signing

- **Workers.** `packages/worker-utils` exposes a `KiloTokenSigner`:
  `{ issuer, sign(payload) }`. It is built from `KILO_TOKEN_SIGNING_KEY`.
  `signKiloToken`, `signModernKiloToken`, `issueRuntimeProxyAttestation` and the
  public runtime-authorization entry points (`createRuntimeAuthorization`,
  `renewRuntimeAuthorization`, which call the private `issueRuntimeToken`) in
  worker-utils take a signer instead of a secret, as does `signWorkspaceMcpGrant`
  in `services/cloud-agent-next/src/cloud-agent-authority.ts`. During the
  transition, the signer chooses HS256 with the old secret or ES256 with the
  private key based on a per-issuer flag (for `kilo-web`, one flag per token
  family: short-lived cross-service tokens, then user and automation tokens),
  so each issuer can switch, and roll back, on its own.
- **apps/web.** The signing half of `packages/web-shared/src/lib/tokens.ts`
  moves into apps/web. That covers `generateApiToken`,
  `generateOrganizationApiToken`, `generateInternalServiceToken`,
  `generateBoundedInternalServiceToken`, `signWorkflowKiloToken`,
  `generateCloudAgentWorkflowToken` and `generateWorkflowGatewayToken`. The
  verifying half (`validateAuthorizationHeader` and related) stays in
  web-shared. Because nothing else in web-shared calls a Kilo token signer (the
  Anthropic federation JWT signer is unrelated), the gateway
  bundle then contains no signing code and never reads the private key. Signing
  stays synchronous: `jsonwebtoken` signs ES256 with a `KeyObject` from
  `crypto.createPrivateKey({ key, format: 'jwk' })`. The other web signers use
  the same web signer module (the `jose` call sites, such as
  `signModernKiloToken` in `native-remote/token`, use the async worker-utils
  signer with the same key):
  - `lib/auth/resource-delegation.ts`
  - `app/api/internal/bot-token/route.ts`
  - `app/api/native-remote/token/route.ts`
  - `lib/cloud-agent/stream-ticket.ts`
  - `lib/session-transcript.ts`
- **Guard.** A test (or a dependency-cruiser rule) fails if apps/ai-gateway, or
  web-shared runtime code, imports the signer module or reads
  `KILO_TOKEN_SIGNING_KEY`.

### Claim changes

None for the shared Kilo token: issuer identity comes from `kid`, so the
claim-name allowlists (`KILO_EXCHANGE_SAFE_CLAIM_NAMES`,
`legacyExchangeSafeClaimNames`, `accountBearerClaimNames`,
`hasUnsafeLegacyClaims`, `hasRestrictedPrincipalClaims`,
`PAGES_TOKEN_CLAIM_NAMES`, session-sync's `LEGACY_CLAIMS` and `MODERN_CLAIMS`)
and the strict parsers (`validateCloudAgentAuthorityClaims`,
`signKiloTokenPayload`, `modernTokenExtra`) are untouched. The only claim
change is the kiloclaw machine key moving to the modern shape, described under
the issuer table.

## ai-gateway: no browser sessions

Today `getUserFromAuth` (`packages/web-shared/src/lib/user/server.ts`) falls back
to the NextAuth session cookie (`resolveUserFromSession`) when no bearer is
present. Browser requests to app.kilo.ai reach the gateway through the apps/web
rewrites (`apps/web/ai-gateway-rewrites.mjs`), and the cookie travels with them.
That fallback is the only reason the gateway needs `NEXTAUTH_SECRET` besides
HS256 token verification.

**Change.** On the gateway, a request with no bearer token is anonymous. Do not
let this depend on a request header or path. Make it a deployment-level
setting: apps/ai-gateway sets it at build time in its `next.config` `env`, and
`resolveUserFromAuth` returns the anonymous result instead of calling
`resolveUserFromSession`. Also:

- Move the boot-time `NEXTAUTH_SECRET` requirement out of
  `packages/web-shared/src/lib/config.server.ts` into
  `apps/web/src/lib/web-config.server.ts`.
- Read the secret lazily in the session and HS256 verification code, so the
  gateway still boots when it is unset.

**Behaviour change for browser callers.** The catalog routes answer cookie
callers with the public catalog instead of the personal one:

| Route (via rewrite) | Browser callers in apps/web | Today with a cookie | After |
|---|---|---|---|
| `/api/openrouter/models` | `useOpenRouterModels` in `lib/hooks/use-openrouter-models.ts`, used by the organization providers-and-models configuration (`useOrganizationConfiguration`); admin alerting model search (`app/admin/alerting/use-add-model-search.ts`) fetches the same route directly | Personal catalog: the caller's BYOK models, custom routers and BYOK availability tags | Public catalog for the request country |
| `/api/openrouter/models-by-provider` | `useOpenRouterModelsAndProviders` | Public snapshot (filtering needs `organizationId`, which only bearer tokens carry) | Unchanged |
| `/api/openrouter/providers` | `useOpenRouterProviders` | Unauthenticated | Unchanged |

Model pickers already use the tRPC `models.selectorList` procedure in apps/web,
not these routes, so they are unaffected. The organization configuration page
and admin alerting search arguably should show the public catalog anyway,
because the caller's personal BYOK models do not belong in an organization's
configuration. Confirm both during implementation. If a page does need the
personal list, give it a tRPC procedure in apps/web the way `selectorList`
works.

Other gateway routes (inference, FIM, edit, embeddings, transcription,
organization model lists and validation) are called only with bearer tokens:
by the CLI, the extensions, the mobile app and server-side apps/web code. A
browser request to them with only a cookie becomes anonymous and is refused,
where today it is accepted. Nothing records cookie-authenticated gateway
requests today, so first ship a counter on the session fallback in
`resolveUserFromAuth` (per route, no user data), and confirm only the catalog
routes above use it before shipping the change.

**Side effect.** The gateway no longer needs the primary-database
`web_session_pepper` read that `resolveUserFromSession` does from `sfo1`. Remove
that exception from `packages/web-shared/AGENTS.md`.

This change does not depend on the token work and runs as its own track,
alongside Phase 0. It must ship before the Phase 5 cutover.

## Rollout

Phases 1 and 2 are independent. Phase 3 depends on Phase 1 being deployed
everywhere. The ai-gateway session change
([ai-gateway: no browser sessions](#ai-gateway-no-browser-sessions)) is a
separate track that must finish before Phase 5.

### Phase 0: preparation (code only, no behaviour change)

1. Add the issuer registry, the `KiloTokenSigner` interface, the dispatcher with
   only the HS256 branch active, and `deriveServiceKey`.
2. Move web signing into apps/web and add the ai-gateway guard.
3. Split the runtime-authorization `secret` into a verifier, a seal secret and
   a signer.
4. Delete dead token code so it is not migrated:
   - `mintWrapperDispatchTicket` and `validateWrapperDispatchTicket` in
     cloud-agent-next.
   - The `html-deploy` delegable resource (`resource-delegation.ts`, the
     `/api/auth/resource-token` and `/api/organizations/[id]/user-tokens`
     routes and their tests) and `HTML_DEPLOY_AUDIENCE`
     (`internal-service-token-audiences.ts`, re-exported from
     `packages/worker-utils/src/index.ts`). Its only verifier, the Kilo Deploys
     HTML builder in `services/deploy-infra/builder`, was removed with Kilo
     Deploys (#8317), so apps/web can mint `deploy-builder:html-deploy` tokens
     that nothing accepts. After removal, a request for that resource gets the
     routes' existing `400 Unsupported resource`.
5. Add the verification counters.

### Phase 1: readers accept ES256

1. Turn on the ES256 branch of the dispatcher, with the issuer policy and every
   call site's issuer allow-list enforced.
2. Generate key pairs for all five issuers in dev, staging and production. Set
   `KILO_TOKEN_PUBLIC_JWKS` on every verifier in the table above, including the
   e2e fake-llm Worker.
3. Deploy every verifier. Signing is unchanged.

**Exit criteria:** every verifier is deployed with the ES256 branch active, and
a test token from each issuer verifies in staging at each call site that lists
it, and is refused at the others and for any audience or purpose outside its
policy.

### Phase 2: same-service secrets

For each deployable, add the new secret and switch minting to it. During the
transition, verification tries the new key first and falls back to
`NEXTAUTH_SECRET`. The fallback can be removed once the longest lifetime of
each use has passed, and must be removed by the cutover at the latest.

Hashes that are stored need extra care:

- **Sign-in codes and data-export download codes.** On redemption, compute the
  hash under both keys and match either one. Codes expire after 10 minutes, so
  the fallback can go after one release.
- **Rate-limit keys and the ETag.** Switch them directly. A one-time counter
  reset or a cache miss is harmless.

Credentials without expiry, and values pushed to Vercel, also need care:

- **Wrapper launch and environment-build runner credentials.** Add an `exp`
  (the maximum sandbox or build lifetime) at the same time as they move to the
  new secret. Keep the fallback until every sandbox and build created before
  the switch has ended.
- **Runtime-proxy handle and origin proof.** These are embedded in the Vercel
  network policy. Keep accepting handles signed with `NEXTAUTH_SECRET` until
  every Vercel sandbox has either re-applied its policy or been recycled. Ship
  the origin-proof enforcement (which does not exist yet) only on the new
  secret.

Credentials held on user devices:

- **Home-widget credential (30 days).** Keep the fallback for 30 days, or let
  widgets re-issue on the 401 they already handle.
- **kiloclaw cookie (24h).** Keep the fallback for one day.

### Phase 3: issuers switch to ES256

Switch each issuer's flag in turn, watching the counters and the 401 rates
after each step. Rollback is turning the flag off, since HS256 is still
verified.

1. `webhook-agent-ingest` and `security-auto-analysis`. Both already mint the
   modern shape with explicit audiences; delete their unused legacy-shape
   branch in the same change.
2. `kilo-web` short-lived cross-service tokens: stream tickets, transcript
   tokens, bounded internal-service tokens and git, export and deletion
   assertions.
3. `cloud-agent-next`: runtime tokens, runtime-proxy attestations and the
   workspace MCP grant. With dual verification any mix of HS256 and ES256
   tokens and attestations verifies; the prerequisite is that cloud-agent-next's
   own verifiers (balance and model validation, workspace) have the JWKS from
   Phase 1.
4. `kiloclaw` machine key, in the modern shape with the audience array above,
   together with the web-side machine-key mint. Re-mint the keys of running instances so no
   30-day HS256 keys remain at cutover.
5. `kilo-web` user and automation tokens: `generateApiToken` (five-year
   editor, CLI and device tokens), device-session access tokens, organization
   tokens, chat tokens, bot tokens, workflow tokens and delegated resource
   tokens.

### Phase 4: drain

Watch the HS256 counters. Short-lived HS256 tokens disappear on their own. What
remains is five-year user tokens and five-year automation tokens minted by web
(`bot/agent-runner.ts`, `discord/auth.ts`, `code-reviews/review-memory/llm.ts`).
Automation tokens are minted fresh per run, so after Phase 3 they are already
ES256. Confirm this from the counters, broken down by verifier, lifetime bucket
and the automation-marker booleans.

Before cutover, announce the date of the forced re-authentication.

### Phase 5: planned cutover

1. Turn off `KILO_TOKEN_LEGACY_HS256` everywhere, through a coordinated deploy
   of all verifiers.
2. From then on, apps/web and the gateway refuse an HS256 token with a new
   internal reason, `token_algorithm_retired`, which keeps the counters
   distinct, and the same 401 body as the version refusal ("Token version
   outdated, please re-authenticate"). `isRejectedCredentialReason` fails
   closed, so the new reason never falls back to anonymous. Workers return their
   usual 401.
3. Remove the `NEXTAUTH_SECRET` fallbacks from Phase 2.
4. Remove `NEXTAUTH_SECRET` and `NEXTAUTH_SECRET_PROD` and `_DEV` from every
   Worker, and remove `NEXTAUTH_SECRET` from the `kilocode-ai-gateway` Vercel
   project.
5. Delete the HS256 branch, the flags and the legacy test fixtures in a
   follow-up.

After cutover, `NEXTAUTH_SECRET` exists only in `kilocode-app`, used only for
NextAuth. Rotating it is then the separate log-everyone-out operation mentioned
in the Goal.

**Effect on users:** at cutover, every holder of a pre-Phase-3 HS256 user token
is refused. A client that holds a native or device-session refresh token can
refresh and receive an ES256 access token
(`app/api/auth/native/refresh/route.ts`, `app/api/device-auth/token/route.ts`).
Holders of five-year tokens, which have no refresh path, sign in again. Anyone who received a token
after their issuer flipped in Phase 3 is unaffected. No token is refused before
the cutover.

## Configuration and tooling changes

- **wrangler.**
  - Add `KILO_TOKEN_PUBLIC_JWKS` to `vars` (per environment) for all verifier
    Workers.
  - Add the `KILO_TOKEN_SIGNING_KEY` store binding for the four Worker issuers.
  - Add `CLOUD_AGENT_NEXT_INTERNAL_SECRET` and `KILOCLAW_COOKIE_SECRET`.
  - Regenerate `worker-configuration.d.ts` and update the hand-written `Env`
    types in cloud-agent-next and kiloclaw.
- **Vercel.**
  - `KILO_TOKEN_SIGNING_KEY` and `WEB_INTERNAL_SECRET` go on `kilocode-app`
    only.
  - `KILO_TOKEN_PUBLIC_JWKS` goes on both projects.
  - At cutover, remove `NEXTAUTH_SECRET` from `kilocode-ai-gateway`.
  - `pnpm web:env set` writes to both projects today, so it needs a per-project
    option, or an operator sets these by hand.
- **Local dev.**
  - `pnpm dev:env` generates a key pair per issuer and the JWKS, and writes
    them to `.env.local` and the Workers' `.dev.vars`. The existing `pkcs8`
    directive in `dev/local/env-sync/parse.ts` only converts an RSA PEM already
    in `.env.local`, so add a generator directive for EC JWKs and the derived
    JWKS.
  - Add the new symmetric secrets to `GENERATED_LOCAL_SECRET_KEYS`
    (`dev/local/env-sync/plan.ts`), the `.dev.vars.example` files,
    `.env.local.example` and `dev/local/setup-env.ts`.
  - Update `services/kiloclaw/scripts/dev-start.sh` and the fake-llm env copy
    in `dev/local/services.ts`.
- **Tests and seeds.**
  - Add fixed test JWKs in a worker-utils test helper.
  - Update `dev/seed/app/api-token.ts`, the cloud-agent-next e2e auth helpers,
    the kiloclaw `e2e/*.mjs` scripts, the session-sync scripts and the roughly
    40 apps/web tests that mock `config.server` with `NEXTAUTH_SECRET`.
- **Docs.**
  - Update `ENVIRONMENT.md`, `docs/token-issuance-policy.md` (issuer policy,
    per-call-site issuer allow-lists, and the kiloclaw machine key's new
    shape), kiloclaw `DEVELOPMENT.md` and `AGENTS.md`, and the session-ingest
    README.

## Tests

`packages/worker-utils` dispatcher and policy:

- An ES256 token from each issuer is accepted for its allowed audiences and
  refused for any other, including a `webhook-agent-ingest` key signing
  `kilo-api`.
- A non-web issuer's ES256 token is refused when it is audience-less, lacks
  `tokenPurpose`, or carries a purpose outside its policy (for example a
  `cloud-agent-next` key signing `human-api`). The signer refuses to produce
  such tokens in the first place.
- A call site refuses an ES256 token from an issuer outside its allow-list even
  when the audience matches (for example a `cloud-agent-next` runtime token at
  credential exchange, account bearers, resource delegation or session-sync
  exchange).
- An unknown `kid`, `alg: none`, an HS256 token whose HMAC key is the issuer's
  public key, and an ES256 token signed by an unregistered key are all refused.
- Verification helpers do not compile without an `acceptedIssuers` argument.
- When the flag is on, HS256 tokens keep today's behaviour. When it is off,
  they are refused with `token_algorithm_retired`.
- A runtime-proxy attestation is accepted only when `kid` resolves to
  `cloud-agent-next`, and keeps its existing `iss` check.
- A modern-shape kiloclaw machine key is accepted by the gateway, apps/web's
  Exa route, a general `kilo-api` route and session-ingest, and refused by
  credential exchange and account bearers.

Other tests:

- apps/web's synchronous verify and sign through `KeyObject`s, plus the guard
  test against signing imports in ai-gateway.
- ai-gateway: a valid session cookie with no bearer is treated as anonymous on
  every route; the gateway boots and serves bearer traffic with
  `NEXTAUTH_SECRET` unset once HS256 is off. Update the existing gateway
  integration tests that build session cookies (`audience-auth`,
  `model-validation` and `model-validation-agreement`).
- Dual-key verification and hash matching for each Phase 2 use. Specifically,
  stored sign-in and download codes created under `NEXTAUTH_SECRET` still
  redeem.
- cloud-agent-next: mixed HS256 and ES256 runtime tokens and attestations
  verify during the transition, and handles embedded in the Vercel network
  policy keep working through the switch.
- An end-to-end run on the local dev stack: CLI login, a gateway request, a
  Cloud Agent session (runtime token, attestation, session-ingest), kiloclaw
  access, and chat and notifications, each once with HS256 issuers and once
  with ES256 issuers.

## Open questions

1. **Deployed bindings.** How are `NEXTAUTH_SECRET` values set today for
   cloud-agent-next and user-data-export? Neither declares it in its checked-in
   `wrangler.jsonc`. kiloclaw sets its secrets with `wrangler secret put`
   (`services/kiloclaw/wrangler.jsonc` comment). The answer decides where their
   new keys and secrets are configured and what Phase 5 removes.

## Decisions

- **kiloclaw machine key audiences.** Assume `KILOCLAW_KILO_CLI` is in use, so
  the key keeps `kilo-gateway`, `kilo-api` and `session-ingest`.
- **Pages tokens.** Signed with the `kilo-web` ES256 key (see
  [Same-service uses and their new secrets](#same-service-uses-and-their-new-secrets)).
- **Runtime-proxy attestation key.** No separate key: attestations are signed
  with the `cloud-agent-next` key. A second key would live in the same Worker,
  next to the first, so any compromise that leaks one leaks both. The
  attestation stays distinguishable through its own verifier, its existing
  `iss: 'kilocode-runtime-proxy'` check and its 30-second lifetime.
