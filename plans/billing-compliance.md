# Team & Enterprise Seat Billing -- Compliance Audit

Combined audit of the codebase against
`.specs/team-enterprise-seat-billing.md`. Produced by merging two
independent audits, resolving disagreements against the source code, and
deduplicating. Each finding lists every auditor that flagged it
(**A** = human audit, **B** = automated audit) and the spec rules it
violates. Recommended actions appear inline.

## Methodology

88 rules across 16 spec sections were examined. Findings are ordered
by severity within three tiers: Critical, High, and Lower.

Where the two audits disagreed, the code was re-read and the more
accurate assessment was adopted. Specific corrections are noted in
the Resolution column of the disagreement table at the end.

---

## Critical

### 1. Self-service org creation does not enforce Enterprise trial at the backend, and the plan write is non-atomic

**Spec rules:** Organization Plans 2-4  
**Found by:** A, B

The public create schema accepts `plan` with a default of `teams`
(`src/lib/organizations/organization-types.ts:54`). The mutation inserts
via `createOrganization()` before any Enterprise update
(`src/routers/organizations/organization-router.ts:122`), and
`createOrganization()` itself inserts with no plan so the DB default
`'teams'` applies (`src/lib/organizations/organizations.ts:176`,
`packages/db/src/schema.ts:1116`). The mutation returns the pre-update
org row (`src/routers/organizations/organization-router.ts:177`).

**Recommended action:** Remove `plan` from the public self-service
schema (or hardcode `enterprise` in that route), add `plan` as a
parameter to `createOrganization()`, persist it in the initial insert
transaction, and return the refreshed row.

---

### 2. Hard-expired trial blocking is not centrally enforced; many organization mutations bypass it

**Spec rules:** Free Trial 8  
**Found by:** A

The shared org procedures only check membership/role
(`src/routers/organizations/utils.ts:100`, `:123`). The trial guard is
a separate opt-in helper (`src/lib/organizations/trial-middleware.ts:13`).
Representative unguarded mutations include org rename/domain updates
(`src/routers/organizations/organization-router.ts:180`, `:233`) and
auto-top-up configuration changes
(`src/routers/organizations/organization-auto-top-up-router.ts:41`).

**Recommended action:** Move hard-lock enforcement into a shared org
mutation procedure/middleware and explicitly exempt only the checkout
path.

---

### 3. Trial-entitlement logic is inconsistent across helpers; exempt or subscribed orgs can still be treated as locked

**Spec rules:** Free Trial 9-10, Require-Seats 1  
**Found by:** A

The server mutation guard `requireActiveSubscriptionOrTrial` ignores
`suppress_trial_messaging` and `oss_sponsorship_tier` and only checks
active purchase or `require_seats`
(`src/lib/organizations/trial-middleware.ts:21-27`), while those flags
exist independently in settings (`packages/db/src/schema-types.ts:207`,
`:210`) and can be toggled independently
(`src/components/organizations/OrganizationInfoCard.tsx:210`).
Separately, the login redirect uses `isOrganizationHardLocked()` without
checking subscription state (`src/lib/organizations/trial-utils.ts:61`),
and that helper explicitly does not check subscriptions
(`src/lib/organizations/trial-utils.ts:65`).

**Recommended action:** Replace the fragmented checks with one shared
entitlement evaluator used by mutations, redirects, and client trial UI.

---

### 4. Subscription-event lifecycle handling is not compliant

**Spec rules:** Subscription Lifecycle 1-2, Error Handling 9  
**Found by:** A, B

The handler unconditionally re-adds the metadata user as owner before
any org/user/removal check
(`src/lib/organizations/organization-seats.ts:145`), which violates the
"do not re-add removed users" rule (acknowledged as NYI in the spec) and
cannot satisfy the "missing user should log and continue" rule. It also
never calls `getOrganizationById()` before updating memberships and org
state, even though deleted orgs are filtered at read time
(`src/lib/organizations/organizations.ts:29`), so deleted-org events
can still mutate soft-deleted rows
(`src/lib/organizations/organization-seats.ts:154`).

**Recommended action:** Preflight the org and metadata user. Skip
membership creation when the user is missing. Reject deleted-org events
with a warning. Add a removed-membership tombstone (e.g. `removed_at`
column or separate table) so removed users are not re-added.

