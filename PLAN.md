# Token Plan Plus (Coding Plans) - implementation revision plan

## Outcome

Replace the branch-local Coding Plans implementation with a code-configured catalog and an initial MiniMax offering named **Token Plan Plus**. A subscriber pays `$20` in Kilo Credits for each 30-day period and receives Kilo Gateway access through a plan-managed BYOK entry. The raw MiniMax credential is not exposed to the user. When access terminates, Kilo disables local access and revokes the credential with MiniMax.

This is no longer a backend-only effort: initial product behavior requires catalog, purchase, status, cancellation, `past_due`, and managed-BYOK messaging in the personal Subscription Center. Raw credential viewing and copying are expressly out of scope.

## Accepted decisions

| Decision | Choice |
|---|---|
| Catalog contract | Backend-configured catalog; no minimum provider count |
| Initial offering | MiniMax `Token Plan Plus` only |
| Plan ID | `minimax-token-plan-plus` |
| Managed routing ID | `minimax-token-plan-plus-managed`, separate from plan ID and ordinary `minimax` BYOK |
| Price | `$20` per 30-day period (`20_000_000` internal microdollars) |
| Pricing configuration | Hardcoded in code; no coding-plan price environment variables |
| User credential access | Read-only managed BYOK entry; no raw-key view, copy, edit, disable, or delete |
| Routing isolation | Reuse BYOK plumbing with managed provenance and lifecycle enforcement |
| Initial activation | Atomic guarded debit and provisioning with explicit request idempotency key |
| User cancellation | Effective at paid-period end, then upstream revocation |
| Unfunded renewal with auto-top-up | One opted-in attempt plus up to 24-hour `past_due` grace |
| Unfunded renewal without auto-top-up | Terminate and begin revocation at renewal time |
| Issued keys | Terminal inventory lifecycle; never recycled |
| Re-subscription after termination | New subscription episode and new credential |
| Branch strategy | Rewrite existing unshipped branch implementation and regenerate clean migration |

## Current branch state to replace

The branch already introduced a different Coding Plans backend. These additions are not on `origin/main`, so they should be revised in place rather than supported as legacy behavior.

| Existing branch work | Current behavior | Required revision |
|---|---|---|
| `packages/db/src/schema.ts` and migration `packages/db/src/migrations/0144_white_blob.sql` | Provider-keyed tables with reusable row lifecycle and no revocation state | Replace with plan identity, managed credential states, `past_due`, term history, and managed BYOK provenance |
| `apps/web/src/lib/coding-plans/pricing.ts` | Env-priced BytePlus/Kimi/Z.AI catalog | Replace with code-owned MiniMax Token Plan Plus entry at `20_000_000` microdollars |
| `apps/web/src/lib/coding-plans/index.ts` | Assigns ordinary BYOK credentials; no request idempotency input; no upstream revocation | Implement managed credential activation, immutable episodes, guarded debit, and termination pipeline |
| `apps/web/src/lib/coding-plans/billing-lifecycle-cron.ts` | Immediate insufficient-funds cancellation after one attempted top-up marker | Implement `past_due` grace and revocation retry state machine |
| `apps/web/src/routers/coding-plans-router.ts` | Arbitrary `string` provider inputs | Use Plan ID validation and new status/catalog contract |
| `apps/web/src/lib/user/index.ts` | Cancels subscription and deletes BYOK entry only | Start immediate provider revocation and anonymize inventory linkage |
| Existing tests | Exercise old providers and old lifecycle | Replace with MiniMax managed-credential and payment-recovery coverage |

## Launch prerequisites

These items must be settled before releasing subscriptions to users:

1. Confirm MiniMax Token Plan Plus API endpoint, supported model identifiers, and required request transformation for gateway routing.
2. Confirm an upstream credential-revocation mechanism available to Kilo. Effective cancellation and account deletion cannot comply with `.specs/coding-plans.md` unless Kilo can revoke the assigned credential or reliably initiate revocation and retry failures.
3. Store any MiniMax management authorization as a protected server secret/binding according to existing secret-management conventions. This is distinct from plan pricing; pricing remains hardcoded.
4. Confirm the pricing-layer conversion used to display `$20` of internal accounting as Kilo Credits in the catalog, checkout, subscription detail, and billing history surfaces.

---

## Step 1: Catalog and identity model

### 1a. Code-owned catalog

Replace `apps/web/src/lib/coding-plans/pricing.ts` with a code-owned catalog. Product identity is separate from credential routing identity.

```typescript
export const CODING_PLAN_IDS = ['minimax-token-plan-plus'] as const;
export type CodingPlanId = (typeof CODING_PLAN_IDS)[number];

export type CodingPlanCatalogEntry = {
  planId: CodingPlanId;
  providerName: string;
  name: string;
  managedProviderId: 'minimax-token-plan-plus-managed';
  costMicrodollars: number;
  billingPeriodDays: number;
};

export const CODING_PLAN_CATALOG = {
  'minimax-token-plan-plus': {
    planId: 'minimax-token-plan-plus',
    providerName: 'MiniMax',
    name: 'Token Plan Plus',
    managedProviderId: 'minimax-token-plan-plus-managed',
    costMicrodollars: 20_000_000,
    billingPeriodDays: 30,
  },
} satisfies Record<CodingPlanId, CodingPlanCatalogEntry>;
```

Rules:

- tRPC inputs use a schema derived from `CODING_PLAN_IDS`, not `z.string()`.
- Internal storage and credit transactions use microdollars; API/UI presentation converts to Kilo Credits through the existing pricing layer.
- Remove all `CODING_PLAN_PRICE_*` handling and old BytePlus/Kimi/Z.AI catalog test fixtures.

### 1b. Managed routing identity

Add a dedicated managed credential routing ID, `minimax-token-plan-plus-managed`, without treating it as the Plan ID or standard `minimax` user BYOK ID.

Files to revise:

- `apps/web/src/lib/ai-gateway/providers/openrouter/inference-provider-id.ts`
- `apps/web/src/lib/ai-gateway/providers/direct-byok/direct-byok-definitions.ts`
- `apps/web/src/lib/ai-gateway/providers/direct-byok/direct-byok-meta.ts`
- New MiniMax managed provider definition under `apps/web/src/lib/ai-gateway/providers/direct-byok/`
- Any direct-provider model-sync or static-model registration required by the confirmed MiniMax endpoint

Routing invariants:

- A standard user-supplied `minimax` BYOK key never grants Token Plan Plus entitlement.
- A `minimax-token-plan-plus-managed` credential is usable only while linked to a non-terminal entitled subscription.
- Shared BYOK gateway plumbing may execute requests, but plan-managed credential selection, attribution, and mutation policy remain separate.

---

## Step 2: Data model and clean migration

Revise `packages/db/src/schema.ts`, then regenerate the branch-local migration. Do not edit generated SQL or migration snapshot content by hand.

### 2a. Managed BYOK provenance

Extend `byok_api_keys` so plan-assigned credentials can be recognized and protected independently from keys users supply themselves.

Proposed additions:

```text
byok_api_keys
├── management_source       text NOT NULL DEFAULT 'user' ('user' | 'coding_plan')
```

Behavior:

- Existing BYOK rows default to `user`.
- Coding Plan activation inserts `management_source = 'coding_plan'`.
- The subscription row links the managed BYOK row to its entitlement; BYOK mutations may query that link when constructing errors or status.
- Normal BYOK create/update/enable/disable/delete flows must reject mutation of `coding_plan` entries.

### 2b. `coding_plan_key_inventory`

Rework the branch-local inventory table around a terminal credential lifecycle.

