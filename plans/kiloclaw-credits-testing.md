# KiloClaw Credit Billing — Manual Test Plan

## Prerequisites

| Requirement             | Details                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Environment**         | Local dev (`localhost:3000`) with Stripe test mode                                                                               |
| **Billing enforcement** | `KILOCLAW_BILLING_ENFORCEMENT=true`                                                                                              |
| **Stripe price IDs**    | `STRIPE_KILOCLAW_COMMIT_PRICE_ID`, `STRIPE_KILOCLAW_STANDARD_PRICE_ID`, `STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID` all configured |
| **Test card**           | Stripe test card `4242 4242 4242 4242` (success), `4000 0000 0000 0341` (decline)                                                |
| **Fake users**          | Create via `/users/sign_in?fakeUser=...` per the dev login flow                                                                  |
| **DB access**           | Direct DB access to inspect `kiloclaw_subscriptions`, `credit_transactions`, `kiloclaw_email_log` tables                         |
| **Cron endpoint**       | Ability to manually trigger the billing lifecycle cron (POST to the cron endpoint with the auth secret)                          |

For each test, use a fresh fake user unless noted. Name users descriptively (e.g., `kilo-trial-test-...@example.com`).

---

## 1. Trial Flow

### 1.1 — Trial auto-creation on first instance provisioning

1. Sign in as a new fake user with no prior state.
2. Navigate to `/claw`.
3. Provision a new KiloClaw instance.
4. **Verify**: User sees the Welcome Page with trial countdown.
5. **Verify** (DB): `kiloclaw_subscriptions` has a row with `status='trialing'`, `trial_ends_at` = now + 7 days.
6. **Verify**: `getBillingStatus` returns `trialEligible: false`, `hasAccess: true`, `accessReason: 'trial'`, trial data with correct dates.
7. **Verify**: No payment method was required.

### 1.2 — Trial access grants instance operations

1. With the trial-active user from 1.1, verify you can start/stop the instance.
2. Verify configuration changes work.

### 1.3 — No duplicate trial for existing users

1. With a user who already has an instance or subscription, navigate to `/claw`.
2. **Verify**: `trialEligible` is `false` in billing status.
3. **Verify**: No new trial row is created.

### 1.4 — Trial expiry warnings (requires cron)

1. In the DB, set `trial_ends_at` to ~1.5 days from now.
2. Trigger the billing lifecycle cron.
3. **Verify** (DB): `kiloclaw_email_log` has a `trial-expires-tomorrow` entry for this user.
4. Set `trial_ends_at` to ~2.5 days from now (on a different user).
5. Trigger the cron.
6. **Verify**: `trial-ending-soon` email logged.

### 1.5 — Trial expiry enforcement (requires cron)

1. Set `trial_ends_at` to a time in the past.
2. Trigger the billing lifecycle cron.
3. **Verify** (DB): Subscription `status='canceled'`, `suspended_at` set, `destruction_deadline` = now + 7 days.
4. **Verify**: Instance was stopped.
5. **Verify**: `trial-suspended` email logged.
6. **Verify** (UI): User sees AccessLockedDialog with "Your Trial Has Ended" and a subscribe CTA.

---

## 2. Kilo Pass Upsell Checkout (Recommended Path)

### 2.1 — Kilo Pass + Standard plan

1. New user with a provisioned instance (trial or expired trial).
2. Open the PlanSelectionDialog (click Subscribe).
3. In the **"Activate with Kilo Pass"** section, select monthly cadence, Starter tier ($19).
4. **Verify**: Commit plan hosting radio is **disabled** (Starter tier < $48).
5. Select Standard hosting plan.
6. Click "Get Kilo Pass + Hosting".
7. **Verify**: Redirected to Stripe checkout for a Kilo Pass Starter subscription.
8. Complete payment with test card.
9. **Verify**: Redirected to the Kilo Pass awarding page with step progress: Payment → Credits → Hosting → Done.
10. **Verify**: Awarding page polls, transitions through steps, then shows "Done" and redirects to `/claw`.
11. **Verify** (DB): User has a Kilo Pass subscription, credit balance increased, hosting subscription with `payment_source='credits'`, `status='active'`, `payment_provider_subscription_id=null` (pure credit).
12. **Verify** (UI): SubscriptionCard shows plan = Standard, payment badge = "Credits", renewal date, renewal cost ($9.00).