---

### 5. Mid-subscription seat changes are wrong for mixed paid/free subscriptions, and concurrent changes are not serialized

**Spec rules:** Seat Count Modification 8, applicable to 3-4  
**Found by:** A, B (B found serialization; A found both)

The updater reads and writes only `subscription.items.data[0]` and sets
that single line to the requested total
(`src/lib/stripe.ts:1278`, `:1291-1296`), while the router passes the
org's total seat count (paid + free) rather than the paid-seat quantity
(`src/routers/organizations/organization-subscription-router.ts:244`).
There is also no lock around same-subscription updates
(`src/lib/stripe.ts:1275` generates a random UUID per call).

**Recommended action:** Explicitly identify the paid seat item by known
price ID, preserve free-seat items, derive paid quantity as
`requestedTotal - freeSeats`, and serialize updates with a DB
lock/advisory mutex keyed by subscription or org.

---

### 6. Billing-cycle change and cancellation lifecycle is not hardened per spec

**Spec rules:** Billing Cycle Changes 1, 11; Subscription Lifecycle 4  
**Found by:** A, B

Duplicate schedules can still be created because the code checks for an
existing schedule then creates a new one without serialization
(`src/routers/organizations/organization-subscription-router.ts:323`,
`:370`). Cancellation of a pending billing-cycle change verifies only
"two phases" before releasing the schedule
(`src/routers/organizations/organization-subscription-router.ts:456`).
`cancel_at_period_end` does not release a pending schedule at all
(`src/lib/stripe.ts:1245`).

**Recommended action:** Serialize change requests. Stamp schedules with
explicit metadata (e.g. `{ origin: 'billing-cycle-change' }`) when
created. Verify that metadata before releasing. Release pending
cycle-change schedules as part of subscription cancellation.

---

## High

### 7. Subscription metadata type dispatch is not spec-compliant and lacks a canonical seat-subscription type

**Spec rules:** Subscription Lifecycle 9  
**Found by:** A, B

Webhooks treat every non-`kilo-pass` and non-`kiloclaw` subscription as
a seat subscription (`src/lib/stripe.ts:765-815`). Checkout writes
`type: 'stripe-checkout-seats'`
(`src/lib/stripe.ts:1152`), and tests synthesize
`type: 'organization_seats'`
(`src/lib/organizations/organization-subscription-event.test.ts:189`).
Unrecognized types are never explicitly logged or discarded.

**Recommended action:** Standardize on one recognized seat type, validate
it at dispatch, and log/discard unknown types.

---

### 8. Plan metadata handling on subscription events is wrong in two ways

**Spec rules:** Organization Plans 5-7  
**Found by:** A

`planType` is validated as part of `SubscriptionMetadataSchema`
(`src/lib/organizations/organization-seats.ts:46`) with
`OrganizationPlanSchema.optional()`. If `planType` is present but
invalid (e.g. `"standard"`), the entire `parse()` call at line 110
throws, rejecting the whole event -- the spec says invalid planType
should be silently ignored (logged and discarded), not reject the event.
Additionally, plan updates only occur in the active-subscription branch
(`src/lib/organizations/organization-seats.ts:236`), so
ended/incomplete/past_due events do not update org plan
(`organization-seats.ts:178`, `:193`).

Note: `getPlanTypeFromSubscription()` (`:82-103`) does handle invalid
values gracefully, but it is called too late -- the top-level parse
rejects the event first.

**Recommended action:** Parse `planType` as an optional/passthrough
string in the metadata schema, validate it separately with
`OrganizationPlanSchema.safeParse()`, and apply plan updates
independently of seat-count updates.

---

### 9. Checkout does not actually require billing-cycle selection, and the UI does not let the user choose seat quantity

**Spec rules:** Seat Purchase 1-2  
**Found by:** A

The mutation schema makes `billingCycle` optional with a default of
`'annual'`
(`src/routers/organizations/organization-subscription-router.ts:36`),
and the test suite explicitly asserts omission is accepted
(`src/routers/organizations/organization-subscription-router.test.ts:101`).
The button/dialog path always purchases `orgData.members.length`
(`src/components/organizations/subscription/CreateSubscriptionButton.tsx:30`,
`src/components/organizations/UpgradeTrialDialog.tsx:86-92`) and
provides no seat input control
(`src/components/organizations/UpgradeTrialDialog.tsx:123`). The default
also overcounts billing managers because it uses raw member count instead
of seat usage.