```text
coding_plan_key_inventory
├── id                         uuid PK
├── plan_id                    text NOT NULL  (Kilo catalog identity)
├── provider_id                text NOT NULL
├── upstream_plan_id           text NOT NULL  (MiniMax deprovision identifier)
├── encrypted_api_key          jsonb NULL      (cleared when manual revocation work starts)
├── credential_fingerprint     text NOT NULL UNIQUE
├── status                     text NOT NULL  ('available' | 'assigned' | 'revocation_pending' | 'revoked' | 'revocation_failed')
├── assigned_to_user_id        text NULL FK->kilocode_users.id ON DELETE SET NULL
├── assigned_at                timestamptz
├── revocation_requested_at    timestamptz
├── revoked_at                 timestamptz
├── revocation_attempt_count   integer NOT NULL DEFAULT 0
├── last_revocation_error      text NULL       (sanitized; never raw secrets)
├── created_at                 timestamptz NOT NULL DEFAULT now()
├── updated_at                 timestamptz NOT NULL DEFAULT now()
```

Constraints and rules:

- Available-key query filters `plan_id` and `status = 'available'`; it never infers availability from a null user association.
- Assignment changes `available` to `assigned` in the activation transaction using `FOR UPDATE SKIP LOCKED` or an equivalent atomic claim.
- No transition returns an issued key to `available`.
- `credential_fingerprint` is computed with a keyed, non-reversible fingerprint for duplicate-upload detection; raw key hashes must not become an offline disclosure aid.
- GDPR cleanup clears/anonymizes `assigned_to_user_id` after local access termination while retaining plan, state, timestamps, and non-secret audit evidence.
- Retain a terminal inventory row only for the required credential-audit retention period. After it expires, that row may be removed without destroying subscription billing history.

### 2c. `coding_plan_subscriptions`

Rework subscriptions as distinct episodes. A re-subscription after cancellation inserts a new row and obtains a new credential rather than reactivating a prior row.

```text
coding_plan_subscriptions
├── id                            uuid PK
├── user_id                       text NOT NULL FK->kilocode_users.id ON DELETE CASCADE
├── plan_id                       text NOT NULL
├── managed_provider_id           text NOT NULL
├── key_inventory_id              uuid FK->coding_plan_key_inventory.id ON DELETE SET NULL
├── managed_byok_key_id           uuid FK->byok_api_keys.id ON DELETE SET NULL
├── status                        text NOT NULL ('active' | 'past_due' | 'canceled')
├── cost_microdollars             bigint NOT NULL
├── billing_period_days           integer NOT NULL
├── current_period_start          timestamptz NOT NULL
├── current_period_end            timestamptz NOT NULL
├── credit_renewal_at             timestamptz NOT NULL
├── cancel_at_period_end          boolean NOT NULL DEFAULT false
├── past_due_started_at           timestamptz
├── payment_grace_expires_at      timestamptz
├── auto_top_up_attempted_for_due timestamptz
├── canceled_at                   timestamptz
├── cancellation_reason           text
├── created_at                    timestamptz NOT NULL DEFAULT now()
├── updated_at                    timestamptz NOT NULL DEFAULT now()
```

Constraints and rules:

- Use a partial unique index allowing at most one `active` or `past_due` subscription for `(user_id, plan_id)`.
- Require `key_inventory_id` and `managed_byok_key_id` while a subscription is non-terminal. A canceled subscription may lose those references only after access has ended and applicable credential-record retention permits deletion.
- Canceled rows remain immutable subscription history and do not block a new subscription episode.
- `cancellation_reason` distinguishes user cancellation, insufficient credits, account deletion, and administrative termination.

### 2d. Charged terms and idempotency

Add a charged-term record rather than relying on mutable subscription dates or calendar-month ledger categories to represent purchases.

```text
coding_plan_terms
├── id                         uuid PK
├── subscription_id            uuid NOT NULL FK->coding_plan_subscriptions.id
├── user_id                    text NOT NULL FK->kilocode_users.id
├── plan_id                    text NOT NULL
├── kind                       text NOT NULL ('activation' | 'extension' | 'renewal')
├── idempotency_key            text NOT NULL
├── period_start               timestamptz NOT NULL
├── period_end                 timestamptz NOT NULL
├── cost_microdollars          bigint NOT NULL
├── credit_transaction_id      uuid NOT NULL FK->credit_transactions.id
├── created_at                 timestamptz NOT NULL DEFAULT now()
```

Constraints and rules:

- Unique `(user_id, plan_id, idempotency_key)` prevents duplicate successfully committed user-requested charges.
- A failed precondition or rolled-back activation does not reserve a credential or charge; retrying after correcting balance or capacity may succeed under the same request key because no outcome previously committed.
- Scheduled renewal derives a deterministic idempotency key from subscription and due period; repeated cron work cannot double-charge one term.
- Persist a fixed-size representation or hash of client-provided keys if existing idempotency conventions require it.
- Billing history queries are scoped through `subscription_id` rather than parsing descriptions.

### 2e. Migration workflow

Existing Coding Plans schema and migration are branch-local and unshipped. Replace rather than extend them:

1. Change `packages/db/src/schema.ts` to the final model.
2. Remove branch-added Coding Plans migration artifacts, including `packages/db/src/migrations/0144_white_blob.sql`, its snapshot, and its branch-added journal entry as required by repository migration guidance.
3. Run `pnpm drizzle generate` to create one clean migration from `origin/main` schema to the final Coding Plans schema.
4. Apply migrations in the local test database before running database-backed tests.

---

## Step 3: Credential inventory administration

Implement inventory functions in `apps/web/src/lib/coding-plans/` and expose them through admin procedures in `apps/web/src/routers/coding-plans-router.ts`.

Admin functions:

| Operation | Input | Behavior |
|---|---|---|
| Upload credentials | `{ planId: CodingPlanId, keys: string[] }` | Encrypt keys, create keyed fingerprints, reject duplicates, insert `available` inventory rows |
| Inventory counts | `{ planId?: CodingPlanId }` | Return counts grouped by lifecycle status; never return encrypted or raw key data |
| Retry revocation | `{ inventoryKeyId: string }` | Reattempt upstream revocation only for pending/failed terminal credentials |
| Immediate termination | `{ subscriptionId: string }` | Disable local access immediately and enqueue/start revocation |

Security rules:

- Only `adminProcedure` may upload credentials or invoke remediation.
- Do not log keys, encrypted payloads, authorization headers, or provider management secrets.
- Error messages may include Plan ID, subscription ID, inventory ID, or status; not credential content.

---

## Step 4: Atomic purchase and extension flow

Implement in `apps/web/src/lib/coding-plans/index.ts`.

### 4a. `subscribeToCodingPlan(userId, planId, idempotencyKey)`

For a new subscription episode:

1. Resolve `planId` from `CODING_PLAN_CATALOG`; reject unknown or unavailable plans.
2. Look up an existing charged term for `(userId, planId, idempotencyKey)` before interpreting an active subscription as an extension; return its existing subscription result on retry.
3. If the user has an active subscription and this is a new deliberate purchase, use the extension flow. If the subscription is `past_due` or pending cancellation, reject with a specific recovery/resume error unless a separately designed resume action applies.
4. In one transaction:
   - Atomically debit `20_000_000` microdollars only if available balance remains sufficient at update time.
   - Insert the credit transaction with category tied to the idempotent charged term.
   - Atomically claim one `available` inventory credential for `planId` and set it to `assigned`.
   - Insert a `coding_plan` managed BYOK entry using `managedProviderId`.
   - Insert an `active` subscription episode linked to inventory and BYOK entries.
   - Insert its activation term with the request idempotency key and period snapshot.
5. On insufficient credits, no inventory, duplicate live subscription race, or any insertion failure, roll the transaction back.
6. After successful commit, perform any existing best-effort Kilo Pass usage-bonus evaluation without changing activation success.

Concurrency requirements:

- Guard balance debit within the transaction; a pre-transaction balance read is not authorization to spend.
- Claim inventory through row locking or atomic update.
- Enforce one live subscription through the partial unique index.
- Retry of identical request returns the previously committed term/subscription and does not extend it.