### 2.2 — Kilo Pass + Commit plan (Pro tier)

1. Repeat 2.1 but select Pro tier ($49/month), monthly cadence.
2. **Verify**: Commit plan is **enabled** (Pro ≥ $48).
3. Select Commit hosting plan.
4. Complete the checkout flow.
5. **Verify** (DB): Subscription `plan='commit'`, `commitment_ends_at` = now + 6 months, `credit_renewal_at` = now + 6 months, credit transaction for 48,000,000 microdollars.

### 2.3 — Kilo Pass yearly + Commit plan (Starter tier)

1. Select yearly cadence, Starter tier ($228/year).
2. **Verify**: Commit plan is **enabled** (all yearly tiers qualify).
3. Complete checkout.
4. **Verify**: Same as 2.2 for subscription state.

### 2.4 — Kilo Pass checkout with existing active subscription (rejection)

1. User already has an active subscription.
2. Attempt to open PlanSelectionDialog and start checkout.
3. **Verify**: Error toast "You already have an active subscription" (or similar rejection).

---

## 3. Stripe Hosting-Only Checkout

### 3.1 — Standard plan via Stripe

1. New user with a provisioned instance.
2. Open PlanSelectionDialog → Hosting Only section.
3. Select Standard plan.
4. Click "Subscribe to Standard Plan – $9".
5. **Verify**: Redirected to Stripe checkout. Confirm first-month discount coupon is applied ($4 first month).
6. Complete payment.
7. **Verify**: Redirected to KiloClawCheckoutSuccessClient.
8. **Verify**: Page shows "Setting up your subscription..." → "Processing payment..." → "Subscription Active!" → redirects to `/claw`.
9. **Verify** (DB): Subscription row has `payment_source='credits'` (hybrid), `payment_provider_subscription_id` is non-null, `status='active'`, `credit_renewal_at` set.
10. **Verify**: Credit transactions show a balanced deposit + deduction (net zero) for the first period.
11. **Verify** (UI): SubscriptionCard shows "Stripe" payment badge, plan = Standard.

### 3.2 — Commit plan via Stripe

1. Same as 3.1 but select Commit plan ($48).
2. **Verify**: No first-month discount coupon for commit.
3. **Verify** (DB): `plan='commit'`, `commitment_ends_at` set to 6 months out.

### 3.3 — Duplicate checkout prevention

1. User with an active subscription tries to start a new checkout.
2. **Verify**: API rejects with "already has an active subscription".

### 3.4 — Checkout allowed when trialing or canceled

1. User with `status='trialing'` opens checkout → **Verify**: allowed.
2. User with `status='canceled'` opens checkout → **Verify**: allowed.

### 3.5 — Abandoned checkout cleanup

1. Start a checkout session but don't complete it.
2. Start another checkout session.
3. **Verify**: The system attempts to expire the first session (best-effort). Second checkout succeeds.

---

## 4. Direct Credit Enrollment (Hosting Only with Existing Credits)

### 4.1 — Standard plan enrollment with sufficient balance

1. User with ≥ $9 in credit balance and a provisioned instance.
2. Open PlanSelectionDialog → Hosting Only.
3. Select Standard plan.
4. **Verify**: "Pay with credits" section appears showing balance and cost.
5. Click "Pay $9.00 with Credits".
6. **Verify**: Toast "Subscription activated with credits". Dialog closes.
7. **Verify** (DB): `payment_source='credits'`, `payment_provider_subscription_id=null` (pure credit), `status='active'`, `credit_renewal_at` = now + 1 month.
8. **Verify**: Credit transaction for -9,000,000 microdollars with idempotency key `kiloclaw-subscription:{instance_id}:YYYY-MM`.
9. **Verify**: Balance decreased by $9.

### 4.2 — Commit plan enrollment with sufficient balance

1. User with ≥ $48 in credit balance.
2. Enroll in commit plan via credits.
3. **Verify** (DB): Credit transaction for -48,000,000 microdollars, key includes `commit`, `commitment_ends_at` 6 months out.

