# Webhook token issuance

Webhook Ingest owns its local `SHARED_RESOURCE_TOKENS_ENABLED` switch. Both
production and development set it to `"false"` in the service's `wrangler.jsonc`.
Only boolean `true` or string `"true"` enables modern issuance. Web/mobile,
security-analysis and Gastown issuance switches do not control it. The shared
signers and receiver contracts already exist on main; this service does not
require those families' pending changes.

## Request and receiver chain

1. Webhook and scheduled deliveries use the same queue consumer. It looks up the
   personal user or organization webhook bot and signs a one-hour credential.
   Blocked accounts are rejected. Flag-off retains the audience-less legacy
   payload; flag-on issues `cloud-agent-next`, `internal-service`,
   `credentialExchange: false`, with automation runtime admission and the exact
   organization for org triggers. Personal issuance preserves an existing null
   pepper; null is a signed value, not a missing claim. The existing bot creation
   helper may initialize a null bot pepper; this is not new personal-user behavior.
2. The consumer caches tokens for 30 minutes under
   `webhook-token:{legacy|modern}:{principal}`. It sends the token through the
   `CLOUD_AGENT` binding (Cloud Agent Next) to `prepareSession`, then
   `initiateFromKilocodeSessionV2`. Both requests include the internal API key and
   skip-balance header. An initiate retry reuses the persisted session ID.
3. Main's Cloud Agent reader accepts its exact audience or legacy credentials and
   checks the current pepper. Profile resolution uses the database. Where a
   balance check applies, modern control tokens use Web's
   `/api/cloud-agent-next/balance`, not `/api/profile/balance`.
4. Modern session admission checks current user/organization authorization and
   exact nullable peppers, then persists runtime authority and replaces the
   control token with a delegated workload token for `kilo-api`, `kilo-gateway`
   and `session-ingest`. Runtime model/provider/API/session requests use those
   matching receivers and the runtime proxy proofs required on main. The control
   assertion is not a general Web API or gateway token. Runtime credentials last
   up to one hour and renew within the 24-hour Cloud Agent delegation, subject to
   current account, pepper, membership and revocation checks. Legacy sessions
   retain the legacy credential path.
5. Completion/failure/interruption uses a separate HMAC callback token bound to
   namespace, trigger ID and request ID. Cloud Agent posts it to
   `/api/callbacks/execution`; this route verifies the HMAC and matching session
   before updating request status. It is exempt from internal-key middleware
   because it authenticates itself. Callback tokens are not Kilo JWTs.

The KiloClaw-chat target takes a separate service-binding RPC path after checking
instance ownership; it neither mints nor consumes these Cloud Agent credentials.

## Rollout and rollback limits

Deploy compatible receiver/runtime code before enabling this local switch.
Switching it off affects future minting and cache selection; it does not convert
persisted modern sessions or running credentials. Retain compatible readers,
renewal and containment until those sessions drain or are explicitly recovered.
Rolling receivers back to audience-less-only verification breaks modern tokens.

Pepper rotation can make cached tokens fail until the cache expires; the consumer
does not automatically remint on a terminal 401. Existing unversioned cache keys
are bypassed. Signing-secret rotation invalidates outstanding credentials, and
callback-secret rotation can invalidate persisted callback targets. Callback
lifecycle/session checks provide replay scoping rather than JWT expiry.

Unit tests cover issuance, explicit-null personal admission, flag/cache selection,
request forwarding and callback handling. They use real signing/policy functions
with mocked DB/service boundaries; they do not certify a deployed end-to-end
Cloud Agent/Web/DO chain.