### 4b. Deliberate paid extension

If the API continues to permit pre-purchasing another period for an active subscription:

1. Require a new idempotency key.
2. Atomically debit credits and insert an `extension` charged term.
3. Stack its period onto `current_period_end`.
4. Keep the same assigned managed credential.
5. Do not implicitly undo a pending cancellation; require an explicit resume rule before exposing this behavior in UI.

An initial UI does not need to expose pre-purchase extension unless product requires it; recurring renewal is required.

---

## Step 5: Managed BYOK behavior and MiniMax routing

### 5a. BYOK mutation restrictions

Update backend and UI behavior around BYOK entries:

- `apps/web/src/routers/byok-router.ts` must reject update, enable/disable, and delete mutations for entries with `management_source = 'coding_plan'`.
- BYOK list responses may identify a managed entry and its plan display name, but must never add a raw-key reveal field.
- `apps/web/src/components/organizations/byok/BYOKKeysManager.tsx` must show managed Coding Plan entries as read-only and must not claim that those entries are user-supplied or billed directly by MiniMax.
- A managed BYOK entry cannot be replaced by a standard user-created key under its managed routing ID.

### 5b. Routing entitlement check

When a request selects a Token Plan Plus managed model/provider route:

1. Load the managed BYOK credential only when it is linked to a subscription in `active` or unexpired `past_due` state.
2. Do not fall back to a standard `minimax` BYOK credential for a Token Plan Plus request.
3. Attribute usage to the Coding Plan route and preserve obfuscated identity handling required for upstream traffic.
4. Reject traffic after local termination even while upstream revocation is pending or failed.

### 5c. Provider revocation adapter

Add a MiniMax lifecycle adapter under `apps/web/src/lib/coding-plans/providers/` or the established equivalent location once provider API conventions are confirmed.

Required operation:

```typescript
revokeManagedCredential(inventoryKeyId: string): Promise<'revoked' | 'retryable_failure'>
```

The adapter must:

- Read/decrypt a credential only server-side and only for a required MiniMax management request.
- Redact provider secrets and credential values from logging.
- Record successful revocation or sanitized retry failure without restoring local access.
- Be callable from termination handling and retry cron/remediation tooling.

---

## Step 6: Billing lifecycle and termination

Rewrite `apps/web/src/lib/coding-plans/billing-lifecycle-cron.ts` and revise `apps/web/vercel.json` only if schedule precision must change to meet product timing.

### 6a. User-requested cancellation

`cancelCodingPlanSubscription(userId, subscriptionId)`:

1. For an `active` subscription, set `cancel_at_period_end = true`.
2. Keep managed BYOK access through `current_period_end`.
3. At period end, transition subscription to `canceled`, disable/remove local managed BYOK access, set inventory to `revocation_pending`, and initiate MiniMax revocation.
4. Do not trigger auto-top-up for a cancellation scheduled by the user.

### 6b. Funded renewal

For an `active` subscription due for renewal without scheduled cancellation:

1. Derive deterministic renewal term idempotency from subscription and due period.
2. In one transaction, guard/debit the snapshotted price, insert renewal credit transaction and term, advance period dates, and clear payment-recovery markers.
3. Keep the same managed credential assigned and usable.

### 6c. Unfunded renewal without auto-top-up

At renewal time:

1. If sufficient credits cannot be atomically debited and eligible auto-top-up is disabled, terminate local access immediately.
2. Mark the subscription `canceled` with reason `insufficient_credits`.
3. Start the revocation pipeline.

### 6d. Unfunded renewal with opted-in auto-top-up

At renewal time:

1. If debit fails for insufficient credits and auto-top-up is eligible, set status to `past_due`, set `payment_grace_expires_at = now() + 24 hours`, and record at most one attempted top-up for this due term.
2. Initiate auto-top-up and keep managed BYOK access available during the unexpired grace period.
3. On later sweep, if credits are now sufficient, perform funded renewal atomically and restore `active` status.
4. If grace expires before funded renewal commits, disable local access and start revocation.

### 6e. Revocation retries

A separate sweep or shared lifecycle sweep processes `revocation_pending` and `revocation_failed` credentials:

- On success: mark `revoked`, set `revoked_at`, and clear encrypted secret material when safe.
- On retryable failure: mark `revocation_failed`, retain encrypted material only as needed to retry, increment attempt count, and alert/queue remediation under existing observability patterns.
- Never re-enable local access or return a credential to available inventory because revocation failed.

---

## Step 7: Account deletion and privacy

Update `apps/web/src/lib/user/index.ts` and `apps/web/src/lib/user/index.test.ts`.

For account soft-delete:

1. Find every non-terminal Coding Plan subscription for the user.
2. Immediately disable/remove associated managed BYOK entries, regardless of paid-through date.
3. Set subscriptions to `canceled` with reason `account_deleted` and clear operational payment-recovery flags.
4. Set associated inventory credentials to `revocation_pending` and initiate/retry upstream revocation outside the deletion transaction if an external request cannot be safely transactional.
5. Clear or anonymize direct inventory linkage to the deleted user while retaining non-secret state/timestamp evidence needed to prove credential disposition.
6. Subscription and charged-term rows may remain linked to the existing anonymized `kilocode_users` record for financial history under established retention policy; inventory must not retain a directly attributable subscriber link after cleanup.
7. Preserve the global rule that no raw credential or PII is sent to logs or MiniMax revocation telemetry.

---

## Step 8: API and user surfaces

### 8a. tRPC router

Revise `apps/web/src/routers/coding-plans-router.ts` and its registration as needed.

| Endpoint | Input | Output/behavior |
|---|---|---|
| `catalog` | none | Configured entries with user-facing Kilo Credits cost and billing period |
| `listSubscriptions` | none | Owned episodes including `active`, `past_due`, and terminal history |
| `subscribe` | `{ planId: CodingPlanId, idempotencyKey: string }` | Atomic activation or idempotent prior result |
| `cancel` | `{ subscriptionId: string }` | Schedule end-of-paid-period cancellation for owned active subscription |
| `adminKeyInventory` | `{ planId?: CodingPlanId }` | Non-secret lifecycle counts |
| `adminUploadKeys` | `{ planId: CodingPlanId, keys: string[] }` | Encrypted deduplicated inventory insert |
| `adminTerminateSubscription` | `{ subscriptionId: string }` | Immediate local termination plus revocation pipeline |
| `adminRetryRevocation` | `{ inventoryKeyId: string }` | Retry failed/pending upstream revocation |

### 8b. Subscription Center and managed BYOK UI

Align UI behavior with `.specs/subscription-center.md` and `.specs/coding-plans.md`:

- Complete the Coding Plans group and detail surface under `apps/web/src/components/subscriptions/coding-plans/` and corresponding route.
- Display MiniMax Token Plan Plus Available Product Card when it is configured and the user has no live subscription for that Plan ID.
- Display `active`, cancellation-scheduled, `past_due` with grace deadline, and `canceled` states.
- Show Kilo Credits pricing, paid-through/renewal date, and credit-funded billing history.
- Offer purchase and cancellation actions; cancellation copy states that credential access ends and is revoked at paid-period end.
- Surface managed BYOK presence as read-only; do not display or copy the raw credential.

Before implementing visual changes under `apps/web`, read `design.md` and load the repository `kilo-design` skill as required by repository guidance.

---

## Step 9: Tests and validation

### Core and database tests

Update or replace `apps/web/src/lib/coding-plans/index.test.ts` to cover:

1. Catalog contains MiniMax Token Plan Plus at `20_000_000` microdollars and maps to user-facing Kilo Credits.
2. Activation creates one active subscription, one activation term, one assigned inventory key, and one managed BYOK entry.
3. Explicit idempotency retry returns prior result without another debit, term, or key assignment.
4. Two concurrent activation attempts cannot overspend credits or create two live subscriptions.
5. Insufficient balance commits no term, debit, subscription, or assignment.
6. Empty inventory commits no term, debit, subscription, or assignment.
7. Duplicate uploaded key is rejected through safe fingerprint comparison.
8. Deliberate extension with new idempotency key charges and extends exactly once, if supported.
9. Re-subscription after terminal cancellation creates a new episode and assigns a new key.