### 4.3 — Insufficient balance

1. User with $5 credit balance.
2. Select Standard plan ($9) in Hosting Only.
3. **Verify**: "Insufficient credits" section shows balance, cost, and shortfall.
4. **Verify**: "Add credits to your balance" link points to `/credits`.
5. **Verify**: No "Pay with Credits" button available.

### 4.4 — Enrollment with auto-resume (previously suspended instance)

1. In the DB, set subscription to `status='canceled'`, `suspended_at` non-null, `destruction_deadline` set.
2. Give user sufficient credit balance.
3. Enroll via credits.
4. **Verify** (DB): Subscription is now `active`, `suspended_at` cleared, `destruction_deadline` cleared.
5. **Verify**: Instance was started (auto-resume).
6. **Verify**: Suspension-cycle email log entries cleared.

### 4.5 — Idempotent enrollment (duplicate prevention)

1. Complete enrollment once.
2. Attempt enrollment again with the same parameters.
3. **Verify**: Second attempt is rejected as duplicate.

---

## 5. Billing Status Reporting

### 5.1 — Complete billing status shape

For each user state, verify `getBillingStatus` includes the correct fields:

| State                                   | Expected                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trial active**                        | `hasAccess: true`, `accessReason: 'trial'`, trial data present                                                                                                                            |
| **Trial expired**                       | `hasAccess: false`, `trial.expired: true`                                                                                                                                                 |
| **Active subscription (pure credit)**   | `hasAccess: true`, `accessReason: 'subscription'`, subscription data includes `paymentSource: 'credits'`, `hasStripeFunding: false`, `creditRenewalAt` set, `renewalCostMicrodollars` set |
| **Active subscription (hybrid)**        | `hasStripeFunding: true`, `paymentSource: 'credits'`                                                                                                                                      |
| **Active subscription (legacy Stripe)** | `hasStripeFunding: true`, `paymentSource: 'stripe'`                                                                                                                                       |
| **Past-due**                            | `hasAccess: true` (within 14 days), subscription `status: 'past_due'`                                                                                                                     |
| **Canceled**                            | `hasAccess: false`, subscription `status: 'canceled'`                                                                                                                                     |
| **Earlybird**                           | `hasAccess: true`, `accessReason: 'earlybird'`, earlybird data present                                                                                                                    |
| **No access**                           | `hasAccess: false`, `accessReason: null`                                                                                                                                                  |

### 5.2 — Stripe-funding indicator

1. **Verify**: Pure credit subscription → `hasStripeFunding: false`.
2. **Verify**: Hybrid subscription → `hasStripeFunding: true`.
3. **Verify**: UI shows "Manage Payment" button only when `hasStripeFunding: true`.

### 5.3 — Conversion prompt indicator

1. User with Stripe-funded hosting + active Kilo Pass.
2. **Verify**: `showConversionPrompt: true` in billing status.
3. **Verify** (UI): SubscriptionCard shows blue conversion prompt.

### 5.4 — Credit balance included

1. **Verify**: `creditBalanceMicrodollars` is present and accurate in billing status.

---

## 6. Plan Switching

### 6.1 — Standard → Commit (pure credit)

1. User with active pure credit Standard subscription.
2. Click "Switch to Commit ($8/mo)".
3. **Verify**: `scheduledPlan: 'commit'`, `scheduledBy: 'user'` in billing status.
4. **Verify** (UI): SubscriptionCard shows "Switching to Commit on [date]" in amber.
5. Trigger cron after period ends.
6. **Verify**: Plan is now commit, `commitment_ends_at` set, credit deduction was 48M microdollars.

### 6.2 — Commit → Standard (pure credit)

1. User with active pure credit Commit subscription.
2. Switch to Standard.
3. **Verify**: Scheduled plan recorded.
4. After period ends and cron runs: plan = standard, `commitment_ends_at` cleared.

### 6.3 — Standard → Commit (Stripe-funded / hybrid)

1. User with active hybrid subscription.
2. Switch plan.
3. **Verify**: Stripe schedule created (check API or logs).
4. **Verify**: `scheduledPlan: 'commit'` in billing status.

### 6.4 — Cancel plan switch