**Recommended action:** Make `billingCycle` required in the public route.
Add a 1-100 seat selector to the dialog. Initialize it from seat usage
rather than `members.length`.

---

### 10. Current/ended subscription selection uses wrong ordering and breaks resubscribe behavior

**Spec rules:** Seat Purchase 8, Subscription Lifecycle 6  
**Found by:** A, B (B found each half independently)

`getMostRecentSeatPurchase()` orders by `created_at`
(`src/lib/organizations/organization-seats.ts:58`), not by termination
timestamp. Cancel/stop-cancel/update/change-cycle/get all depend on it
(`src/routers/organizations/organization-subscription-router.ts:81`,
`:175`, `:291`). The subscription page hides ended subscriptions entirely
(`src/components/organizations/subscription/OrganizationSubscription.tsx:65`),
so the ended-subscription resubscribe logic in the overview card is
effectively unreachable
(`src/components/organizations/subscription/SubscriptionOverviewCard.tsx:150`).

The frontend resubscribe handler does correctly filter for paid items
and preserve billing cycle (`SubscriptionOverviewCard.tsx:154-168`), but
the backend defaults billingCycle to `'annual'`
(`organization-subscription-router.ts:36`) regardless, and the
subscribe path never looks up the previous subscription's billing cycle
or paid seat count.

**Recommended action:** Replace the generic selector with
purpose-specific queries. Add a dedicated resubscribe path that uses the
most recently ended subscription by termination timestamp, paid seats
only, and prior billing cycle.

---

### 11. Teams invitation UI is not spec-compliant

**Spec rules:** Seat Usage Counting 8  
**Found by:** A, B

The dialog treats `totalSeats === 0` as seat availability
(`src/components/organizations/members/InviteMemberDialog.tsx:114-116`,
expression `totalSeats === 0 || remainingSeats > 0 || isOrgEnterprise`),
so Teams orgs with zero seats can still invite. And once it determines
the org is full, it disables the whole form
(`InviteMemberDialog.tsx:208-222`), which incorrectly blocks
`billing_manager` invites that should not consume seats.

**Recommended action:** Remove the zero-seat special case for Teams and
apply capacity gating only to seat-consuming roles.

---

### 12. Seat-usage reporting is inconsistent because one query still counts bot users

**Spec rules:** Seat Usage Counting 5  
**Found by:** A

`getUserOrganizationsWithSeats()` counts memberships without
joining/filtering `kilocode_users.is_bot`
(`src/lib/organizations/organizations.ts:61-72`), while
`getOrganizationMembers()` explicitly filters bots out
(`src/lib/organizations/organizations.ts:397`).

**Recommended action:** Join `kilocode_users` in the former query and
exclude bots so all seat-usage surfaces agree.

---

### 13. Organization deletion is allowed while a non-ended subscription exists

**Spec rules:** Subscription Lifecycle 10  
**Found by:** A, B  
**Spec status:** Documented as "Not yet implemented"

The admin delete route checks only existence and soft-deletes
(`src/routers/organizations/organization-admin-router.ts:516`), and the
underlying delete helper only sets `deleted_at`
(`src/lib/organizations/organizations.ts:588`).

**Recommended action:** Block deletion until the org's subscription is
canceled and has reached an ended state.

---

### 14. Invoice classification is too weak and likely misclassifies seat invoices as top-ups

**Spec rules:** Invoices 1  
**Found by:** A, B

The classifier only checks whether any line item has
`metadata.seats` (`src/lib/stripe.ts:527-531`), but seat checkout only
sets subscription-level metadata and known paid seat price IDs
(`src/lib/stripe.ts:1151`). There is also no operator alert for
suspicious "topup" classifications on orgs with active seat
subscriptions.

**Recommended action:** Classify by known paid seat price IDs and/or
canonical subscription type, and add the alerting path the spec calls
for.

---

### 15. Email notification handling does not meet the non-blocking/error-reporting requirement, and owner targeting is loose

**Spec rules:** Email Notifications 5  
**Found by:** A, B

