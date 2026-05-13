# KiloClaw price increase implementation plan

## Goal

Move KiloClaw to the new Standard/Commit pricing for new subscription lineages while preserving legacy pricing for existing live subscription lineages. Keep scope focused on pricing, trial duration, Stripe/credit settlement, Kilo Pass sufficiency, and default instance size. Do not implement future tiered plan/instance-size selection.

## Final decisions

### Pricing

- Keep exactly two user-facing plans for now: `standard` and `commit`.
- Legacy pricing:
  - Standard: `$9/month`.
  - Standard first paid month: `$4` only for eligible live pre-rollout lineages with no prior paid KiloClaw subscription.
  - Commit: `$48` for 6 months.
  - Personal trial: 7 days.
  - Default/max self-service instance type: `shared-2-3` for legacy lineages.
- New/current pricing:
  - Standard: `$55/month` from the first paid month; no Standard first-month discount.
  - Commit: `$51/month`, billed upfront as `$306` for a 6-month commit.
  - Personal trial: 1 day.
  - Default/max self-service instance type: `perf-1-3`.
- Larger machine/tiered pricing is explicitly out of scope for this change.

### Legacy pricing / grandfathering

- Legacy pricing is subscription-lineage scoped, not account-scoped.
- A live legacy lineage keeps legacy pricing through:
  - normal renewal,
  - pending cancellation,
  - reactivation before final cancellation,
  - Standard ↔ Commit switches,
  - live reprovision/successor subscription transfer.
- A user loses live legacy carry-forward once the subscription reaches `canceled`.
- If the user fully ends the subscription and later rejoins, create a fresh subscription row with the then-current price version and `perf-1-3` rules.
- Existing running instances are not actively resized during rollout. The `shared-2-3` restriction is forward-only for future legacy provisioning/reprovisioning/self-service sizing.

### Migration/backfill

- Add one required field to `kiloclaw_subscriptions`:
  - `kiloclaw_price_version text not null`.
- Do not add `kiloclaw_grandfathered_at` or `kiloclaw_grandfathered_to`.
- `kiloclaw_price_version` is the durable subscription price anchor and maps to an append-only code catalog keyed by `YYYY-MM-DD` date strings.
- Existing rows at migration execution time, including canceled history, get the legacy catalog date key because all existing subscriptions were created under legacy pricing.
- Only live non-canceled lineages can carry the legacy version forward into successor rows.
- New rows after rollout use the new/current catalog date key.
- `kiloclaw_price_version` is immutable within a subscription lineage:
  - plan switches preserve it,
  - successor rows copy it,
  - historical canceled rows keep it,
  - fresh re-enrollment gets the current catalog date key.

### Stripe

- Stripe config must separate:
  - new checkout price IDs, and
  - legacy recognized price IDs for invoice settlement, plan detection, and legacy intro schedule repair.
- Existing legacy Stripe subscriptions remain on legacy Stripe prices.
- New non-legacy checkout uses new Stripe prices:
  - Standard recurring `$55`, used from the first paid month,
  - Commit `$306` / 6 months.
- Invoice settlement must recognize legacy and new price IDs, including legacy/retired intro IDs where they can still appear on pre-rollout lineages.
- Schedule repair must map recognized intro prices to the same version's standard recurring price; it must not repair old intro schedules onto new standard pricing, and fresh current checkout must not use a current intro price.

### First paid Standard discount

- New non-legacy users do not receive a Standard first-month discount; first paid Standard enrollment charges `$55`.
- Trial-only history only matters inside an eligible live pre-rollout lineage; it does not create discount eligibility for fresh current subscriptions.
- Legacy/pre-rollout trial users converting after rollout get legacy `$4` first paid Standard month when eligible, then `$9/month`.
- Commit has no intro discount in either price version.

### Trial lifecycle

- Existing pre-rollout trial rows keep their recorded `trial_ends_at`; do not shorten active trials.
- New post-rollout trial rows last 1 day.
- Trial warnings and inactivity are price-version aware:
  - legacy 7-day trials keep current 2-day/1-day warnings and 48-hour inactivity-stop behavior,
  - new 1-day trials send only the urgent “expires tomorrow” warning,
  - new 1-day trials skip 48-hour inactivity stop because expiry occurs first.

### Kilo Pass

- Kilo Pass upsell eligibility and auto-activation must use the effective KiloClaw charge for the subscription’s price version.
- Legacy thresholds:
  - Standard intro `$4` when eligible, regular `$9`, Commit `$48`.