1. User with a pending plan switch.
2. Click "Cancel Switch".
3. **Verify**: `scheduledPlan: null` in billing status.
4. **Verify** (UI): Switch button reappears.

### 6.5 — Rejection cases

1. Already on requested plan → **Verify**: Error "Already on this plan".
2. Subscription not active → **Verify**: Error rejecting switch.

---

## 7. Cancellation and Reactivation

### 7.1 — Cancel pure credit subscription

1. Active pure credit subscription → Cancel.
2. **Verify** (DB): `cancel_at_period_end = true`.
3. **Verify** (UI): CancelingSubscriptionCard shows "Cancels on [date]" with Reactivate button.
4. **Verify**: Access continues until period end.

### 7.2 — Cancel Stripe-funded subscription

1. Active hybrid subscription → Cancel.
2. **Verify**: Cancel-at-period-end set both locally and in Stripe.
3. **Verify**: If plan switch was pending, schedule was released first.

### 7.3 — Reactivate pure credit subscription

1. Subscription pending cancellation → Reactivate.
2. **Verify** (DB): `cancel_at_period_end = false`.
3. **Verify** (UI): ActiveSubscriptionCard reappears.

### 7.4 — Reactivate Stripe-funded subscription

1. Same as 7.3 but Stripe subscription updated too.

### 7.5 — Rejection cases

1. No subscription → Cancel → **Verify**: Error.
2. Already canceling → Cancel again → **Verify**: Error.

---

## 8. Standalone-to-Credit Conversion

### 8.1 — Conversion prompt displayed

1. User with Stripe-funded hosting + active Kilo Pass.
2. Navigate to `/claw`.
3. **Verify** (UI): SubscriptionCard shows blue conversion prompt: "Switch to Credits" / "Dismiss".

### 8.2 — Accept conversion

1. Click "Switch to Credits".
2. **Verify** (DB): Stripe subscription has `cancel_at_period_end = true`.
3. **Verify** (UI): Subscription card updates (conversion prompt disappears).
4. When period ends (simulate or wait), **Verify** (DB): `payment_provider_subscription_id` cleared, `payment_source = 'credits'` (pure credit), `credit_renewal_at` set to old period end.

### 8.3 — Dismiss conversion

1. Click "Dismiss".
2. **Verify**: Prompt disappears. Stripe subscription unchanged.
3. Refresh page → prompt reappears (dismissal is not persisted).

### 8.4 — Conversion not shown when no Kilo Pass

1. User with Stripe-funded hosting but no Kilo Pass.
2. **Verify**: `showConversionPrompt: false`. No prompt in UI.

---

## 9. Stripe-Funded Credit Settlement (Invoice Settlement)

### 9.1 — First invoice converts legacy Stripe to hybrid

1. Create a subscription via Stripe checkout (legacy path).
2. Payment succeeds, invoice.paid webhook fires.
3. **Verify** (DB): `payment_source` changed from `stripe` to `credits`, subscription ID preserved (now hybrid).
4. **Verify**: Credit transactions include a balanced positive + negative entry (net zero).
5. **Verify**: `status = 'active'`, period boundaries match invoice.

### 9.2 — Subsequent invoice renews hybrid subscription

1. Hybrid subscription's period ends, Stripe charges again.
2. **Verify**: Period advanced via new balanced credit entries.
3. Old credit entries untouched. New entries use updated period key.

### 9.3 — Settlement idempotency

1. Replay the same `invoice.paid` webhook.
2. **Verify**: No duplicate credit entries. No state mutation.

### 9.4 — Settlement with past-due recovery

1. In DB, set subscription to `status='past_due'`, `suspended_at` set.
2. Simulate invoice.paid webhook.
3. **Verify**: Status recovered to active. Auto-resume triggered.

---

## 10. Credit Renewal Sweep (Background Job)

### 10.1 — Successful standard plan renewal

1. Pure credit subscription, sufficient balance, `credit_renewal_at` in the past.
2. Trigger cron.
3. **Verify** (DB): Credit transaction deducted, period advanced 1 month, `credit_renewal_at` = new period end.
4. **Verify**: Bonus credit evaluation triggered.

### 10.2 — Successful commit plan renewal

