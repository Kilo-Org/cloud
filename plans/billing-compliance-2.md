# Team & Enterprise Seat Billing -- Compliance Audit Round 2

Combined action plan from a second compliance audit of the codebase
against `.specs/team-enterprise-seat-billing.md`, building on the
first audit (`plans/billing-compliance.md`). Produced by merging an
automated audit with an independent code-level review, then verifying
every claim against the source.

## Status of First Audit

Of the 18 findings in `plans/billing-compliance.md`, 10 have been
fixed since that audit. The 8 remaining unfixed findings are carried
forward below where they overlap with new findings; the rest are noted
in the Resolved section at the end.

## Methodology

82 spec rules were examined. The independent review surfaced 14
findings; each was verified against source code before inclusion.
Severity ratings reflect the combined assessment after verification,
which differs from the reviewer's original rating in a few cases
(noted inline).

---

## Critical

### C1. Webhook seat events are not idempotent when Stripe omits the request-level idempotency key

**Spec rules:** Idempotency 1-4
**Carried from audit 1:** No (new finding)

The webhook dispatcher passes `event.request?.idempotency_key ??
undefined` to `handleSubscriptionEvent` (`stripe.ts:793`, `:836`).
For automatic Stripe processes (renewals, automatic cancellations,
trial conversions), `event.request` is `null`, so `undefined` is
passed. In `organization-seats.ts:219`, `idempotencyKey || undefined`
causes the DB column default `pg_catalog.gen_random_uuid()` to fire,
generating a fresh random UUID per insert
(`packages/db/src/schema.ts:1256`). On webhook redelivery of the same
event, a different random UUID is generated, bypassing
`onConflictDoNothing` and creating a duplicate purchase record. Seat
counts may be double-updated.

API-initiated operations (cancel, stop-cancel, update) are not
affected because they generate deterministic keys like
`sub-cancel-${randomUUID()}` synchronously.

**Action:** Use `event.request?.idempotency_key ?? event.id` for all
seat subscription webhook events. The Stripe `event.id` is stable
across redeliveries. Add replay tests for `created`, `updated`, and
`deleted` events to verify deduplication.

---

### C2. Hard-expired trials do not block the majority of org-scoped mutations

