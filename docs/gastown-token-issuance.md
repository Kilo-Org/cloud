# Gastown token issuance

Gastown modern control issuance is **default-off and not ready for activation**.
Both `SHARED_RESOURCE_TOKENS_ENABLED` and `GASTOWN_RESOURCE_TOKENS_ENABLED` must
be exactly `true` to enable it. Keep the family gate off until the blockers below
are resolved. The `gastown-access` product flag remains a separate access check.

## Issuance and legacy compatibility

`POST /api/gastown/token` validates current session or eligible human/device
credentials through the shared resource-delegation helper. With issuance off,
legacy/browser authority retains the legacy one-hour control response. Modern
credentials, including already-issued modern device credentials, receive
`503 MIGRATION_UNAVAILABLE`. **Gastown is an exception to other families' bounded
modern-device control issuance after rollback.** Modern credentials never fall
back to a broad legacy token. With issuance on, control tokens use only the
`gastown` audience and expire within 55 minutes, capped by parent credential
expiry where applicable. The browser refreshes its cache with a five-minute buffer.

Existing no-audience legacy tokens remain compatible with Gastown readers.
Current account, blocking, ownership and membership checks apply to org access
and legacy renewal. An explicitly signed null pepper is accepted only when it
matches the current DB value; missing/undefined, empty and mismatched peppers
are rejected. No pepper is initialized or rotated by this migration.

Legacy town workload tokens retain their 30-day lifetime. Unattended renewal
checks daily and renews within seven days of expiry; it can recover an expired
original town token only after signature, strict legacy-claim, registry/private
ownership and current DB checks. Manual renewal preserves the town owner as the
token subject even when another eligible org member requests renewal. Removed
or blocked accounts, revoked peppers and ineligible memberships cannot renew.
This change introduces **no legacy end-of-life cutoff**; retiring legacy issuance
requires a separately reviewed migration, not merely enabling the family flag.

## Runtime authorization and rollback

Modern towns persist private identity and a fixed, 30-day runtime authorization.
Runtime bearers last at most one hour and cannot outlive that authorization.
Renewal checks current pepper digests and membership bindings. It snapshots
identity/authorization transactionally, performs external verification outside
the transaction, and atomically checks unchanged authority while merging the
new token into the latest config. Unrelated settings edits and concurrent valid
renewals do not cause spurious failure. Stale renewal cannot replace changed
authority. Reauthorization requires an idle, stopped town and the appropriate
personal owner or organization owner.

Turning issuance off does not revoke existing bearer tokens or convert modern
towns into legacy towns. Missing/corrupt modern metadata remains fail-closed.
Expired/revoked runtime authorization cannot fall back to a stored legacy token.
Rolling back to code unaware of private authorization needs a separate drain or
migration plan.

## Activation blockers

- **Session ingestion:** Gastown runtime tokens have `kilo-api` and
  `kilo-gateway`, but the container also passes them to CLI session ingestion,
  whose reader requires `session-ingest`. Do not weaken the reader.
- **Organization admission:** browser control issuance does not provide the
  exact organization binding required by org-town runtime admission. An
  authorized org-specific mint/client flow is still needed.
- **Live credential renewal:** updating container environment does not safely
  replace provider/auth JSON already captured by running CLI children. Container
  JWT rotation is a separate credential and does not renew Kilo API credentials.
  Refresh delivery, acknowledgment, expiry/reconnect and pinned-CLI behavior
  need verification before enabling one-hour runtime tokens.

The ingest and org-admission blockers are covered by signed downstream contract tests;
this change does not expand runtime audiences, add org minting or implement live
credential delivery.

## Validation and known integration baseline

The extracted Gastown scope is checked with its complete unit suite, the
`town-private-identity` Workers suite, typecheck and lint. The private-identity
suite uses real DO storage; external admission/renewal and unit DB responses are
substituted, so it is not a production database or CLI-container E2E test.

The prior full integration comparison against main `e25c3aa47` reproduced the
same **52 failing test names and 12 unhandled errors** before and after the
Gastown changes. A temporary loader supplied main's Gastown source/tests while
retaining the same dependencies and Workers harness. Failures include stale
scheduler/bead and HTTP expectations, missing `appendEvents` RPC and table reads
after town destruction. This is a known baseline, **not a passing full
integration suite**. The separate identity/renewal suite passes; do not use its
result to claim that all integration tests pass.