1. Pure credit commit subscription, sufficient balance, renewal due.
2. Trigger cron.
3. **Verify**: 48M microdollar deduction. Period advanced 6 months.
4. If `commitment_ends_at` was reached: **Verify** extended by 6 months.

### 10.3 — Insufficient balance → past-due

1. Pure credit subscription, balance = $0, renewal due.
2. Trigger cron.
3. **Verify** (DB): `status='past_due'`, `past_due_since` set.
4. **Verify**: `credit-renewal-failed` email logged.

### 10.4 — Insufficient balance with auto top-up

1. User with auto top-up enabled, insufficient balance, renewal due.
2. Trigger cron.
3. **Verify** (DB): Auto top-up marker set on subscription. Status NOT changed to past-due.
4. **Verify**: No failure email sent.
5. Trigger cron again after top-up succeeds: **Verify** normal deduction.

### 10.5 — Cancel-at-period-end handling

1. Pure credit subscription with `cancel_at_period_end = true`, renewal due.
2. Trigger cron.
3. **Verify** (DB): `status='canceled'`, `cancel_at_period_end = false`, period NOT advanced.

### 10.6 — Plan switch applied at renewal

1. Pure credit standard subscription with `scheduled_plan = 'commit'`, renewal due.
2. Trigger cron.
3. **Verify** (DB): `plan='commit'`, `scheduled_plan=null`, `commitment_ends_at` set, deduction = 48M.

### 10.7 — Grace-period recovery (past-due → active)

1. Pure credit subscription, `status='past_due'`, `suspended_at=null`, now has sufficient balance, renewal due.
2. Trigger cron.
3. **Verify**: Deduction succeeds, status → active, `past_due_since` cleared.
4. **Verify**: `credit-renewal-failed` email log entry deleted (so it can fire again in the future).

### 10.8 — Suspended recovery (past-due → active with auto-resume)

1. `status='past_due'`, `suspended_at` set, sufficient balance.
2. Trigger cron.
3. **Verify**: Deduction succeeds, auto-resume triggered, suspension columns cleared, email logs cleared.

### 10.9 — Hybrid subscription excluded

1. Hybrid subscription with renewal due.
2. Trigger cron.
3. **Verify**: NOT selected by credit renewal sweep. No deduction.

### 10.10 — One period advance per run

1. Subscription behind by multiple periods.
2. Trigger cron once.
3. **Verify**: Only advances by one period. Second cron run advances another period.

---

## 11. Lifecycle Enforcement (Background Job Sweeps)

### 11.1 — Subscription period expiry → suspension

1. `status='canceled'`, `current_period_end` in the past, `suspended_at=null`.
2. Trigger cron.
3. **Verify**: Instance stopped, `suspended_at` set, `destruction_deadline` 7 days out.
4. **Verify**: `subscription-suspended` email logged.

### 11.2 — Past-due > 14 days → suspension

1. `status='past_due'`, `past_due_since` > 14 days ago, `suspended_at=null`.
2. Trigger cron.
3. **Verify**: Instance stopped, `suspended_at` set, `destruction_deadline` 7 days out.
4. **Verify**: `payment-suspended` email logged.

### 11.3 — Destruction warning

1. `suspended_at` set, `destruction_deadline` ≤ 2 days from now.
2. Trigger cron.
3. **Verify**: `destruction-warning` email logged.

### 11.4 — Instance destruction

1. `destruction_deadline` in the past.
2. Trigger cron.
3. **Verify**: Instance destroyed in the claw provider, instance record marked destroyed, `destruction_deadline` cleared.
4. **Verify**: `instance-destroyed` email logged.

### 11.5 — Interrupted auto-resume retry

1. `status='active'`, `payment_source='credits'`, `suspended_at` still set (crashed mid-resume).
2. Trigger cron.
3. **Verify**: Auto-resume retried, suspension columns cleared.

---

## 12. Access Control

### 12.1 — Access gate hierarchy