- New thresholds:
  - Standard `$55` from the first paid month, Commit `$306`.
- Auto-activation must only proceed when effective credits can cover the selected first KiloClaw charge.

### Premortem hardening decisions

Incorporate only changes that reduce correctness or operational rollout risk:

- Add a canonical price-version state matrix before implementation and use it as the backbone for tests.
- Treat `kiloclaw_price_version` as an entitlement invariant, not mutable metadata. Writes should be centralized or explicitly reviewed.
- Inventory every subscription insert/upsert before adding the non-null column; every writer must set the price version deliberately.
- Resolve the provisioning service boundary before changing instance defaults/caps. The platform must not independently default to `perf-1-3` when the intended price version is unknown.
- Add rollout audit checks for backfill correctness, mismatched Stripe price families, legacy carry-forward, and remaining hard-coded billing constants.
- Do not broaden the catalog into future tiered pricing or generalized machine-size selection.

Do not add low-value process bulk: avoid broad speculative architecture, exhaustive future-tier abstractions, or extra specs unless they govern a changed business rule.

## Design

### 1. Add append-only pricing catalog

Create a shared KiloClaw pricing catalog used by web and billing worker code.

Suggested shape:

```ts
type KiloClawPriceVersion = string; // YYYY-MM-DD date key

type KiloClawPricingCatalogEntry = {
  version: KiloClawPriceVersion;
  label: string;
  standardMonthlyMicrodollars: number;
  standardIntroMicrodollars: number | null;
  commitPeriodMicrodollars: number;
  commitPeriodMonths: 6;
  trialDurationDays: number;
  defaultInstanceType: InstanceTierKey;
  maxSelfServiceInstanceType: InstanceTierKey;
  stripe: {
    standardPriceIdEnv: string;
    standardIntroPriceIdEnv?: string;
    commitPriceIdEnv: string;
  };
};
```

Initial entries:

- Legacy catalog date key: fixed historical/effective date chosen before implementation.
  - `$4` intro when eligible, `$9` standard, `$48` commit, 7-day trial, `shared-2-3`.
- New rollout catalog date key: fixed rollout effective date chosen before implementation.
  - No Standard intro, `$55` standard from first paid month, `$306` commit, 1-day trial, `perf-1-3`.

Catalog rules:

- Append-only while any subscription row references an entry.
- No deleting or reinterpreting old version date keys.
- Runtime must fail closed if a subscription references an unknown version.
- Current/new version should be a single exported constant used when creating fresh rows.
- Price lookup should take `kiloclaw_price_version` and plan, not use global plan constants.

Candidate locations:

- Shared package if both Next.js and Worker services need it directly.
- Otherwise duplicate-safe shared module already imported by both app and service code.

Likely consumers:

- `apps/web/src/lib/kiloclaw/credit-billing.ts`
- `services/kiloclaw-billing/src/lifecycle.ts`
- `apps/web/src/lib/kiloclaw/stripe-price-ids.server.ts`
- `apps/web/src/lib/kiloclaw/stripe-handlers.ts`
- `apps/web/src/routers/kiloclaw-router.ts`
- KiloClaw billing UI type/display modules.

### 2. Add `kiloclaw_price_version` to subscriptions

Schema change:

- Update `packages/db/src/schema.ts`:
  - add `kiloclaw_price_version: text().notNull().$type<KiloClawPriceVersion>()` to `kiloclaw_subscriptions`.
  - add index if useful for support/backfill queries, e.g. `IDX_kiloclaw_subscriptions_price_version`.

Migration:

- Generate DDL with `pnpm drizzle generate`; do not hand-write generated schema SQL.
- Append backfill SQL after generated DDL using `--> statement-breakpoint` if needed.
- Backfill all existing `kiloclaw_subscriptions` rows to the legacy catalog date key.
- Ensure new inserts after rollout must provide a non-null current/legacy version.

Backfill semantics:

- All existing rows, including `canceled`, get legacy version for historical accuracy.
- Runtime, not the historical row value alone, controls live carry-forward:
  - live non-canceled lineages can copy legacy version to successor rows,
  - canceled rows are historical and must not seed new enrollment.

### 3. Thread price version through subscription creation

Update all subscription creation/upsert paths to set `kiloclaw_price_version`.

Fresh subscription rows:

- Default to current/new catalog date key.
- Use current catalog trial duration and default instance type.

Successor rows during live reprovision:

- Copy predecessor `kiloclaw_price_version` only when the predecessor is the current live row and grants access under existing reprovision-transfer rules.
- Do not copy from canceled rows into fresh re-enrollment.

Important file:

- `services/kiloclaw-billing/src/provision-bootstrap-shared.ts`

Expected behavior:

- Existing live legacy user reprovisions before cancellation completes → successor remains legacy and uses `shared-2-3` cap.
- User with canceled legacy history reprovisions/re-enrolls later → new row uses current version and `perf-1-3`.

Writer inventory requirement:

- Before landing the non-null schema migration, enumerate every production and operational path that inserts or upserts `kiloclaw_subscriptions`.
- Each writer must either set the current version for a fresh row or copy the predecessor version for a live successor row.
- Any writer that cannot determine the correct price version must fail closed rather than relying on a database default or nullable fallback.

### 4. Replace hard-coded credit prices with catalog lookups

Current hard-coded prices include:

- `apps/web/src/lib/kiloclaw/credit-billing.ts`
- `services/kiloclaw-billing/src/lifecycle.ts`
- `apps/web/src/app/(app)/claw/components/billing/billing-types.ts`

Update logic to:

- Resolve subscription price version.
- Determine effective plan and whether the lineage is eligible for the preserved pre-rollout Standard intro.
- Use catalog microdollar amounts for:
  - credit enrollment,
  - pure-credit renewal,
  - plan switch renewal boundary,
  - balance sufficiency checks,
  - Kilo Pass auto-activation,
  - UI renewal cost display,
  - affiliate/Impact sale amounts for credit-funded payments.

Rules:

- Stripe-funded settlement keeps using actual invoice amount for ledger settlement.
- Pure-credit billing uses catalog amount for the row’s `kiloclaw_price_version`.
- First paid Standard intro uses catalog intro amount only for eligible pre-rollout lineages; current Standard uses recurring amount from the first paid period.
- Commit charge uses catalog six-month upfront amount.

### 5. Stripe price ID handling

Update Stripe price ID mapping to support both current checkout IDs and legacy recognized IDs.

Current impacted files:

- `apps/web/src/lib/kiloclaw/stripe-price-ids.server.ts`
- `apps/web/src/lib/kiloclaw/stripe-handlers.ts`
- `services/kiloclaw-billing/src/lifecycle.ts`
- `apps/web/src/app/api/internal/kiloclaw/billing-side-effects/route.ts`
- `apps/web/src/routers/kiloclaw-router.ts`

Implementation requirements:

- New checkout must choose Stripe price IDs from the subscription’s intended/current catalog entry.
- Existing legacy subscriptions must continue to settle invoices from legacy price IDs.
- Plan detection must map each recognized price ID to:
  - catalog version,
  - plan,
  - whether it is Standard intro vs Standard recurring for recognized legacy/retired intro prices.
- Schedule repair must be version-aware:
  - recognized intro price schedules repair to the same version's standard recurring price,
  - fresh current schedules must not be created from a current intro price.
- `subscriptionSchedules.create({ from_subscription })` must not set metadata in the same call; set custom metadata in the subsequent update call.

Env/config work:

- Add new env var names for new Standard recurring and Commit price IDs.
- Retain legacy env vars or add explicit legacy env vars for old Standard intro, Standard recurring, and Commit price IDs.
- Update examples:
  - `.env.local.example`
  - `services/kiloclaw-billing/.dev.vars.example`
  - `services/kiloclaw-billing/wrangler.jsonc`
- Clean up stale `STRIPE_KILOCLAW_STANDARD_FIRST_MONTH_COUPON_ID` example. Do not require a current Standard intro price ID for fresh checkout.

### 6. Checkout and credit enrollment

Update `apps/web/src/routers/kiloclaw-router.ts` and credit enrollment helpers.

Checkout rules:

- If the user has an existing live subscription lineage, use that row’s `kiloclaw_price_version`.
- If creating a fresh subscription after canceled history, use current/new catalog date key.
- Reject duplicate active/past-due/unpaid subscriptions as today.
- Allow checkout from trialing/canceled as today, but pricing differs:
  - trialing legacy lineage converts with legacy version,
  - canceled history starts fresh with current version.

Credit enrollment rules:

- Use catalog amount for balance check and deduction.
- First paid Standard discount eligibility is preserved only for eligible live pre-rollout lineages; trial-only history only preserves eligibility inside that lineage.
- Fresh current Standard enrollment has no discount and uses the recurring amount from the first paid period.