### Managed BYOK and routing tests

Add coverage for:

10. Managed entry cannot be edited, disabled, deleted, or raw-key-revealed through ordinary BYOK endpoints.
11. Standard user-supplied `minimax` key does not satisfy Token Plan Plus routing.
12. Token Plan Plus managed route works only while linked subscription is `active` or within valid `past_due` grace.
13. Locally terminated subscription cannot route traffic while upstream revocation is pending or failed.

### Billing and revocation tests

Add `apps/web/src/lib/coding-plans/billing-lifecycle-cron.test.ts` or equivalent coverage for:

14. Successful renewal charges one term and keeps assigned credential.
15. User scheduled cancellation terminates only at paid-period end and starts revocation without auto-top-up.
16. Insufficient renewal without auto-top-up terminates and starts revocation immediately.
17. Eligible auto-top-up creates one `past_due` grace period and one top-up attempt.
18. Credits arriving within grace renew and restore `active` state.
19. Grace expiry terminates and starts revocation.
20. Successful revocation marks terminal inventory state and clears secret material when allowed.
21. Failed revocation keeps local access disabled and remains retryable.

### GDPR, router, and UI tests

Add or update coverage for:

22. Soft-delete immediately removes managed BYOK access, terminalizes subscription, anonymizes inventory linkage, and starts revocation.
23. Router inputs reject unknown Plan IDs and require activation idempotency keys.
24. Admin inventory responses never expose encrypted or raw key material.
25. Subscription Center renders configured offering, status/grace/cancellation messages, and no raw-key controls.

### Verification commands during implementation

Run the narrowest applicable checks as work is completed:

- Start or verify Postgres before database-backed tests: `docker compose -f dev/docker-compose.yml ps postgres` and `pnpm test:db` if needed.
- Run targeted test files with `pnpm test -- <path>`.
- Run affected-package type checks or `scripts/typecheck-all.sh --changes-only` rather than defaulting to full repository typecheck.
- Run `pnpm format` before committing any implementation changes.
- Run the Markdown table-padding check for changes to this plan or the governing specs.

---

## Implementation order

| Phase | Work | Primary files |
|---|---|---|
| 1 | Confirm MiniMax routing and revocation contract | Provider documentation and approved secret/binding configuration |
| 2 | Finalize catalog and identifier types | `apps/web/src/lib/coding-plans/pricing.ts`, provider ID/type files |
| 3 | Replace schema and regenerate branch migration | `packages/db/src/schema.ts`, `packages/db/src/migrations/` |
| 4 | Add MiniMax managed provider and entitlement routing | `apps/web/src/lib/ai-gateway/providers/`, BYOK retrieval/routing files |
| 5 | Implement inventory, activation, term idempotency, extension | `apps/web/src/lib/coding-plans/index.ts` |
| 6 | Protect managed BYOK entries | `apps/web/src/routers/byok-router.ts`, BYOK types/UI |
| 7 | Implement renewal grace, cancellation, and revocation retries | `apps/web/src/lib/coding-plans/billing-lifecycle-cron.ts`, cron route/config |
| 8 | Complete GDPR deletion lifecycle | `apps/web/src/lib/user/index.ts` and tests |
| 9 | Revise tRPC APIs and Subscription Center surfaces | `apps/web/src/routers/coding-plans-router.ts`, subscription components/routes |
| 10 | Replace/add tests and run focused validation | Coding Plan, BYOK, lifecycle, user, router, and UI tests |

## Configuration summary

| Configuration item | Requirement |
|---|---|
| Token Plan Plus price | Hardcoded as `20_000_000` microdollars per 30 days |
| Plan ID | `minimax-token-plan-plus` |
| Managed routing ID | `minimax-token-plan-plus-managed` |
| Price environment variables | None |
| MiniMax revocation authorization | Protected server secret/binding required once provider integration is confirmed |
| Credential encryption | Reuse approved server-side BYOK encryption handling |
| Credential fingerprinting | Keyed non-reversible fingerprint for inventory deduplication |

## Explicitly excluded from initial release

- Raw MiniMax key viewing, copying, export, or direct use by subscribers.
- Ordinary user mutation of plan-managed BYOK entries.
- Additional configured Coding Plan offerings beyond MiniMax Token Plan Plus.
- Compatibility support for the branch-local BytePlus/Kimi/Z.AI and environment-priced implementation being replaced.

---

## Addendum A: implementation review findings (2026-05-27)

This addendum records gaps found by reviewing the current implementation against this plan, `.specs/coding-plans.md`, and the Coding Plans rules in `.specs/subscription-center.md`. The feature is not ready for release until the blocking items are resolved. This review inspected code only; it did not execute tests or application commands.

### Blocking gaps

| Finding | Evidence in current implementation | Required correction |
|---|---|---|
| No production upstream revocation path | `apps/web/src/lib/coding-plans/revocation.ts` accepts an injected revoker, but production cancellation, renewal termination, account deletion, and admin retry only mark credentials `revocation_pending`; calls to `processCredentialRevocation` exist only in tests. | Add a production MiniMax revocation adapter, invoke it from effective termination and account deletion handling, and process pending/failed credentials through retry sweep or remediation tooling. |
| Access termination is not enforced at the paid-period or grace boundary | `apps/web/vercel.json` schedules lifecycle processing hourly; `apps/web/src/lib/ai-gateway/byok/index.ts` permits any `active` subscription without checking `current_period_end`; `apps/web/src/lib/coding-plans/billing-lifecycle-cron.ts` calculates grace as sweep time plus 24 hours. | Gate routing by effective access end, define renewal/grace boundaries from the due timestamp, and use scheduling or request-time enforcement that cannot extend canceled or unfunded access past its allowed deadline. |
| Managed BYOK UI still treats managed credentials as ordinary user keys | `apps/web/src/components/organizations/byok/BYOKKeysManager.tsx` has no `management_source` handling, presents all keys as user-supplied/provider-billed, includes managed provider IDs in creation choices, and renders enable, test, edit, and delete controls for managed entries. | Render Coding Plan managed entries as read-only, remove forbidden actions and ordinary BYOK billing copy, and prevent users from selecting managed provider IDs in create flows. |

These gaps contradict `.specs/coding-plans.md` requirements for effective revocation, exact lifecycle termination, and plan-managed read-only credentials, including sections 3.5, 5.2, 5.4-5.9, 6.2-6.3, and 7.3-7.5.

### Correctness gaps

| Finding | Evidence in current implementation | Required correction |
|---|---|---|
| Administrative revocation retry does not perform a retry | `apps/web/src/routers/coding-plans-router.ts` delegates `adminRetryRevocation` to `queueCredentialRevocationRetry`, which only changes inventory status in `apps/web/src/lib/coding-plans/index.ts`. | Make admin retry call the provider adapter or enqueue an executable retry job whose processing and result are visible. |
| Extension can race with cancellation scheduling | `apps/web/src/lib/coding-plans/index.ts` checks `cancel_at_period_end` before the extension update, then updates by subscription ID without a guarded `cancel_at_period_end = false` condition. | Lock or conditionally update the subscription so a concurrent cancellation cannot receive a newly charged extension without an explicit resume action. |
| Terminal episodes lose managed BYOK linkage immediately | Immediate termination, period-end cancellation, renewal-failure termination, and account deletion null `managed_byok_key_id` and delete the BYOK row as soon as access ends. | Preserve retained non-secret episode-to-managed-entry evidence through the required audit retention window, or revise the data model to retain equivalent immutable evidence before deleting the operational BYOK entry. |
| Canceled detail view omits read-only credential notice | `apps/web/src/components/subscriptions/coding-plans/CodingPlanDetail.tsx` suppresses the managed read-only/raw-key notice for `canceled` subscriptions. | Keep managed credential provenance and raw-key unavailability explicit in terminal history views. |