Renewal/cancellation/subscription emails are awaited inside `after()`
with no per-email try/catch
(`src/lib/organizations/organization-seats.ts:277`, `:305`, `:331`).
Failures propagate as unhandled exceptions with no Sentry logging.
Additionally, owner emails are derived from `getOrganizationMembers()`
and filtered only by `role === 'owner'`
(`src/lib/organizations/organization-seats.ts:271-274`), which includes
pending invited owners because invitations are part of that list
(`src/lib/organizations/organizations.ts:400`).

**Recommended action:** Send only to active (non-invitation) owners and
wrap each send in try/catch with error tracking so failures are reported
but do not affect the main operation.

---

### 16. Unrecognized recurring intervals silently default to monthly without logging a warning

**Spec rules:** Seat Count Updates 12  
**Found by:** A, B

The fallback to `'monthly'` is present
(`src/lib/organizations/organization-seats.ts:142`), but there is no
warning emission.

**Recommended action:** Keep the monthly fallback and add a structured
warning/capture with the subscription ID and raw interval.

---

## Lower Severity

### 17. Purchase rows still store only the gross list price, not the post-discount net amount

**Spec rules:** Seat Count Updates 11 (SHOULD)  
**Found by:** A, B  
**Spec status:** Documented as "Not yet implemented"

Amount is computed as `unit_amount * quantity` across line items
(`src/lib/organizations/organization-seats.ts:126-131`) and written
directly to the purchase row (`:161`).

**Recommended action:** When Stripe exposes a reliable net amount at
event time, store it alongside or instead of the gross amount.

---

### 18. `require_seats` schema default is `false`, which is a latent hardening risk

**Spec rules:** Require-Seats 2 (defense-in-depth)  
**Found by:** B

`createOrganization()` correctly sets `require_seats: true`
(`src/lib/organizations/organizations.ts:192`), but the schema default
is `false` (`packages/db/src/schema.ts:1112`). Any code path that
inserts an org without explicitly setting this field would bypass the
spec requirement. The current self-service creation path is compliant;
this is a fail-open default worth hardening rather than a blocking
compliance gap.

**Recommended action:** Consider changing the schema default to `true`
and generating a migration so future insert paths fail safe.

---

## Tests That Reinforce Non-Compliant Behavior

These tests explicitly assert current behavior that conflicts with the
spec. They will need to be updated when the corresponding fixes are
applied:

- Re-adding the metadata user as owner is explicitly asserted:
  `src/lib/organizations/organization-subscription-event.test.ts:189`
- Omitting `billingCycle` and defaulting to annual is explicitly
  asserted:
  `src/routers/organizations/organization-subscription-router.test.ts:101`
- Choosing the "latest" purchase by `created_at` is explicitly asserted:
  `src/lib/organizations/organization-seats.test.ts:692`

## Missing Test Coverage

No coverage was found for:

- Deleted-org webhook events
- Missing/unresolvable metadata user IDs
- Invalid `planType` being logged and ignored (instead of rejecting the
  whole event)
- Hard-lock exemptions via `suppress_trial_messaging` or
  `oss_sponsorship_tier` in the server mutation guard
- Mixed paid/free seat updates on mid-subscription modifications
- Billing-cycle schedule concurrency and identity checks
- Bot-user exclusion from seat usage in
  `getUserOrganizationsWithSeats()`
- Multiple line items in a single subscription event

---

## Areas Checked and Not Flagged

The following narrower areas were examined by one or both audits and
were not independently flagged beyond the findings above:

- Price constants and annual = 10x monthly relationship
  (`src/lib/organizations/constants.ts`)
- Stripe customer creation and race-condition handling
  (`src/lib/organizations/organization-billing.ts:17-51`)
- `getOrganizationSeatUsage()` core counting logic (member + invitation
  counting, billing_manager exclusion, expired/accepted invitation
  handling)
- Enterprise-settings persistence, enforcement gating, and UI hiding
  across plan changes (`src/lib/llm-proxy-helpers.ts:317-335`,
  `OrganizationProvidersAndModelsPage.tsx:415-428`)
- Owner/billing-manager authorization on subscription endpoints
  (`src/routers/organizations/organization-subscription-router.ts` --
  all mutations use `organizationBillingProcedure`)
- Subscription access control (non-member rejection, role-based errors)
- Idempotency key: unique constraint, auto-generate, conflict-do-nothing
  (`packages/db/src/schema.ts:1267`,
  `src/lib/organizations/organization-seats.ts:166-176`)