### 7. Instance type default/cap behavior

Current catalog default is `perf-1-3`; legacy target is `shared-2-3`.

Update provisioning logic so the intended/current subscription price version controls default instance type:

- Current/new version → `perf-1-3`.
- Legacy version → `shared-2-3` for future provisioning/reprovisioning where self-service/default sizing is applied.

Impacted files:

- `services/kiloclaw/src/routes/platform.ts`
- `services/kiloclaw/src/durable-objects/kiloclaw-instance/index.ts`
- `packages/kiloclaw-instance-tiers/src/catalog.ts` only if tests/labels need clarification; do not remove legacy tiers.
- `services/kiloclaw-billing/src/provision-bootstrap-shared.ts` for deciding copied/current price version.

Rules:

- Do not actively resize existing running instances during rollout.
- Do not allow self-service grandfathered/legacy provisioning to get `perf-1-3` by default after rollout.
- Admin overrides remain admin-only and outside normal self-service cap behavior.

Service-boundary requirement:

- Resolve the service boundary before implementing instance entitlement changes.
- Either billing bootstrap must pass/return the intended price-version-derived instance type before DO provisioning, or the platform provisioning service must query a canonical billing entitlement source before choosing size.
- If the intended price version or entitlement is unavailable, provisioning must fail closed or continue with the lower legacy entitlement; it must not silently default to `perf-1-3`.
- Keep cross-service coupling minimal, but do not defer this decision until after provisioning code is changed.

### 8. Trial creation, warnings, and inactivity

Trial creation:

- Replace `PERSONAL_TRIAL_DURATION_DAYS = 7` and related constants with catalog lookup.
- New fresh rows use current catalog trial duration: 1 day.
- Existing trial rows keep recorded `trial_ends_at`.

Impacted files:

- `services/kiloclaw-billing/src/provision-bootstrap-shared.ts`
- `apps/web/src/lib/kiloclaw/constants.ts`
- `apps/web/src/scripts/db/kiloclaw-subscription-alignment.ts`
- `services/kiloclaw-billing/src/lifecycle.ts`

Warnings:

- For 7-day legacy trials, keep existing 2-day / 1-day warning behavior.
- For 1-day current trials, send only urgent “expires tomorrow” warning.
- Avoid immediate 2-day warning for 1-day trials.

Inactivity stop:

- For 7-day legacy trials, keep 48-hour inactivity stop.
- For 1-day current trials, skip inactivity stop.

### 9. Kilo Pass upsell changes

Impacted files:

- `apps/web/src/lib/kilo-pass/bonus.ts`
- `apps/web/src/routers/kiloclaw-router.ts`
- `apps/web/src/app/(app)/claw/components/billing/WelcomePage.tsx`
- `apps/web/src/app/(app)/claw/components/billing/PlanSelectionDialog.tsx`

Required behavior:

- Eligibility must use selected KiloClaw plan and price version amount.
- Monthly Kilo Pass tier must cover the first KiloClaw charge unless effective balance/bonus logic makes it sufficient.
- Annual policy should be reviewed against the new `$306` Commit charge; do not assume all annual tiers qualify unless effective credits cover the charge.
- UI should communicate when a selected Kilo Pass tier cannot auto-activate selected KiloClaw plan.

### 10. UI/display updates

Before editing UI under `apps/web`, read `design.md` and `.agents/skills/kilo-design/SKILL.md`.

Update price display to derive from catalog/version instead of constants:

- Billing selection surfaces:
  - `apps/web/src/app/(app)/claw/components/billing/WelcomePage.tsx`
  - `apps/web/src/app/(app)/claw/components/billing/PlanSelectionDialog.tsx`
  - `apps/web/src/app/(app)/claw/components/billing/SubscriptionCard.tsx`
- Subscription center:
  - `apps/web/src/components/subscriptions/kiloclaw/KiloClawSubscribeCard.tsx`
  - `apps/web/src/components/subscriptions/kiloclaw/KiloClawDetail.tsx`
  - `apps/web/src/components/subscriptions/kiloclaw/KiloClawGroup.tsx`
- Shared billing types/constants:
  - `apps/web/src/app/(app)/claw/components/billing/billing-types.ts`

Display rules:

- Existing live legacy subscription shows legacy prices and legacy instance cap.
- Fresh/new signup shows `$55/month` and `$306/6-month commit`; no `$24 first month` offer.
- Canceled history should not cause new subscribe cards to display legacy prices.