### Release gates still open

- Confirm MiniMax Token Plan Plus API endpoint, model identifiers, and required request transformation. Current implementation enables the UI and registers `https://api.minimax.io/v1` with `MiniMax-M2.7` without repository evidence that the provider contract has been approved.
- Confirm and implement MiniMax credential revocation plus protected management authorization. No production revocation adapter or management secret integration is present.
- Do not expose the feature to users while the production revocation and exact access-termination gaps remain unresolved; `apps/web/src/lib/constants.ts` currently enables Coding Plan subscriptions globally.

### Ambiguities to resolve before adding offerings or finalizing retention

| Topic | Ambiguity | Decision required |
|---|---|---|
| Multi-plan catalog visibility | This plan requires an Available Product Card when the user has no live subscription for a given Plan ID, while `.specs/subscription-center.md` describes showing catalog cards when the Coding Plans group has no non-terminal subscriptions. Current UI hides the full catalog when any live Coding Plan exists. | Specify whether available cards remain visible per unsubscribed Plan ID when another plan is active, then update spec and UI consistently. |
| Inventory subscriber-link anonymization | This plan says GDPR cleanup clears/anonymizes inventory user linkage after local access termination; `.specs/coding-plans.md` explicitly mandates anonymization on account deletion. Current implementation clears linkage only for account deletion. | State whether ordinary cancellation, failed renewal, and administrative termination must clear `assigned_to_user_id`, and define retained audit evidence. |

### Coverage required before release

- Add production-path tests proving effective cancellation, account deletion, cron retry, and administrative retry invoke the MiniMax revocation adapter and persist success/failure outcomes.
- Add routing tests at `current_period_end` and `payment_grace_expires_at` boundaries, including proof that the grace period cannot exceed 24 hours from the due renewal.
- Add a concurrent cancellation-versus-extension test proving a pending cancellation cannot be extended or charged accidentally.
- Add component coverage for managed BYOK read-only presentation, absence of raw-key/mutation controls, and terminal Coding Plan detail messaging.
- Add catalog UI coverage for the resolved multi-plan visibility rule before any second configured offering is introduced.

### Already aligned implementation areas

- Code-owned MiniMax catalog, Plan ID, managed routing ID, price, and billing period are present in `apps/web/src/lib/coding-plans/pricing.ts`.
- Schema includes managed provenance, terminal inventory states, live-subscription uniqueness, charged terms, and request idempotency in `packages/db/src/schema.ts`.
- Initial activation performs guarded debit, atomic inventory claim, managed BYOK creation, subscription creation, and charged-term insertion in one transaction in `apps/web/src/lib/coding-plans/index.ts`.
- Router Plan ID validation and activation idempotency key input are implemented in `apps/web/src/routers/coding-plans-router.ts`.
- Backend ordinary-BYOK mutations for managed entries are rejected in `apps/web/src/routers/byok-router.ts`; remaining gap is user-facing treatment and production lifecycle integration.

---

## Addendum B: ordinary MiniMax BYOK integration direction (2026-05-27)

This addendum records revised direction agreed after Addendum A. It supersedes earlier parts of this plan and Addendum A only where they require a separate managed provider identity, a read-only or restricted Coding Plan BYOK entry, or a plan-specific MiniMax routing namespace. The governing specs in `.specs/coding-plans.md` and `.specs/subscription-center.md` still describe the prior model and must be updated before revised implementation is considered compliant.

### Revised decisions

| Topic | Revised direction |
|---|---|
| Plan ID | Remains `minimax-token-plan-plus` |
| BYOK provider identity | Use existing personal BYOK provider ID `minimax`; do not add `minimax-token-plan-plus-managed` |
| Provider/model routing | Use ordinary existing MiniMax BYOK routing and model availability; do not introduce a subscribed-plan model namespace |
| Initial access setup | Kilo automatically installs a personal `minimax` BYOK configuration from the issued Token Plan Plus credential |
| Existing MiniMax key | Block purchase before confirmation when any personal `minimax` BYOK row already exists; instruct user to remove it from `/byok` first |
| Backend precondition | Activation must independently reject an occupied personal `minimax` BYOK slot before a debit, inventory assignment, or subscription is committed |
| BYOK functionality | Keep normal `/byok` update, test, enable/disable, and delete actions available for the installed MiniMax key |
| Billing after BYOK changes | Updating, disabling, or deleting the BYOK key does not cancel, pause, or otherwise alter Coding Plan subscription billing |
| Origin display | While the installed key is unchanged, `/byok` should identify it as configured by Token Plan Plus and state that BYOK changes do not cancel the subscription |
| End-of-plan cleanup | Remove the MiniMax BYOK row only if it is still the Kilo-installed configuration; preserve a user-replaced or recreated MiniMax key |
| Issued credential revocation | Always revoke the credential assigned from Coding Plan inventory when plan access terminates, whether or not the BYOK row was changed |
| Raw key disclosure | This revision does not add saved-key view or copy behavior; existing raw-credential secrecy remains required |

### Superseded assumptions from the original plan

| Prior plan section | Superseded assumption | Replacement |
|---|---|---|
| Accepted decisions; Step 1b; configuration summary | A dedicated provider ID `minimax-token-plan-plus-managed` represents plan routing | Use the existing `minimax` BYOK provider identity and ordinary MiniMax routing |
| Step 2a; Step 5a; explicit exclusions | A Coding Plan-installed BYOK row is read-only and ordinary BYOK mutations must be rejected | Normal BYOK functionality remains available; provenance is informational and supports cleanup ownership only |
| Step 2c | Every non-terminal subscription must retain a linked BYOK row | Subscription may remain active and billable after user deletes or replaces its configured BYOK key |
| Step 5b | Plan access is routed through a separate entitlement-gated provider path | Installed or user-replaced `minimax` routes as ordinary BYOK when present and enabled |
| Step 8b; Step 9 | Subscription UI and tests must prove read-only managed-key controls | UI and tests must explain automatic setup, ordinary management, and independent billing |
| Addendum A managed-BYOK UI blocker | Exposed ordinary actions are a release-blocking policy violation | Read-only controls are no longer required; missing origin/billing-separation explanation is the remaining UI requirement |

### Revised activation flow

`subscribeToCodingPlan(userId, planId, idempotencyKey)` keeps guarded billing, inventory assignment, charged terms, and immutable subscription episodes, with these changes:

1. Before the purchase confirmation action, the Subscription Center queries whether the user already has a personal BYOK row with `provider_id = 'minimax'`.
2. If a MiniMax key exists, including a disabled key, the purchase surface does not proceed. It tells the user to remove the existing MiniMax key in `/byok` before subscribing.
3. The backend repeats this precondition in activation processing. A stale client or a race that finds an occupied MiniMax slot fails without committing a debit, credential assignment, subscription, or charged term.
4. If the slot is empty, activation atomically debits Kilo Credits, claims an available Token Plan Plus credential, creates a personal BYOK row with `provider_id = 'minimax'`, creates the active subscription episode, and records the activation term.
5. Activation marks the installed BYOK row with `management_source = 'coding_plan'` while it still contains Kilo's installed credential. This marker means "installed by this Coding Plan" for UI and cleanup ownership. It must not authorize restrictions on normal BYOK actions.
6. Activation does not add any new direct-BYOK provider definition or special MiniMax model ID. Traffic uses existing ordinary MiniMax BYOK behavior.

### BYOK ownership and mutation behavior

The `/byok` surface remains a normal key-management surface in the initial release. Special rules apply only to bookkeeping needed to avoid deleting a user's replacement key later.