**Spec rules:** Free Trial 7-8
**Carried from audit 1:** Yes (finding #2, not yet fixed)

The three shared procedures in `utils.ts` are:
- `organizationMemberProcedure` -- no trial check
- `organizationBillingProcedure` -- no trial check
- `organizationBillingMutationProcedure` -- has trial check but is
  **never used by any router**

Only ~15 of ~75 org-scoped mutation endpoints call
`requireActiveSubscriptionOrTrial`, either manually inline or via a
procedure that includes it. The remaining ~60 endpoints rely solely on
membership/role checks. Confirmed unguarded routers include:

| Router | Unguarded mutations |
|--------|---------------------|
| `organization-app-builder-router` | 12 (all) |
| `organization-deployments-router` | 10 (all) |
| `organization-cloud-agent-router` | 6 (all) |
| `organization-cloud-agent-next-router` | 7 (all) |
| `organization-security-agent-router` | 6 (all) |
| `organization-auto-top-up-router` | 4 (all) |
| `organization-auto-fix-router` | 4 (all) |
| `organization-auto-triage-router` | 4 (all) |
| `organization-code-reviews-router` | 2 (all) |
| `slack-router` | 4 (all) |
| API routes (`user-tokens`, `cloud-agent/prepare`) | 2 |

Additionally, subscription-router endpoints `getCustomerPortalUrl`
and `cancelBillingCycleChange` are unguarded, though
`getSubscriptionStripeUrl` is arguably correct to omit the check
(users must be able to upgrade when hard-expired).

**Action:** Centralize hard-expired enforcement in a single
org-mutation base procedure. Require every org-scoped mutation to use
it, with an explicit allowlist for checkout/resubscribe/admin
escape hatches. Delete or repurpose the unused
`organizationBillingMutationProcedure`.

---

## High

### H1. Duplicate seat subscriptions can be created via concurrent or stale checkout sessions

**Spec rules:** Seat Purchase and Checkout 6
**Carried from audit 1:** No (new finding)

The non-ended subscription check happens only at checkout URL
generation time (`organization-subscription-router.ts:148`).
`checkout.session.completed` is a no-op (`stripe.ts:614`), and
`customer.subscription.created` unconditionally processes the event
without checking whether the org already has a subscription. Two
browser tabs opened before either completes checkout would both pass
the Stripe subscription check, and both completions would be accepted
-- creating two active Stripe subscriptions billed to the same
customer, with separate local purchase records.

**Action:** Add a completion-time guard. Options include:
- Reject or auto-cancel duplicate seat subscriptions in the
  `customer.subscription.created` webhook handler by checking for
  existing non-ended subscriptions for the org.
- Persist a pending-checkout hold keyed by org ID and invalidate
  older sessions once one succeeds.
- Use Stripe checkout session metadata to track which org the
  session belongs to and enforce at-most-one at completion.

---

### H2. Removed metadata users are re-added as owners on subscription events

**Spec rules:** Subscription Lifecycle 1-2
**Carried from audit 1:** Yes (finding #4, acknowledged NYI in spec)

Member removal at `organizations.ts:240` is a hard `DELETE`. When a
subsequent subscription event fires, `addUserToOrganization` at
`organization-seats.ts:193` succeeds because there is no conflict
row, re-adding the user as `owner`. There is no tombstone,
`removed_at` column, or any mechanism to distinguish "never a member"
from "was removed."

**Action:** Add a removal record (either a `removed_at` timestamp on
the membership row using soft-delete, or a separate
`organization_membership_removals` table). Check for prior removal
before calling `addUserToOrganization` in
`handleSubscriptionEventInternal`. The spec explicitly requires this
(Lifecycle rule 2) and documents it as NYI.

---

### H3. Stripe customer creation race creates orphaned external customers

**Spec rules:** Payment Processor Customer Management 1-3
**Carried from audit 1:** No (new finding -- first audit rated this
area as compliant, but the review correctly identified the external
side-effect gap)

`getOrCreateStripeCustomerIdForOrganization`
(`organization-billing.ts:17`) calls Stripe to create a customer
before the conditional DB update. In a race, both processes create
Stripe customers, but only one wins the `isNull(stripe_customer_id)`
WHERE clause. The loser throws at line 48 but does not clean up the
orphaned Stripe customer. The DB is protected; the external state is
not.

**Action:** Serialize customer creation per org before the Stripe
call, using `pg_advisory_xact_lock(organizationId)` or equivalent.
Alternatively, add cleanup logic that deletes the orphaned Stripe
customer when the conditional DB update fails.

---

### H4. Mid-subscription seat modifications are not serialized

**Spec rules:** Seat Count Modification 8
**Carried from audit 1:** Yes (finding #5, serialization half)

`handleUpdateSeatCount` (`stripe.ts:1313`) generates a fresh
`randomUUID()` per call and has no mutex, advisory lock, or
`SELECT ... FOR UPDATE`. Two concurrent requests can both read the
same seat state, both pass validation, and issue conflicting Stripe
mutations.

**Action:** Add `pg_advisory_xact_lock` keyed on subscription ID (or
organization ID) around the entire read-validate-update flow in
`handleUpdateSeatCount`.

---

### H5. Resubscribe flow is unreachable and non-compliant

**Spec rules:** Seat Purchase and Checkout 8, Subscription Lifecycle 6
**Carried from audit 1:** Yes (finding #10, expanded)

The `get` endpoint returns `subscription: null` for ended
subscriptions (`organization-subscription-router.ts:84`), making the
`SubscriptionOverviewCard` Resubscribe button unreachable. The
fallback `UpgradeTrialDialog` defaults `billingCycle` to `'annual'`
(line 59) and seat count to current `usedSeats` (line 74) instead of
the ended subscription's paid-seat quantity and billing cycle.
`getMostRecentEndedSeatPurchase` is dead code with zero callers.

**Action:** Add a backend resubscribe path that:
1. Looks up the most recently ended subscription by termination
   timestamp (fix ordering from `created_at` to ended timestamp).
2. Derives paid-seat quantity (excluding free-seat line items) and
   billing cycle from the ended purchase record.
3. Returns this data to the frontend for the checkout dialog.
4. Delete or integrate the dead `getMostRecentEndedSeatPurchase`
   function.

---

### H6. Teams-plan orgs have enterprise-only model restrictions enforced in some runtime paths

**Spec rules:** Organization Plans 8-9
**Carried from audit 1:** No (new finding -- first audit rated the
settings-router gating as sufficient, but the review found ungated
paths)

The settings router correctly gates deny-list enforcement behind
`plan === 'enterprise'`, but four other code paths apply
`model_deny_list` / `provider_deny_list` without checking the org
plan:

| File | Line | Context |
|------|------|---------|
| `api/organizations/[id]/defaults/route.ts` | 30 | Org defaults API |
| `lib/integrations/slack-service.ts` | 477 | Slack model selection |
| `lib/slack-bot/model-allow-list.ts` | 18 | Slack bot allow-list |
| `lib/integrations/discord-service.ts` | 363 | Discord model selection |

When an org is downgraded from Enterprise to Teams, the deny lists
remain in settings (correct per spec) but continue to be enforced by
these paths (incorrect per spec).

**Action:** Extract a shared helper (e.g.,
`getEffectiveModelRestrictions(org)`) that returns empty deny lists
for non-enterprise plans. Use it in all four locations.

---

### H7. Subscribed orgs can be treated as hard-locked during login redirect

**Spec rules:** Free Trial 8-10, Require-Seats 1
**Carried from audit 1:** Yes (finding #3 -- now more precisely
scoped)
**Reviewer severity:** High; **adjusted to:** Medium-High

`isOrganizationHardLocked` (`trial-utils.ts:71`) checks
`oss_sponsorship_tier`, `suppress_trial_messaging`, and
`require_seats` -- but does not check subscription/purchase state. A
comment at line 65 documents this as intentional to avoid DB queries.
`getProfileRedirectPath` (`user.server.ts:889`) uses this function
for single-org users, so an org with `require_seats=true`, an active
subscription, and an expired `free_trial_end_at` would be incorrectly
redirected to `/profile`.

The invariant ("orgs with active subscriptions won't have expired
trials") is not enforced at any write path -- it relies on temporal
ordering (subscribe before trial expires), which breaks for
admin-created late conversions.

**Action:** Either:
- Make `isOrganizationHardLocked` query subscription state (accepting
  the extra DB read), or
- Stop using it for redirect decisions and instead use the same
  condition as `requireActiveSubscriptionOrTrial` (which does check
  subscription state), or
- Ensure the subscription purchase flow sets `free_trial_end_at` to a
  far-future date, making the invariant hold by construction.

---

## Medium

### M1. Billing-cycle change concurrency has no local serialization

**Spec rules:** Billing Cycle Changes 1
**Carried from audit 1:** Yes (finding #6, schedule creation half)

The `changeBillingCycle` handler checks for an existing schedule then
creates one with no lock between the two operations
(`organization-subscription-router.ts:323`). Stripe will reject
duplicate `from_subscription` schedule creation, but the resulting
error surfaces as an unhandled 500 rather than a clean user-facing
message.

**Action:** Add `pg_advisory_xact_lock` on the org/subscription ID
before the schedule existence check. Alternatively, catch the Stripe
duplicate-schedule error and return a clean `BAD_REQUEST` to the
client.

---

### M2. Seat-subscription metadata type and invoice classification heuristics are weaker than the spec intends

**Spec rules:** Subscription Lifecycle 9, Invoices 1
**Carried from audit 1:** Yes (findings #7 and #14 partially)

New checkout sessions write `type: 'stripe-checkout-seats'`
(`stripe.ts:1181`), while legacy subscriptions use
`'organization_seats'`. The webhook handler accepts both but there is
no canonical type. Invoice classification (`stripe.ts:527`) checks
line-item metadata and `KNOWN_SEAT_PRICE_IDS` but does not consult
subscription-level metadata. There is no operator alert when an
invoice is classified as `topup` for an org with an active seat
subscription (a SHOULD in the spec).

**Action:**
1. Normalize new seat subscriptions to a canonical `type: 'seats'`,
   keeping `'stripe-checkout-seats'` and `'organization_seats'` as
   backward-compatible aliases in the webhook handler.
2. Add `KNOWN_SEAT_PRICE_IDS` check to invoice classification (or
   consult subscription metadata) as a primary signal alongside
   line-item metadata.
3. Add a `sentryError` or warning when an invoice is classified as
   `topup` for a customer with an active seat subscription.

---

## Low

### L1. Net charged amount still unimplemented (SHOULD)

**Spec rules:** Seat Count Updates 11
**Spec status:** Documented as "Not yet implemented"

Purchase records store gross list price only. No action needed until
the Stripe API exposes a reliable net amount at event time. When
available, add a `net_amount_usd` column alongside `amount_usd`.

---

### L2. Two subscription UI mismatches

**Spec rules:** Seat Usage Counting 8, Seat Count Modification 6

1. `SubscriptionOverviewCard.tsx:197` reads
   `subscription.items.data[0]?.quantity` for the over-usage /
   next-cycle warning instead of summing across all paid seat items
   (the backend correctly uses `KNOWN_SEAT_PRICE_IDS` to identify the
   right item).
2. `SeatChangeModal.tsx:71` allows `count = 0` when
   `activeSeatCount === 0`, but the backend
   (`organization-subscription-router.ts:39`) requires
   `z.number().int().min(1)`.

**Action:**
1. Derive the warning quantity from the paid seat item identified by
   `KNOWN_SEAT_PRICE_IDS`, consistent with the backend.
2. Clamp the UI minimum to 1 in the `SeatChangeModal` validation.

---

### L3. Enterprise-to-Teams plan transition has no integration test

**Spec rules:** Organization Plans 8-9

Settings survive the Enterprise-to-Teams-to-Enterprise round-trip
because no code deletes them, and enforcement is gated by plan checks
at read time. This is functionally correct but implicit -- a future
developer could add cleanup logic on plan change without realizing it
violates the spec.

**Action:** Add an integration test that transitions
Enterprise-to-Teams-to-Enterprise and asserts deny lists are preserved
and re-enforced.

---

## Informational (Design Discussion)

### I1. Platform admins bypass subscription access control without org membership

**Spec rules:** Subscription Access Control 1-4
**Reviewer severity:** High; **adjusted to:** Informational

`ensureOrganizationAccess` (`utils.ts:21-23`) returns `'owner'` for
any `is_admin` user without querying `organization_memberships`. This
is a deliberate, consistent pattern for support/operations tooling.
The spec restricts billing operations to "org owners and billing
managers" but does not explicitly address platform admin privileges.

**Action:** No immediate code change required. If the team decides
admin bypass should be removed from billing operations, expose
needed break-glass actions through explicit admin-only routes.

---

## Findings Resolved Since Audit 1

The following findings from `plans/billing-compliance.md` have been
verified as fixed in the current codebase:

| Audit 1 # | Description | Status |
|------------|-------------|--------|
| 1 | Self-service org creation plan not atomic | Fixed: `createOrganization` now accepts `plan` param; router hardcodes `'enterprise'` |
| 3 | `requireActiveSubscriptionOrTrial` ignores OSS/suppress flags | Fixed: now checks `oss_sponsorship_tier` and `suppress_trial_messaging` |
| 7 | Unrecognized subscription metadata types not logged/discarded | Fixed: explicit type matching with `warnExceptInTest` for unknown types |
| 8 | Invalid `planType` rejects the entire event | Fixed: `planType` is now `z.string().optional()`, validated via `safeParse` separately |
| 9 | Checkout `billingCycle` optional with default annual | Fixed: `billingCycle` is now required in `SubscriptionRequestSchema` |
| 11 | Teams invitation zero-seat bypass, billing_manager blocked | Fixed: zero-seat special case removed; billing_manager bypass works correctly |
| 12 | `getUserOrganizationsWithSeats` counts bot users | Fixed: query now joins `kilocode_users` with `is_bot = false` filter |
| 13 | Org deletion allowed with active subscription | Fixed: admin delete checks `subscription_status !== 'ended'` |
| 15 | Email sends not wrapped in try/catch | Fixed: per-email try/catch with `captureException`; owner targeting filters to active members |
| 16 | Unrecognized recurring interval not logged | Fixed: `sentryError` call with subscription ID and raw interval |

---

## Findings Not Carried Forward

These audit-1 findings were not independently confirmed by the second
audit and are not carried forward:

| Audit 1 # | Description | Reason |
|------------|-------------|---------|
| 5 (mixed paid/free items in seat update) | `handleUpdateSeatCount` reads `items.data[0]` | The current `items.data[0]` approach works for subscriptions with a single paid item (the common case). The review did not flag this as a separate finding; the broader serialization issue is captured in H4. |
| 14 (invoice classification) | Classifier uses line-item metadata only | Subsumed into M2 which captures the same gap more precisely. |
| 17 (gross-only purchase amount) | SHOULD rule, acknowledged NYI | Carried forward as L1. |
| 18 (`require_seats` schema default is `false`) | Latent hardening risk | Still present but low priority. The `createOrganization` function explicitly sets `true`. |

---

## Priority Summary

| Priority | # | Action |
|----------|---|--------|
| Critical | C1 | Stable idempotency key for webhook events |
| Critical | C2 | Centralized hard-expired trial enforcement |
| High | H1 | Duplicate subscription prevention at completion time |
| High | H2 | Removed-user tombstone for membership |
| High | H3 | Serialize or clean up Stripe customer creation |
| High | H4 | Advisory lock for seat modifications |
| High | H5 | Backend resubscribe path with correct defaults |
| High | H6 | Shared enterprise-restriction helper |
| High | H7 | Subscription-aware redirect logic |
| Medium | M1 | Billing-cycle change serialization |
| Medium | M2 | Canonical seat type and invoice classification |
| Low | L1 | Net amount column (deferred) |
| Low | L2 | UI quantity and validation fixes |
| Low | L3 | Plan transition integration test |
| Info | I1 | Admin bypass design discussion |