### 11. Specs to update

Update `.specs/kiloclaw-billing.md`:

- Pricing catalog / price-version concept.
- Legacy vs current plan prices.
- `kiloclaw_price_version` immutability and lineage transfer rules.
- Trial duration by price version.
- Preserved pre-rollout Standard intro eligibility and the absence of current Standard intro pricing.
- Kilo Pass sufficiency based on price version.
- Stripe price recognition for legacy and current prices.
- Trial warning/inactivity behavior by trial duration/version.

Update `.specs/kiloclaw-datamodel.md`:

- `kiloclaw_subscriptions.kiloclaw_price_version` is required after migration.
- Price version is immutable within a subscription lineage.
- Successor subscription rows copy price version only for live lineage transfer.
- Historical canceled rows retain their version but do not grant future eligibility.

Likely impacted specs to review/update if behavior changes surface there:

- `.specs/subscription-center.md` for display rules.
- `.specs/kiloclaw-referrals.md` if reward economics need explicit “one month of whatever the subscription’s price version/plan is.”
- `.specs/kiloclaw-affiliates.md` if SKU/category reporting needs per-version plan names.

### 12. Affiliate/referral reporting

Expected code behavior remains mostly correct if amounts come from catalog/version:

- Stripe-funded sale reporting uses actual invoice amount.
- Pure-credit sale reporting uses deduction amount.
- New prices change sale amounts and external commission/reconciliation.

Implementation notes:

- Ensure Impact SKU/category reporting can distinguish Standard/Commit and optionally price version.
- External Impact commission configuration changes are out of repo scope.
- Referral free-month economics were not redefined in this planning pass; preserve current semantics unless spec review requires a clarification.

### 13. Canonical price-version state matrix

Before implementation, turn this matrix into targeted tests and use it to resolve ambiguous code review questions.

| Scenario | Price version source | Required outcome |
| --- | --- | --- |
| Fresh trial/provision with no subscription history | Current catalog version | 1-day trial, `perf-1-3` default/max self-service entitlement |
| Trialing live legacy lineage converts to Standard | Existing trial row | Legacy `$4` first paid month if no prior paid KiloClaw subscription, then `$9/month` |
| Trialing live current lineage converts to Standard | Existing trial row | Current `$55` from the first paid month; no Standard intro |
| Fresh paid enrollment after canceled legacy history | Current catalog version | Current `$55` Standard or `$306` Commit prices and `perf-1-3`; canceled row remains historical only |
| Active/past-due/unpaid paid row exists | Existing row, no new enrollment | Duplicate checkout/enrollment rejected as today |
| Pending-cancel legacy row renews or is reactivated before final cancellation | Existing row | Preserve legacy version and prices |
| Standard ↔ Commit switch on live legacy row | Existing row | Preserve legacy version; use legacy target plan price IDs/amounts |
| Standard ↔ Commit switch on live current row | Existing row | Preserve current version; use current target plan price IDs/amounts |
| Live reprovision/successor transfer | Live predecessor row | Copy predecessor version; apply that version’s default/max self-service entitlement |
| Reprovision after canceled historical row | Current catalog version | Do not copy canceled version; use current prices and `perf-1-3` |
| Webhook/settlement resolves transferred-out predecessor | Current successor row after lineage traversal | Mutate successor only; preserve successor price version |
| Standalone Stripe → credit conversion | Existing row | Preserve price version while clearing Stripe ownership at period end |
| Stripe invoice settlement | Recognized invoice price ID plus existing row | Price ID family must match row version; settle actual invoice amount |
| Pure-credit renewal | Subscription row | Charge catalog amount for row version and effective plan |
| Kilo Pass upsell auto-activation | Intended row/version | Proceed only if effective credits cover selected first charge for that version |

## Rollout sequence

1. Finalize the canonical price-version state matrix and expected outcomes.
2. Inventory all `kiloclaw_subscriptions` insert/upsert writers.
3. Resolve the provisioning service boundary for price-version-derived instance entitlement.
4. Add catalog code and tests with legacy/current entries.
5. Add `kiloclaw_price_version` schema field and generate migration.
6. Append migration backfill setting all existing subscription rows to legacy version.
7. Update all subscription creation paths to set current version for fresh rows and copy predecessor version for live successor rows.
8. Replace credit billing constants with catalog lookups.
9. Update Stripe price mapping/config for current checkout + legacy recognition.
10. Update trial creation/warnings/inactivity to be catalog/version aware.
11. Update instance default/cap behavior for legacy vs current version.
12. Update Kilo Pass sufficiency and auto-activation.
13. Update UI price displays and subscription-center surfaces.
14. Update specs.
15. Update tests and env examples.
16. Run rollout audit checks.
17. Deploy with Stripe prices configured for both legacy recognition and new checkout.

