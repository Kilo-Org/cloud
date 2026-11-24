# Kilo token signing: retire the shared `NEXTAUTH_SECRET`

## Goal

`NEXTAUTH_SECRET` is one HS256 secret shared by apps/web, apps/ai-gateway and
about fifteen Workers. Any deployable that verifies a Kilo token can also mint
any Kilo token for any user and any audience. This plan splits the secret by
purpose:

1. **NextAuth session cookie**: unchanged in apps/web. `NEXTAUTH_SECRET` stays,
   used only by NextAuth in apps/web. apps/ai-gateway stops reading browser
   sessions (see [ai-gateway: no browser sessions](#ai-gateway-no-browser-sessions)),
   so after cutover it holds no symmetric secret at all. A later rotation of
   `NEXTAUTH_SECRET` logs everyone out and is out of scope.
2. **Same-service tokens** (minted and verified by one deployable): a dedicated
   symmetric secret per deployable.
3. **Cross-service tokens** (minted by one deployable, verified by another):
   ES256, one private key per issuing deployable, with each issuer limited to an
   allow-list of audiences that every verifier enforces.

Every existing token keeps working until a single planned cutover. After the
cutover, HS256 Kilo tokens signed with `NEXTAUTH_SECRET` are refused everywhere,
and clients must re-authenticate. That includes five-year CLI and editor tokens.

apps/ai-gateway does not mint Kilo tokens today, and it must not after this
work: it gets public keys only. It also stops accepting the NextAuth session
cookie, so it authenticates callers by bearer token alone.

## Non-goals

- Changing token lifetimes, claims, the pepper model or `KILO_TOKEN_VERSION`
  semantics, beyond what is listed here.
- Changing the NextAuth session cookie or the secrets that are already
  dedicated: `SESSION_SYNC_SECRET`, `SESSION_SHARE_JWT_SECRET_PROD`,
  `CALLBACK_TOKEN_SECRET`, `BOT_TOKEN_MINT_SECRET`, `MCP_CATALOG_TOKEN_SECRET`,
  `PAGES_AUTH_SECRET`, `GATEWAY_TOKEN_SECRET`, `INTERNAL_API_SECRET`.
- A central token-minting service. The signer interface in this plan
  (Workstream A) is the seam where one could be added later.

## Inventory

### Issuers of cross-service tokens

Each issuer gets an issuer ID, used for both the `iss` claim and the `kid`
prefix, and one ES256 key pair per environment.

| Issuer ID | Deployable | Allowed audiences | Audience-less allowed? |
|---|---|---|---|
| `kilo-web` | apps/web | `kilo-api`, `kilo-gateway`, `cloud-agent-next`, `session-ingest`, `session-ingest:user-deletion`, `user-data-export`, `ai-attribution`, `kiloclaw`, `kilo-chat`, `event-service`, `notifications`, `deploy-builder:html-deploy`, `pages`, `pages-dev`, every `git-token-service:*` operation audience, `cloud-agent-stream`, `cloud-agent-terminal`, `cloud-agent-preview`, `session-sync:transcript` | Yes. User API tokens, organization tokens and chat tokens are audience-less today. |
| `cloud-agent-next` | services/cloud-agent-next | `kilo-api`, `kilo-gateway`, `session-ingest` (runtime token array, runtime-proxy attestation, workspace MCP grant) | No |
| `security-auto-analysis` | services/security-auto-analysis | `cloud-agent-next`, `kilo-gateway`, `session-ingest` | No |
| `webhook-agent-ingest` | services/webhook-agent-ingest | `cloud-agent-next` | No |
| `kiloclaw` | services/kiloclaw | `kilo-gateway` for the 30-day machine key; add `kilo-api` only if the open question below confirms it | No |

apps/ai-gateway is deliberately absent. Today it only verifies Kilo tokens. Its
one ES256 signer is the Anthropic federation JWT (`CLAUDE_FEDERATION_PRIVATE_KEY`),
which no Kilo service accepts and which is out of scope.

Under these rules, the following existing behaviour changes with ES256:

- Non-web issuers must always set an explicit audience. In practice the modern
  token shape becomes mandatory for security-auto-analysis and
  webhook-agent-ingest when they switch to ES256; their legacy-shape flag-off
  branch stays HS256-only.
- The kiloclaw machine key gains `aud: kilo-gateway`. The machine also presents
  the key to the kiloclaw controller routes, but those compare it as an opaque
  string against Durable Object state, so the audience change does not affect
  them.

### Verifiers of cross-service tokens

Each verifier needs the public key set (JWKS) and the shared issuer policy.

| Verifier | Audiences accepted today | Issuers it will accept |
|---|---|---|
| apps/web | `kilo-api`, `kilo-gateway` (Exa), `cloud-agent-next` (balance), `pages`, `pages-dev`, plus runtime attestations | `kilo-web`, `cloud-agent-next`, `security-auto-analysis` (only if it ever targets `kilo-api`; today it does not), `kiloclaw` (if `kilo-api` is confirmed) |
| apps/ai-gateway | `kilo-gateway`, plus runtime attestations | `kilo-web`, `cloud-agent-next`, `security-auto-analysis`, `kiloclaw` |
| services/session-ingest | `session-ingest`, `session-ingest:user-deletion`, plus runtime attestations | `kilo-web`, `cloud-agent-next`, `security-auto-analysis` |
| services/cloud-agent-next | `cloud-agent-next`, `kilo-api`, `kilo-gateway`, stream, terminal and preview tickets | `kilo-web`, `security-auto-analysis`, `webhook-agent-ingest`, and `cloud-agent-next` itself for the workspace MCP grant |
| services/kiloclaw | `kiloclaw` | `kilo-web` |
| services/kilo-chat | `kilo-chat` | `kilo-web` |
| services/event-service | `event-service` | `kilo-web` |
| services/notifications | `notifications` | `kilo-web` |
| services/ai-attribution | `ai-attribution` | `kilo-web` |
| services/auto-routing | `kilo-gateway` | `kilo-web`, `security-auto-analysis`, `kiloclaw` (`cloud-agent-next` runtime tokens are already refused there) |
| services/git-token-service | the `git-token-service:*` operation audiences | `kilo-web` |
| services/user-data-export | `user-data-export` | `kilo-web` |
| services/session-sync | `kilo-api` at credential exchange, `session-sync:transcript` | `kilo-web` |
| External: deploy-builder (not in this repo) | `deploy-builder:html-deploy` | `kilo-web` |
| Test: cloud-agent-next fake-llm Worker | as the gateway | as the gateway |

These deployables carry or present tokens without verifying them, so they need
no key changes:

- code-review-infra stores the web-minted token and forwards it to
  cloud-agent-next.
- auto-routing-benchmark presents bot tokens.
- kiloclaw machines and the controller treat the machine key as an opaque string.
- Cloud Agent sandboxes and the wrapper.
- The mobile app, which only base64-decodes token payloads.

Tokens that are forwarded keep their original issuer, so the verifier's
`(iss, aud)` check still applies:

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
| Wrapper dispatch ticket | `auth.ts` (`mintWrapperDispatchTicket`) | 4h | Dead code. Delete it rather than migrate it. |

Today `createRuntimeAuthorization` and `renewRuntimeAuthorization` take one
`secret` that is used both to seal the record (same-service) and to mint the
runtime Kilo token (cross-service). Split that into a `sealSecret` and a `signer`.

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
delegated tokens. Proposal: sign them with the `kilo-web` ES256 key. Verifying
your own token with its public key costs nothing, and keeping them in this
family avoids a second signer in `resource-delegation.ts`. Decide this in
review.

**No other Worker has a same-service use of `NEXTAUTH_SECRET`.**

## Design

### Token format

ES256 tokens carry:

- the header `{ alg: 'ES256', kid: '<issuer-id>:<key-version>' }`;
- the claim `iss: '<issuer-id>'`;
- an `aud` claim, which is mandatory for every issuer except `kilo-web`, whose
  user, organization and chat tokens stay audience-less until a separate
  audience migration.

All other claims are unchanged. The runtime-proxy attestation keeps its
distinguishing `iss: 'kilocode-runtime-proxy'`, so its issuer is resolved from
`kid` rather than `iss`. The verifier always resolves the issuer from `kid`
and, where `iss` is present, checks that the two agree.

### Issuer policy

`packages/worker-utils/src/kilo-token-issuers.ts` is the single source of truth.
It maps each issuer ID to its allowed audiences and whether audience-less tokens
are allowed, as in the issuer table above. Because the policy is compiled into
every verifier, widening an issuer means a code change and a redeploy of the
affected verifiers, which is intended.

A token verifies only if:

1. `alg` is `ES256` and `kid` resolves to a key in the configured JWKS;
2. the signature is valid;
3. every `aud` entry, or the absence of `aud`, is allowed for that key's issuer;
4. the existing resource-audience check passes (`isKiloResourceAudienceAllowed`
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
  coexist. The `kilo-web` key signs five-year tokens, so retiring one of its
  keys has the same problem as this cutover. To avoid that, the long-lived user
  token family should eventually get shorter lifetimes or refresh tokens; that
  is out of scope here.

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

apps/web's verification is synchronous (`jsonwebtoken`). It keeps that by
importing the JWKS once into `KeyObject`s with `crypto.createPublicKey({ format: 'jwk' })`.
Workers use `jose` with `createLocalJWKSet`.

Each verifier logs a sanitized counter per verification, with the algorithm,
the issuer, the expected audience and a coarse lifetime bucket. It never logs
user IDs or token content. These counters drive the cutover decision.

### Signing

- **Workers.** `packages/worker-utils` exposes a `KiloTokenSigner`:
  `{ issuer, sign(payload) }`. It is built from `KILO_TOKEN_SIGNING_KEY`.
  `signKiloToken`, `signModernKiloToken`, `issueRuntimeToken`,
  `issueRuntimeProxyAttestation` and `signWorkspaceMcpGrant` take a signer
  instead of a secret. During the transition, the signer chooses HS256 with the
  old secret or ES256 with the private key based on a per-issuer flag, so each
  issuer can switch, and roll back, on its own.
- **apps/web.** The signing half of `packages/web-shared/src/lib/tokens.ts`
  moves into apps/web. That covers `generateApiToken`,
  `generateOrganizationApiToken`, `generateInternalServiceToken`,
  `generateBoundedInternalServiceToken`, `signWorkflowKiloToken`,
  `generateCloudAgentWorkflowToken` and `generateWorkflowGatewayToken`. The
  verifying half (`validateAuthorizationHeader` and related) stays in
  web-shared. Because nothing else in web-shared calls a signer, the gateway
  bundle then contains no signing code and never reads the private key. Signing
  stays synchronous: `jsonwebtoken` signs ES256 with a `KeyObject` from
  `crypto.createPrivateKey({ format: 'jwk' })`. The other web signers use the
  same web signer module:
  - `lib/auth/resource-delegation.ts`
  - `app/api/internal/bot-token/route.ts`
  - `app/api/native-remote/token/route.ts`
  - `lib/cloud-agent/stream-ticket.ts`
  - `lib/session-transcript.ts`
- **Guard.** A test (or a dependency-cruiser rule) fails if apps/ai-gateway, or
  web-shared runtime code, imports the signer module or reads
  `KILO_TOKEN_SIGNING_KEY`.

### Schema updates that must reach readers first

Strict claim parsers reject unknown claims, so `iss` must be accepted before any
issuer emits it:

- `kiloTokenPayload` (`packages/worker-utils/src/kilo-token.ts`).
- The credential-exchange claim-name allowlist (`docs/token-issuance-policy.md`,
  `kilo-token-policy.ts`). Add `iss`, but only with the value `kilo-web`. An
  exchange token signed by any other issuer stays ineligible.
- `validateCloudAgentAuthorityClaims` (`packages/worker-utils/src/cloud-agent-authority.ts`),
  which strict-parses claims.
- `buildModernKiloTokenPayload`, whose reserved-claims list needs `iss` as a
  signer-owned claim.

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
| `/api/openrouter/models` | `useOpenRouterModels` in `lib/hooks/use-openrouter-models.ts`, used by the organization providers-and-models configuration (`useOrganizationConfiguration`) and admin alerting model search (`app/admin/alerting/use-add-model-search.ts`) | Personal catalog: the caller's BYOK models, custom routers and BYOK availability tags | Public catalog for the request country |
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
where today it is accepted. Verify this by checking the gateway logs for
cookie-authenticated requests before shipping.

**Side effect.** The gateway no longer needs the primary-database
`web_session_pepper` read that `resolveUserFromSession` does from `sfo1`. Remove
that exception from `packages/web-shared/AGENTS.md`.

This change does not depend on the token work. Ship it in Phase 0.

## Rollout

Phases 1 and 2 are independent. Phase 3 depends on Phase 1 being deployed
everywhere.

### Phase 0: preparation (code only, no behaviour change)

1. Add the issuer registry, the `KiloTokenSigner` interface, the dispatcher with
   only the HS256 branch active, and `deriveServiceKey`.
2. Move web signing into apps/web and add the ai-gateway guard.
3. Split the runtime-authorization `secret` into a seal secret and a signer.
4. Delete the dead `mintWrapperDispatchTicket`.
5. Add the verification counters.
6. Stop the gateway reading browser sessions (see
   [ai-gateway: no browser sessions](#ai-gateway-no-browser-sessions)). This is
   the one Phase 0 item that changes behaviour, and it is independent of the
   rest.

### Phase 1: readers accept ES256

1. Accept `iss` in the schemas listed above.
2. Turn on the ES256 branch of the dispatcher.
3. Generate key pairs for all five issuers in dev, staging and production. Set
   `KILO_TOKEN_PUBLIC_JWKS` on every verifier in the table above, including the
   e2e fake-llm Worker and the external deploy-builder.
4. Deploy every verifier. Signing is unchanged.

**Exit criteria:** every verifier is deployed with the ES256 branch active, and
a test token from each issuer verifies in staging against each of its intended
audiences and is refused for the others.

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

1. `webhook-agent-ingest` and `security-auto-analysis`. Force the modern token
   shape, with explicit audiences.
2. `kilo-web` short-lived cross-service tokens: stream tickets, transcript
   tokens, bounded internal-service tokens and git, export and deletion
   assertions.
3. `cloud-agent-next`: runtime tokens, runtime-proxy attestations and the
   workspace MCP grant. Runtime tokens and attestations must flip together per
   session, because verifiers already check both.
4. `kiloclaw` machine key, with `aud: kilo-gateway`. Re-mint the keys of
   running instances so no 30-day HS256 keys remain at cutover.
5. `kilo-web` user and automation tokens: `generateApiToken` (five-year
   editor, CLI and device tokens), device-session access tokens, organization
   tokens, chat tokens, bot tokens, workflow tokens and delegated resource
   tokens.

### Phase 4: drain

Watch the HS256 counters. Short-lived HS256 tokens disappear on their own. What
remains is five-year user tokens and five-year automation tokens minted by web
(`bot/agent-runner.ts`, `discord/auth.ts`, `code-reviews/review-memory/llm.ts`).
Automation tokens are minted fresh per run, so after Phase 3 they are already
ES256. Confirm this from the counters, broken down by verifier and lifetime
bucket.

Before cutover, also:

- Confirm that the CLI, the extensions and the mobile app send users back to
  sign-in when they get an HS256 refusal (see open questions).
- Announce the date of the forced re-authentication.

### Phase 5: planned cutover

1. Turn off `KILO_TOKEN_LEGACY_HS256` everywhere, through a coordinated deploy
   of all verifiers.
2. From then on, an HS256 token is refused with reason `token_version_outdated`
   ("please re-authenticate"), which clients already handle, rather than
   `invalid_token`.
3. Remove the `NEXTAUTH_SECRET` fallbacks from Phase 2.
4. Remove `NEXTAUTH_SECRET` and `NEXTAUTH_SECRET_PROD` and `_DEV` from every
   Worker, and remove `NEXTAUTH_SECRET` from the `kilocode-ai-gateway` Vercel
   project.
5. Delete the HS256 branch, the flags and the legacy test fixtures in a
   follow-up.

After cutover, `NEXTAUTH_SECRET` exists only in `kilocode-app`, used only for
NextAuth. Rotating it is then the separate
log-everyone-out operation mentioned in the Goal.

**Effect on users:** at cutover, every holder of a pre-Phase-3 HS256 user token
is refused and has to sign in again. Anyone who received a token after their
issuer flipped in Phase 3 is unaffected. No token is refused before the
cutover.

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
    them to `.env.local` and the Workers' `.dev.vars`. Check whether the
    existing `pkcs8` directive in `dev/local/env-sync/parse.ts` already covers
    key generation.
  - Add the new symmetric secrets to `GENERATED_LOCAL_SECRET_KEYS`
    (`dev/local/env-sync/plan.ts`), the `.dev.vars.example` files,
    `.env.local.example` and `dev/local/setup-env.ts`.
  - Update `services/kiloclaw/scripts/dev-start.sh` and the fake-llm env copy
    in `dev/local/services.ts`.
- **Tests and seeds.**
  - Add fixed test JWKs in a worker-utils test helper.
  - Update `dev/seed/lib/api-token.ts`, the cloud-agent-next e2e auth helpers,
    the kiloclaw `e2e/*.mjs` scripts, the session-sync scripts and the roughly
    30 apps/web tests that mock `config.server` with `NEXTAUTH_SECRET`.
- **Docs.**
  - Update `ENVIRONMENT.md`, `docs/token-issuance-policy.md` (issuer table and
    `iss` in the exchange allowlist), kiloclaw `DEVELOPMENT.md` and `AGENTS.md`,
    and the session-ingest README.

## Tests

`packages/worker-utils` dispatcher and policy:

- An ES256 token from each issuer is accepted for its allowed audiences and
  refused for any other, including a `webhook-agent-ingest` key signing
  `kilo-api`.
- An audience-less ES256 token from a non-web issuer is refused.
- An unknown `kid`, a mismatch between `kid` and `iss`, `alg: none`, an HS256
  token whose HMAC key is the issuer's public key, and an ES256 token signed by
  an unregistered key are all refused.
- When the flag is on, HS256 tokens keep today's behaviour. When it is off,
  they are refused with `token_version_outdated`.
- The `iss` claim passes `kiloTokenPayload`, the cloud-agent authority strict
  parser and the exchange allowlist (only for `kilo-web`).

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
- cloud-agent-next: a runtime token and attestation from the same session flip
  together, and handles embedded in the Vercel network policy keep working
  through the switch.
- An end-to-end run on the local dev stack: CLI login, a gateway request, a
  Cloud Agent session (runtime token, attestation, session-ingest), kiloclaw
  access, and chat and notifications, each once with HS256 issuers and once
  with ES256 issuers.

## Open questions

1. **kiloclaw.** `docs/token-issuance-policy.md` mentions an October end of
   life. If kiloclaw is already retired, drop it from scope. If not, does the
   machine key only go to the gateway, or also to `kilo-api` routes?
2. **Clients.** Do the CLI, the VS Code and JetBrains extensions and the mobile
   app send users back to sign-in on `token_version_outdated` and on
   `invalid_token`? The kilocode repository and apps/mobile need checking.
3. **deploy-builder.** Who owns the external `deploy-builder:html-deploy`
   verifier, and how will it receive the JWKS?
4. **Pages tokens.** Sign them with the `kilo-web` ES256 key (proposed), or with
   `WEB_INTERNAL_SECRET`?
5. **Attestation key.** Should the runtime-proxy attestation get a separate
   `cloud-agent-next` key, so a leaked runtime-token key cannot forge
   attestations? Both keys would live in the same Worker, so the benefit is
   limited.
6. **Deployed bindings.** How are `NEXTAUTH_SECRET` values set today for
   cloud-agent-next, kiloclaw and user-data-export? None is declared in their
   checked-in `wrangler.jsonc`.
7. **Five-year lifetime.** Should new user tokens keep a five-year lifetime?
   With per-issuer keys, a shorter lifetime plus refresh would make future
   rotation of the `kilo-web` key possible without forcing everyone to sign in
   again.