| User action on installed `minimax` key | BYOK result | Subscription result | Cleanup ownership result |
|---|---|---|---|
| Test | Test through ordinary MiniMax BYOK behavior | Unchanged | Row remains Kilo-installed |
| Disable or re-enable | Toggle key availability normally | Unchanged; billing continues | Row remains Kilo-installed because credential value is unchanged |
| Update credential value | Save replacement value normally | Unchanged; billing continues | Mark row user-managed and detach it from plan cleanup |
| Delete | Delete key normally | Unchanged; billing continues | Link clears; a later user-created MiniMax row is user-managed |
| Create MiniMax after prior delete | Create ordinary MiniMax key normally | Unchanged; billing continues | New row is user-managed and must survive plan termination |

User-facing messaging must be explicit: changing or deleting the key affects MiniMax routing configuration, not Token Plan Plus billing. Subscription cancellation remains available through the Coding Plan detail surface.

### Revised termination and revocation flow

When cancellation becomes effective, renewal fails without recovery, administrative termination occurs, or account deletion requires immediate termination:

1. Transition the Coding Plan subscription according to the lifecycle reason and stop future renewals where applicable.
2. If the subscription still references a BYOK row marked as installed by the Coding Plan, delete that specific row to stop access through Kilo's installed configuration.
3. If the linked row was replaced, detached, deleted, or followed by a user-created `minimax` key, do not delete the current user-managed MiniMax configuration.
4. Move the originally issued inventory credential into `revocation_pending` and run the upstream MiniMax revocation pipeline irrespective of current BYOK row state.
5. Failed upstream revocation must remain retryable and must never cause an issued credential to return to available inventory.
6. Account deletion continues to remove all user BYOK configuration under the general user-deletion policy and anonymizes inventory subscriber linkage as already required.

### Schema and API consequences

Because this branch has not shipped, schema and generated migration artifacts should describe final semantics rather than preserve dedicated-provider terminology.

| Area | Required revision |
|---|---|
| `byok_api_keys.management_source` | Retain it to display install origin and protect cleanup ownership; do not use it to reject mutations |
| Installed-key link | Rename `managed_byok_key_id` to `installed_byok_key_id` and make it nullable for non-terminal subscriptions |
| Live-access constraint | Remove any constraint requiring a BYOK row while subscription is `active` or `past_due` |
| Provider columns | Rename `managed_provider_id` to `provider_id` and store the existing `minimax` provider identity |
| Inventory linkage | Preserve inventory credential linkage independently from mutable or deleted BYOK configuration so revocation targets Kilo's issued credential |
| Catalog/API output | Replace dedicated managed-provider output with ordinary `providerId: 'minimax'` where clients need provider identity |
| Migration | Regenerate the unshipped Coding Plans migration from updated schema instead of layering compatibility behavior onto the obsolete dedicated-provider model |

### Required implementation changes

| Change group | Primary files | Work |
|---|---|---|
| Remove dedicated provider | `apps/web/src/lib/coding-plans/pricing.ts`, `apps/web/src/lib/ai-gateway/providers/openrouter/inference-provider-id.ts`, `apps/web/src/lib/ai-gateway/providers/direct-byok/` | Remove `minimax-token-plan-plus-managed` identity, definition, metadata, and test-model registration |
| Restore ordinary routing | `apps/web/src/lib/ai-gateway/byok/index.ts` | Remove separate managed-provider entitlement lookup and preserve normal `minimax` BYOK retrieval for users and organizations |
| Add activation precondition | `apps/web/src/lib/coding-plans/index.ts`, `apps/web/src/routers/coding-plans-router.ts`, Coding Plan subscribe UI | Warn before purchase and reject activation atomically when user's `minimax` slot is occupied |
| Remove BYOK restrictions | `apps/web/src/routers/byok-router.ts`, `apps/web/src/components/organizations/byok/BYOKKeysManager.tsx` | Remove special mutation rejection and obsolete provider filtering; add informational origin/billing-separation note |
| Track ownership transfer | `apps/web/src/routers/byok-router.ts`, `apps/web/src/lib/coding-plans/index.ts`, schema | On replacement, transfer the BYOK row to user management and detach cleanup ownership without changing billing |
| Revise lifecycle cleanup | `apps/web/src/lib/coding-plans/index.ts`, `apps/web/src/lib/coding-plans/billing-lifecycle-cron.ts`, `apps/web/src/lib/user/index.ts` | Remove only untouched installed row; always revoke issued inventory credential |
| Revise Subscription Center copy | `apps/web/src/components/subscriptions/coding-plans/` | Replace read-only messaging with automatic setup and separate-cancellation messaging |
| Regenerate data model | `packages/db/src/schema.ts`, `packages/db/src/schema-types.ts`, `packages/db/src/migrations/` | Encode nullable installed-key association and ordinary provider identity in one clean branch-local migration |

### Required test changes

Replace tests that enforce the superseded dedicated-provider/read-only behavior with coverage for the revised contract:

1. Catalog and subscription API identify MiniMax Token Plan Plus without a `minimax-token-plan-plus-managed` provider identity.
2. Successful activation installs a personal BYOK row with `provider_id = 'minimax'` and preserves inventory/term/idempotency guarantees.
3. Purchase UI warns when a personal MiniMax BYOK key already exists, and backend activation rejects the same condition without charging or assigning inventory.
4. Ordinary MiniMax routing uses the automatically installed key without a dedicated direct-provider model route.
5. `/byok` allows test, enable/disable, update, and delete for an installed MiniMax key.
6. Disabling or deleting the installed key leaves the Coding Plan subscription active and does not prevent later renewal charging.
7. Updating an installed key transfers BYOK cleanup ownership to the user while leaving subscription and inventory state intact.
8. Effective cancellation removes an untouched installed key, starts revocation of the issued inventory credential, and stops renewal.
9. Effective cancellation preserves a user-replaced or recreated MiniMax key while still revoking Kilo's originally issued inventory credential.
10. Account deletion removes local BYOK access, terminalizes the subscription, anonymizes inventory linkage, and starts revocation as required by privacy rules.
11. Subscription Center and `/byok` copy state that Kilo automatically configures MiniMax, key management is available in `/byok`, and deleting or changing a key does not cancel subscription billing.

### Spec updates required before implementation acceptance

The revised direction conflicts with normative language currently in the governing specs. Update these requirements before treating the resulting implementation as conforming:

| Spec location | Required change |
|---|---|
| `.specs/coding-plans.md` definitions and sections 3.3-3.5 | Replace read-only managed-entry requirement with ordinary provider setup, origin display, and billing-separation rules |
| `.specs/coding-plans.md` sections 5.2, 5.4-5.9 | State that termination removes only unchanged installed configuration while always revoking Kilo-issued credential |
| `.specs/coding-plans.md` sections 6.1-6.3 | Remove separate provider/entitlement namespace; require existing MiniMax BYOK routing and safe collision handling |
| `.specs/coding-plans.md` sections 7.3-7.5 | Replace read-only notice with origin, BYOK management, and independent-billing messaging |
| `.specs/subscription-center.md` Coding Plans rules | Replace managed-read-only copy and cleanup wording with automatic configuration and ownership-transfer behavior |

### Release gates retained from Addendum A

The revised BYOK policy removes the prior read-only-UI blocker, but does not remove lifecycle and provider-safety requirements:

- Implement and verify a production MiniMax credential revocation path, including retry/remediation behavior.
- Enforce effective cancellation and `past_due` expiration at their intended deadlines, rather than relying on a delayed sweep that extends access.
- Confirm ordinary MiniMax BYOK routing supports the Token Plan Plus credential and intended supported models before enabling the offering for users.
- Keep raw issued credentials and provider-management secrets out of UI responses, API responses, logs, analytics, and monitoring.

---

## Addendum C: remaining implementation work for initial pilot (2026-05-27)