| User State                          | Expected                                                 |
| ----------------------------------- | -------------------------------------------------------- |
| Active subscription                 | ✅ Access                                                |
| Past-due (< 14 days, not suspended) | ✅ Access                                                |
| Trialing (not expired)              | ✅ Access                                                |
| Earlybird (not expired)             | ✅ Access                                                |
| Expired trial                       | ❌ Forbidden — "Your Trial Has Ended"                    |
| Expired earlybird                   | ❌ Forbidden — "Earlybird Hosting Expired"               |
| Canceled subscription               | ❌ Forbidden — "Subscription Ended"                      |
| Past-due + suspended                | ❌ Forbidden — "Payment Issue" or "Insufficient Credits" |

### 12.2 — AccessLockedDialog shows correct remediation

1. **Trial expired, instance alive**: "Subscribe to Resume" + optional "Destroy Instance" button.
2. **Trial expired, instance destroyed**: "Subscribe" (no destroy option).
3. **Subscription expired, instance alive**: "Subscribe to Resume" + destroy.
4. **Credit-funded past-due suspended**: "Insufficient Credits" title, "Add Credits" CTA, "Get Kilo Pass" secondary CTA.
5. **Stripe-funded past-due suspended**: "Payment Issue" title, "Update Payment Method" CTA.

---

## 13. Earlybird Flows

### 13.1 — Earlybird access

1. User with earlybird purchase, expiry in the future.
2. **Verify**: `hasAccess: true`, `accessReason: 'earlybird'`.

### 13.2 — Earlybird expiry warnings

1. Set earlybird expiry to ~13 days from now. Trigger cron.
2. **Verify**: Earlybird warning email logged.
3. Set to ~1 day. Trigger cron.
4. **Verify**: Earlybird expires-tomorrow email logged.

### 13.3 — Earlybird expiry does NOT auto-create trial

1. Earlybird expired, no subscription.
2. **Verify**: User must manually subscribe. No trial created.

---

## 14. Billing Portal

### 14.1 — Portal access for Stripe-funded

1. Hybrid subscription → "Manage Payment" button visible → Click.
2. **Verify**: Redirected to Stripe billing portal.

### 14.2 — No portal for pure credit

1. Pure credit subscription.
2. **Verify**: "Manage Payment" button is NOT shown.

---

## 15. Email Notification Idempotency

### 15.1 — No duplicate sends

1. Trigger any notification situation twice (run cron twice).
2. **Verify**: Only one email log entry per notification type per user per lifecycle event.

### 15.2 — Retry on failure

1. Simulate a notification send failure.
2. Trigger cron again.
3. **Verify**: Notification retried (no email log entry means it can be retried).

---

## 16. Edge Cases & Regression Checks

### 16.1 — Concurrent checkout prevention

1. Start two checkout sessions simultaneously.
2. **Verify**: At most one subscription created (Stripe-side customer check prevents duplicates).

### 16.2 — Webhook ordering tolerance

1. For hybrid subscriptions, invoice settlement and schedule completion may arrive in either order.
2. **Verify**: Both orderings produce the same final state.

### 16.3 — Effective balance includes projected bonus

1. User with Kilo Pass, balance barely insufficient for enrollment.
2. Projected bonus from Kilo Pass would make it sufficient.
3. **Verify**: Enrollment succeeds (effective balance = balance + projected bonus).

### 16.4 — Negative transient balance tolerance

1. After credit deduction but before bonus award, balance may be negative.
2. **Verify**: UI displays the balance correctly, no errors from other systems.

### 16.5 — Per-instance subscription scoping

1. User with two instances.
2. Enroll one instance, leave the other as trial.
3. **Verify**: Each instance has independent subscription state.
4. **Verify**: Both subscriptions deduct from the same credit balance.

### 16.6 — Orphaned subscription reattachment

1. Subscription row exists but instance was destroyed/recreated.
2. **Verify**: Subscription reattaches when instance becomes available.

---

## Appendix: Triggering the Billing Lifecycle Cron

```bash
curl -X POST http://localhost:3000/api/cron/kiloclaw-billing \
  -H "Authorization: Bearer $CRON_SECRET"
```

The cron runs 10 sequential sweeps:

1. Credit renewal
2. Trial expiry warnings
3. Earlybird expiry warnings
4. Trial expiry enforcement
5. Subscription period expiry enforcement
6. Past-due payment enforcement
7. Destruction warning
8. Instance destruction
9. Interrupted auto-resume retry

Each sweep processes users independently — a failure for one user does not prevent processing of other users.