- Seat count computation from purchase records (max of most-recent
  start-date group)
- Transaction atomicity around purchase + seat-count update
- Cancel at period end (`cancel_at_period_end: true`)
- Stop cancellation (`cancel_at_period_end: false`)
- Billing address collection (`billing_address_collection: 'required'`)
- 3D Secure / payment authentication challenge handling
- Seat count validation: positive integer, no upper limit for
  mid-subscription, 1-100 for initial checkout
- Proration behavior: `'always_invoice'` for increases, `'none'` for
  decreases
- Billing cycle change: two-phase schedule, no proration, discount and
  line-item preservation, orphan schedule cleanup on phase-update failure
- Free trial computation: `Math.floor`, progressive trial stages, banner
  styling, soft-expired dismissible dialog, hard-expired non-dismissible
  dialog with only upgrade/profile options
- Soft-expired is UI-only (server does not block mutations for
  soft-expired)
- Require-seats flag: `true` on creation, admin toggle, status
  classification (active vs incomplete)
- OSS sponsorship / suppress_trial_messaging flags are present in org
  settings and are consulted by `isOrganizationHardLocked()`; the
  broader subscription-aware entitlement inconsistency is captured in
  Finding #3
- Payment processor customer metadata includes organization ID

---

## Disagreements Between Audits and Resolution

| Area | Audit A | Audit B | Resolution |
|------|---------|---------|------------|
| Org Plans Rule 7 (invalid planType) | NON-COMPLIANT: top-level parse rejects the whole event | COMPLIANT: `getPlanTypeFromSubscription` handles it | **A is correct.** `SubscriptionMetadataSchema.parse()` fires first (`:110`) and throws on invalid planType before `getPlanTypeFromSubscription()` is reached. |
| Free Trial Rule 8 (server mutation blocking) | NON-COMPLIANT: opt-in guard, many unguarded mutations | COMPLIANT: guard exists and works where called | **A is correct.** The guard exists but is not called by org rename, domain update, auto-top-up toggle, and other mutation endpoints. |
| Free Trial Rules 9-10 (OSS/suppress exemptions in mutation guard) | NON-COMPLIANT: `requireActiveSubscriptionOrTrial` does not check these flags | COMPLIANT: `isOrganizationHardLocked` checks them | **A is correct.** `isOrganizationHardLocked` is the login-redirect helper. The server mutation guard (`requireActiveSubscriptionOrTrial`) at `:21-27` only checks `hasActiveSubscription \|\| !require_seats`. |
| Seat Mod (mixed paid/free items) | NON-COMPLIANT: `items.data[0]` only | COMPLIANT: all rules 1-7 pass | **A is correct.** `handleUpdateSeatCount` reads only `items.data[0]` (`:1278`) and sets the total on it. For subscriptions with free-seat line items this modifies the wrong item or clobbers free seats. |
| Seat Usage Rule 5 (bot exclusion) | NON-COMPLIANT: `getUserOrganizationsWithSeats` counts bots | COMPLIANT: bots excluded | **A is correct.** `getUserOrganizationsWithSeats` (`:61-72`) counts from `organization_memberships` without joining `kilocode_users.is_bot`. |
| Seat Usage Rule 11 (owner over-usage warning) | Not flagged; warning already exists in the seat-usage UI | NON-COMPLIANT: no warning displayed | **B was incorrect.** `SeatsUsageProgress.tsx` renders an over-limit warning when `used > total`, and `SeatUsageCard.tsx` uses that component. The finding was removed. |
| Require-Seats Rule 2 (schema default) | Not flagged | LOWER-SEVERITY hardening note: schema default is `false` | **Retained as a latent-risk note.** The current creation path explicitly sets `require_seats: true`, but the DB default is still fail-open for future insert paths. |
| Subscription Lifecycle Rule 9 (metadata type dispatch) | Both flagged | B rated as MEDIUM | **Upgraded to High** per A's analysis: unrecognized types silently enter the seat handler rather than being discarded. |
| Seat Purchase Rules 8 / Lifecycle 6 (resubscribe) | Both flagged | B treated as two separate HIGH issues | **Merged as #10** with A's finding that the UI resubscribe path is unreachable, making both server and client non-compliant. |
