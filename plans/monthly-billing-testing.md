# Monthly Billing — Manual Testing Plan

## Prerequisites

1. Stripe test mode with monthly and annual price IDs configured for both
   Teams and Enterprise products.
2. Environment variables set:
   - `STRIPE_TEAMS_MONTHLY_PRICE_ID`
   - `STRIPE_TEAMS_ANNUAL_PRICE_ID`
   - `STRIPE_ENTERPRISE_MONTHLY_PRICE_ID`
   - `STRIPE_ENTERPRISE_ANNUAL_PRICE_ID`
3. Fresh dev server restart to pick up all changes.
4. A Stripe test card number (e.g., `4242 4242 4242 4242`).

## A. Checkout Flow (UpgradeTrialDialog)

| #   | Test Case                   | Steps                                 | Expected Result                                                                                                                 |
| --- | --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Default cycle is Annual     | Open Upgrade dialog from trial banner | Annual pill highlighted blue; "Save 17%" badge at full opacity; prices $15 (Teams) / $60 (Enterprise); "Billed annually" labels |
| A2  | Toggle to Monthly           | Click "Monthly" pill                  | Monthly pill highlighted; badge fades to 30% opacity; prices change to $18 / $72; labels change to "Billed monthly"             |
| A3  | Toggle back to Annual       | Click "Annual" pill                   | Reverts to Annual display                                                                                                       |
| A4  | Monthly Teams checkout      | Monthly → Teams → Purchase            | Redirects to Stripe with monthly Teams price ($18/seat/month)                                                                   |
| A5  | Monthly Enterprise checkout | Monthly → Enterprise → Purchase       | Redirects to Stripe with monthly Enterprise price ($72/seat/month)                                                              |
| A6  | Annual Teams checkout       | Annual → Teams → Purchase             | Redirects to Stripe with annual Teams price ($180/seat/year)                                                                    |
| A7  | Annual Enterprise checkout  | Annual → Enterprise → Purchase        | Redirects to Stripe with annual Enterprise price ($720/seat/year)                                                               |

## B. Subscription Overview (post-checkout)

| #   | Test Case                      | Steps                                         | Expected Result                                                           |
| --- | ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------- |
| B1  | Monthly sub overview           | Complete monthly checkout → view Subscription | "Monthly" in Billing Cycle column; correct monthly amount in Next Payment |
| B2  | Annual sub overview            | Complete annual checkout → view Subscription  | "Yearly" in Billing Cycle column; correct annual amount in Next Payment   |
| B3  | Quick Actions shows Switch btn | View active subscription Quick Actions        | "Switch to Annual" for monthly subs; "Switch to Monthly" for annual subs  |

## C. Billing Cycle Change

| #   | Test Case               | Steps                                           | Expected Result                                                                                                                |
| --- | ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| C1  | Switch monthly → annual | Click "Switch to Annual" in Quick Actions       | Confirmation dialog: current monthly rate, new annual rate, per-month comparison, savings, effective date, "No proration" note |
| C2  | Confirm cycle change    | Click "Switch to Annual" in dialog              | Toast confirms; overview shows pending banner with date and "Cancel Change" button; "Switch" button hidden                     |
| C3  | Switch annual → monthly | On annual sub, click "Switch to Monthly"        | Dialog shows cost-increase warning about higher per-seat cost                                                                  |
| C4  | Cancel pending change   | Click "Cancel Change" on pending banner         | Toast confirms cancellation; banner disappears; "Switch" button reappears                                                      |
| C5  | One change at a time    | Schedule a change, then try to schedule another | "Switch" button hidden while change is pending; backend returns error if called directly                                       |

## D. Billing Cycle + Seat Changes

| #   | Test Case                   | Steps                                           | Expected Result                                                                           |
| --- | --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| D1  | Seat increase on monthly    | On monthly sub, increase seats via Change Seats | Prorated charge applied immediately; seat count updates                                   |
| D2  | Seat decrease on monthly    | On monthly sub, decrease seats via Change Seats | No immediate charge; "Seat Count Change Scheduled" notification; seats drop at next month |
| D3  | Seat change + pending cycle | Schedule cycle change, then change seats        | Both changes coexist; seat change modifies subscription, cycle change via schedule        |

## E. Webhook & DB Verification

| #   | Test Case               | Steps                                       | Expected Result                                                          |
| --- | ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| E1  | Monthly purchase record | Complete monthly checkout                   | `organization_seats_purchases.billing_cycle` = `'monthly'`               |
| E2  | Annual purchase record  | Complete annual checkout                    | `organization_seats_purchases.billing_cycle` = `'yearly'`                |
| E3  | Renewal email (monthly) | Let monthly sub renew (or simulate webhook) | Renewal email sent; new purchase record with `billing_cycle = 'monthly'` |

## F. Access Control

| #   | Test Case                        | Steps                                | Expected Result                                    |
| --- | -------------------------------- | ------------------------------------ | -------------------------------------------------- |
| F1  | Owner can change cycle           | As org owner, use cycle change       | Succeeds                                           |
| F2  | Billing manager can change cycle | As billing_manager, use cycle change | Succeeds (backend permits; UI shows button)        |
| F3  | Member cannot change cycle       | As regular member, view subscription | No "Switch" button visible; API returns auth error |
| F4  | Non-member rejected              | API call from non-member             | Access denied error                                |

## G. Edge Cases

| #   | Test Case                    | Steps                                               | Expected Result                                                      |
| --- | ---------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| G1  | Cancelled sub, no cycle chg  | Cancel subscription → try cycle change              | "Switch" button not visible (requires active, non-cancelling sub)    |
| G2  | Same cycle rejected          | API: `changeBillingCycle` with current cycle        | Error: "already on this billing cycle"                               |
| G3  | Promotion codes              | Use promo code with monthly checkout                | Stripe handles eligibility per price; no code-side change needed     |
| G4  | Pending cancel + cycle chg   | Pending cancellation → try to schedule cycle change | "Switch" button hidden; only "Stop Cancellation" available           |
| G5  | Mid-cycle cancel w/ schedule | Schedule cycle change → cancel subscription         | Cancellation should proceed; pending schedule released or overridden |