This addendum records the implementation work still required for the initial Token Plan Plus pilot after reviewing the branch and resolving open product decisions. It supersedes earlier plan and Addendum A language that requires a dedicated managed provider identity, read-only BYOK behavior, automated MiniMax revocation, strict request-time access cutoff, a separate purchase feature flag, prepaid extensions, or Coding Plans admin-action audit history. Addendum B remains authoritative for ordinary MiniMax BYOK setup and ownership transfer except where this addendum provides more specific pilot behavior.

### Accepted pilot direction

| Topic | Decision |
|---|---|
| Deployment gate | Do not deploy until pilot implementation is complete and validated MiniMax credential inventory is loaded; no separate in-product purchase flag is required |
| BYOK and routing | Retain Addendum B behavior: install an ordinary personal `minimax` key, permit normal BYOK management, and use ordinary MiniMax routing |
| Local end-of-access enforcement | Billing lifecycle cron removes unchanged Kilo-installed BYOK configuration when it processes an expired or canceled subscription; pilot accepts delay until the next scheduled sweep and does not add request-time entitlement enforcement |
| Upstream revocation | MiniMax credential revocation is manual; terminal lifecycle processing immediately moves the originally issued inventory credential to `revocation_pending` |
| Admin operations | Build an in-app admin console for validated inventory upload and manual revocation remediation |
| Credential identification | Each uploaded credential stores its MiniMax plan ID; support uses that identifier for pending or failed deprovision work |
| Secret handling | Admin APIs never reveal issued credentials; terminal lifecycle processing clears encrypted credential material when remediation starts |
| Revocation persistence | Inventory row stores its MiniMax plan ID and disposition fields for `revocation_pending`, `revocation_failed`, or `revoked` work |
| Operational instructions | Admin console links to an externally maintained controlled support playbook |
| Inventory eligibility | A MiniMax credential must pass approved ordinary MiniMax route/model validation before it becomes `available` inventory |
| Paid extensions | Initial release supports activation and recurring renewal only; it rejects new purchase requests for a live subscription |
| BYOK warning UX | Updating, disabling, or deleting an unchanged Token Plan Plus-installed key requires warning confirmation; testing and re-enabling do not |
| BYOK test failures | Return generic customer errors and log sanitized diagnostics only; do not expose raw provider or SDK error text |
| Customer revocation copy | Customer surfaces state that Kilo revokes its issued MiniMax credential when plan access ends; manual support mechanics remain internal |
| Grace display | `past_due` payment recovery deadline displays local date and time |

### Already aligned branch work

No replacement work is required for these areas unless affected by implementation below:

- `apps/web/src/lib/coding-plans/pricing.ts` uses Token Plan Plus with ordinary provider identity `minimax`.
- `packages/db/src/schema.ts` uses `provider_id`, nullable `installed_byok_key_id`, managed-origin metadata, terminal inventory states, charged terms, and live-subscription uniqueness.
- `apps/web/src/lib/coding-plans/index.ts` implements guarded initial activation, inventory claim, ordinary MiniMax installation, and request idempotency.
- `apps/web/src/routers/byok-router.ts` permits normal BYOK mutation and transfers cleanup ownership when the installed credential value is replaced.
- Existing lifecycle and deletion paths already place an issued inventory key in `revocation_pending`; they require completion and coverage work described below.

### Work 1: manual revocation admin console

Add an admin-only Coding Plans operations surface, preferably under `apps/web/src/app/admin/coding-plans/`, backed by `adminProcedure` endpoints in `apps/web/src/routers/coding-plans-router.ts`.

| Operation | Behavior |
|---|---|
| Inventory summary | Display non-secret counts grouped by `plan_id` and lifecycle status |
| Revocation queue | List individual `revocation_pending` and `revocation_failed` credentials with inventory ID, MiniMax plan ID, status, revocation request time, attempt count, and sanitized latest failure; do not return raw or encrypted key material |
| Mark revoked | After external confirmation, transition inventory to `revoked`, set `revoked_at`, increment the operation/attempt count as appropriate, and clear `last_revocation_error` |
| Mark failed | Keep the credential terminal, transition to `revocation_failed`, retain the MiniMax plan ID for later retry, increment attempt count, and store a sanitized failure explanation |
| Requeue | Move a failed item back to `revocation_pending` for another manual attempt without restoring local access or availability |
| Upload inventory | Accept `<api key>::<plan id>` MiniMax entries, validate keys before availability, encrypt accepted keys, fingerprint for duplicate detection, and store plan IDs for later deprovisioning |

Required implementation changes:

- Replace automated-provider assumptions in `apps/web/src/lib/coding-plans/revocation.ts`; production code must expose MiniMax plan IDs and model manual completion, failure, and requeue transitions rather than calling an injected MiniMax revoker.
- Replace or redefine `adminRetryRevocation`, which currently only resets status, with the manual-remediation operations above.
- Link the admin console to the controlled external support playbook for MiniMax revocation and inventory replenishment.
- Do not add a Coding Plans audit-log table or extend generic audit storage for pilot operations.

### Work 2: credential upload validation and secret safety

Update inventory admission so subscribers cannot receive untested MiniMax keys.

- Validate every candidate key through the approved ordinary MiniMax BYOK route and supported Token Plan Plus model behavior before it can be stored with `status = 'available'`.
- Reuse existing encryption handling and keyed fingerprint duplicate protection after validation succeeds.
- Reject invalid, incompatible, or duplicate keys without exposing their value in responses, logs, analytics, or monitoring.
- Keep raw values out of all admin APIs. Pending and failed remediation work exposes only the stored MiniMax plan ID required for deprovisioning.
- Preserve terminal inventory rules: an issued credential never returns to `available`, including after manual revocation failure.

Primary files:

- `apps/web/src/lib/coding-plans/index.ts`
- `apps/web/src/lib/coding-plans/revocation.ts`
- `apps/web/src/routers/coding-plans-router.ts`
- New admin console files under `apps/web/src/app/admin/coding-plans/`

### Work 3: activation and billing API simplification

Remove hidden prepaid extension behavior from `subscribeToCodingPlan()`.

- Continue returning the prior committed activation result when `(userId, planId, idempotencyKey)` matches a successfully charged term.
- For any new request while the user already has an `active` or `past_due` subscription for that Plan ID, reject the purchase instead of creating an `extension` term or extending `current_period_end`.
- Retain recurring renewal as the only initial-release path that purchases a later billing period.
- Existing `extension` term type may remain in schema only if harmless for future compatibility; no initial API or UI path may create it.

Primary files:

- `apps/web/src/lib/coding-plans/index.ts`
- `apps/web/src/routers/coding-plans-router.ts`
- `apps/web/src/lib/coding-plans/index.test.ts`
- `apps/web/src/routers/coding-plans-router.test.ts`

### Work 4: cron-driven lifecycle termination

Keep cron-based local cleanup for the pilot and finish its required behavior. Do not introduce request-time entitlement lookup into ordinary MiniMax BYOK routing.

| Termination cause | Required local behavior at processing time | Required inventory behavior |
|---|---|---|
| Scheduled user cancellation | At first sweep on or after paid-through date, cancel subscription and delete linked BYOK row only if it is still Kilo-installed | Set originally issued credential to `revocation_pending` |
| Renewal without sufficient credits and no recovery | At due sweep, cancel subscription and delete only unchanged installed row | Set originally issued credential to `revocation_pending` |
| Expired `past_due` recovery | At first sweep after stored grace deadline without successful renewal, cancel subscription and delete only unchanged installed row | Set originally issued credential to `revocation_pending` |
| Administrative termination | Cancel and conditionally delete unchanged installed row immediately when action runs | Set originally issued credential to `revocation_pending` |
| Account deletion | Remove BYOK configuration under user deletion policy and terminalize subscription immediately | Set issued credential to `revocation_pending` and anonymize inventory subscriber link |