## Test plan

Add/update targeted tests for:

- Canonical price-version state matrix:
  - every matrix row has at least one targeted assertion,
  - tests assert actual amount, Stripe price family, trial duration, or instance entitlement where applicable.
- Catalog lookup:
  - legacy amounts/trial/default instance,
  - current amounts/trial/default instance,
  - unknown version fails closed.
- Migration/backfill expectations:
  - existing rows get legacy version,
  - new inserts require current/explicit version,
  - every production/operational subscription writer sets `kiloclaw_price_version` deliberately.
- Credit enrollment:
  - legacy/pre-rollout Standard first paid `$4` when eligible, then `$9`,
  - current Standard first paid `$55` with no intro discount,
  - legacy Commit `$48`,
  - current Commit `$306`,
  - trial-only history preserves Standard intro eligibility only inside eligible pre-rollout lineages.
- Pure-credit renewal:
  - charges by subscription `kiloclaw_price_version`.
- Stripe settlement:
  - legacy price IDs still recognized,
  - current price IDs recognized,
  - invoice amount is used for settlement,
  - recognized intro repair maps to the same version's standard recurring price,
  - fresh current checkout/schedules do not use a current intro price.
- Reprovision successor transfer:
  - live legacy predecessor copies legacy version,
  - canceled historical row does not seed legacy version for fresh rejoin.
- Plan switching:
  - Standard ↔ Commit preserves `kiloclaw_price_version`.
- Cancellation/reactivation:
  - pending cancellation keeps version,
  - reactivation before period end keeps version,
  - final canceled row remains historical and fresh re-enrollment uses current version.
- Trial lifecycle:
  - existing 7-day trial unchanged,
  - new trial is 1 day,
  - 1-day trial gets urgent warning only,
  - 1-day trial warning behavior is validated against lifecycle job cadence,
  - 1-day trial skips 48-hour inactivity stop.
- Instance defaults:
  - current fresh provisioning uses `perf-1-3`,
  - legacy live reprovision uses/caps to `shared-2-3`,
  - rollout does not actively resize existing instances.
- Kilo Pass:
  - eligibility uses `$48` for legacy Commit and `$306` for current Commit,
  - Standard thresholds use `$4` only for eligible pre-rollout lineages and `$55` for current first paid Standard.
- UI/status endpoints:
  - live legacy subscription displays legacy prices,
  - new subscribe path displays new prices,
  - canceled legacy history does not make fresh subscribe display legacy prices.

## Rollout audit checks

Before enabling current-price checkout in production, verify:

- all pre-rollout subscription rows have the legacy price version,
- no active/current-price row uses legacy Stripe price IDs,
- no active/legacy-price row uses current Stripe price IDs,
- no canceled historical row is selected as a live lineage source,
- live legacy reprovision uses/caps to `shared-2-3`,
- fresh current provisioning uses/caps to `perf-1-3`,
- hard-coded legacy credit amounts remain only in the catalog or tests,
- Stripe recognition config includes both legacy and current price IDs in every settlement/repair service.

## Verification commands

Use narrow checks first:

- `pnpm --filter @kilocode/db test` or package-specific schema tests if available.
- Targeted tests for KiloClaw billing/credit modules.
- Targeted tests for `services/kiloclaw-billing` lifecycle/provision bootstrap.
- Targeted tests for Stripe handlers.
- Targeted tests for Kilo Pass upsell eligibility.
- `scripts/typecheck-all.sh --changes-only` instead of full `pnpm typecheck` unless full suite is explicitly needed.
- `pnpm format` before committing.

## Open implementation placeholders

- Exact legacy catalog date-key constant.
- Exact new rollout catalog date-key constant.
- New Stripe Price IDs for:
  - Standard recurring `$55`,
  - Commit `$306` / 6 months.
- Whether any retired current intro price ID must remain recognized for non-production cleanup; production fresh checkout must not require or use one.
- Final env var names for legacy vs current Stripe price IDs.
- Final implementation choice for passing price-version-derived instance default/cap into provisioning. This must be resolved before changing provisioning behavior, not during rollout.