Invariants:

- A replacement or subsequently created user-owned `minimax` key is never deleted by Coding Plan cancellation, billing failure, or manual revocation work.
- Manual MiniMax revocation does not control local cleanup. Once lifecycle processing terminalizes subscription, Kilo-installed configuration is removed whether upstream work is pending or failed.
- Pilot accepts that unchanged Kilo-installed access may remain usable between paid-period or grace deadline and the next cron execution.

Primary files:

- `apps/web/src/lib/coding-plans/billing-lifecycle-cron.ts`
- `apps/web/src/lib/coding-plans/index.ts`
- `apps/web/src/lib/user/index.ts`

### Work 5: ordinary BYOK safety and warning flows

Retain normal `/byok` actions for the Kilo-installed ordinary MiniMax key, with confirmation only for changes that may remove paid routing access.

| User action | UI requirement | Backend result |
|---|---|---|
| Test | No billing warning confirmation | Execute ordinary MiniMax key test; billing and cleanup ownership remain unchanged |
| Re-enable | No billing warning confirmation | Enable ordinary routing; billing and cleanup ownership remain unchanged |
| Disable | Confirm that MiniMax routing stops while Token Plan Plus billing continues until canceled in Subscription Center | Disable key; subscription and cleanup ownership remain unchanged |
| Update credential value | Confirm that replacement changes routing while billing continues | Save new value, set origin to user-managed, and detach `installed_byok_key_id` |
| Delete | Confirm that deletion removes MiniMax routing while billing continues | Delete row and clear association without canceling subscription |

Also required:

- Keep a compact provenance indicator for an unchanged installed row, such as `Configured by Token Plan Plus`.
- Sanitize BYOK key-test failures: never log or return unfiltered provider response bodies or SDK exception text.
- Add accessible names to icon-only test, update, delete, and reveal/hide-input controls.

Primary files:

- `apps/web/src/routers/byok-router.ts`
- `apps/web/src/components/organizations/byok/BYOKKeysManager.tsx`
- `apps/web/src/routers/byok-router.test.ts`

### Work 6: Subscription Center updates

Retain implemented catalog, status, cancellation, and billing-history surfaces, then close pilot UI gaps:

- Display `past_due` grace expiry with date and local time in summary/detail messaging.
- Keep customer-facing revocation wording at product outcome level: Kilo revokes its issued MiniMax credential when plan access ends.
- Continue stating that Kilo deletes only its unchanged installed MiniMax configuration; a replaced or later user-created key remains untouched.
- Continue prohibiting saved raw-key view or copy controls on customer-facing surfaces.
- Programmatically label the terminal-history toggle and preserve mobile usability of all actions.

Primary files:

- `apps/web/src/components/subscriptions/coding-plans/CodingPlanDetail.tsx`
- `apps/web/src/components/subscriptions/coding-plans/CodingPlansGroup.tsx`
- `apps/web/src/components/subscriptions/helpers.ts`
- `apps/web/src/components/subscriptions/TerminalToggle.tsx`

### Work 7: API contract additions

Revise Coding Plans admin API to support manual operations. Final endpoint names may follow router conventions, but behavior must cover:

| Endpoint behavior | Input | Output/side effects |
|---|---|---|
| List remediation work | Optional `planId`, status/page filters | Non-secret pending/failed inventory rows including stored MiniMax plan IDs only |
| Mark manually revoked | `{ inventoryKeyId }` | Set `revoked` and timestamp completion after provider deprovisioning succeeds |
| Mark manual failure | `{ inventoryKeyId, reason }` | Set `revocation_failed` with sanitized reason and retained MiniMax plan ID |
| Requeue manual revocation | `{ inventoryKeyId }` | Set `revocation_pending` for a failed/pending item without re-enabling access |
| Upload validated inventory | `{ planId, entries }` | Parse `<api key>::<plan id>` entries, validate keys, then encrypt/dedupe/store accepted inventory without returning raw material |

Security rules:

- Every remediation procedure uses `adminProcedure`.
- Queue, count, and status responses never contain raw or encrypted credential values.
- Queue responses expose MiniMax plan IDs only when support needs them for terminal remediation.
- Logs and monitoring never contain issued keys, authorization headers, or unfiltered provider errors.
- Pilot does not require an audit event log for manual transitions; inventory disposition fields remain required.

### Work 8: tests and validation

Replace obsolete automated-revoker and prepaid-extension expectations and add coverage for the pilot contract.

| Test area | Required coverage |
|---|---|
| Activation | Occupied MiniMax slot, including disabled key, rejects without charge or assignment; validated available credential installs ordinary `minimax` BYOK; idempotency retry returns original result |
| No extension | A new purchase request for an already live subscription is rejected and creates no debit or term; recurring renewal still advances period exactly once |
| Inventory upload | `<api key>::<plan id>` parsing persists MiniMax plan IDs; validation occurs before `available`; invalid/incompatible and duplicate credentials never become assignable; admin responses omit raw/encrypted values |
| Manual revocation admin | Pending/failed list exposes stored MiniMax plan IDs without raw credentials; failure/requeue transitions remain terminal |
| Lifecycle cron | User cancellation, unfunded renewal, and expired grace delete only unchanged installed row, preserve replacement/recreated keys, clear issued key material, and set original inventory to `revocation_pending` |
| Account deletion | Removes local BYOK access, terminalizes subscription, anonymizes inventory linkage, clears issued key material, and creates pending manual revocation work |
| BYOK UX/API | Installed key remains testable/manageable; update/disable/delete warnings render; update transfers ownership; delete/disable do not cancel billing; failed test errors are generic and sanitized |
| Subscription UI | Configured offering, statuses, billing history, revocation messaging, local-time grace deadline, conditional cleanup copy, and absence of customer raw-key controls |
| Accessibility | Icon-only BYOK actions and terminal-history toggle have accessible names; warning dialogs remain keyboard operable |

### Implementation order

| Phase | Work | Primary files |
|---|---|---|
| 1 | Remove prepaid extension behavior and update backend contract tests | `apps/web/src/lib/coding-plans/index.ts`, router/tests |
| 2 | Implement validate-on-upload and manual revocation transition functions | `apps/web/src/lib/coding-plans/`, `apps/web/src/routers/coding-plans-router.ts` |
| 3 | Build admin console for inventory and manual revocation, with external playbook link | `apps/web/src/app/admin/coding-plans/`, admin navigation/components |
| 4 | Complete cron/deletion preservation tests and disposition behavior | Lifecycle and user deletion files/tests |
| 5 | Implement BYOK confirmation, sanitized errors, and accessibility fixes | BYOK router/component/tests |
| 6 | Update Subscription Center time/copy/accessibility behavior | Subscription components/tests |
| 7 | Validate ordinary MiniMax provider/model behavior and load initial available key inventory | Admin console plus approved operational procedure |
| 8 | Run targeted tests, changed-package type checking, and formatting before release | Affected packages and routes |

### Pilot release acceptance

- Full pilot implementation is complete before deployment; no temporary purchase feature flag is required.
- Initial available MiniMax credential inventory has been validated and loaded through admin tooling.
- Ordinary MiniMax routing/model behavior for Token Plan Plus credentials has been operationally confirmed.
- Support can use the admin console plus external playbook to retrieve a pending or failed MiniMax plan ID, deprovision it in MiniMax, and record disposition in Kilo.
- No customer or admin API exposes issued raw credentials.
- Issued credentials remain terminal after assignment and never return to available inventory.

### Explicitly accepted pilot limitations

- Access through an unchanged Kilo-installed MiniMax BYOK key may continue between its paid-period or grace deadline and the next billing lifecycle cron execution. This is accepted for the pilot; manual upstream revocation does not determine local cutoff.
- Admin manual remediation actions and MiniMax plan IDs are restricted to admin users, but the pilot does not require dedicated or generic audit-log history for those actions.
