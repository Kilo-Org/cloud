# Affiliate Event Ledger With Cron-Only Dispatch

## Summary

- Use a lean `user_affiliate_events` table as the durable ledger/outbox for affiliate conversions.
- Make the web-app cron route the only dispatcher to Impact. Auth, checkout, Stripe webhook, and billing paths only enqueue rows.
- Enforce parent-before-child delivery by requiring a delivered parent event before `trial_start`, `trial_end`, or `sale` can move out of `blocked`.
- Use generic internal naming: `trackingId`, `affiliateTrackingId`, and `findOrCreateParentEvent`. Only the final Impact API adapter uses `ClickId`.

## Spec Updates

Update `.specs/impact-affiliate-tracking.md`:

- Replace `SIGNUP only for new user creation` with `SIGNUP once per user/provider on first attributed association.`
- Add an invariant that child events must not be sent before the parent `SIGNUP` event has been successfully delivered.

## Schema And Naming

- Add `user_affiliate_events` with only these fields:
  - `id`
  - `user_id`
  - `provider`
  - `event_type`
  - `dedupe_key`
  - `parent_event_id` nullable
  - `delivery_state`
  - `payload_json`
  - `attempt_count`
  - `next_retry_at` nullable
  - `claimed_at` nullable
  - `created_at`
- Use `delivery_state` values: `queued | blocked | sending | delivered | failed`.
- Add indexes for:
  - unique `dedupe_key`
  - claim path on `(delivery_state, coalesce(next_retry_at, '-infinity'), created_at, id)`
  - `parent_event_id`
- Do not add `attribution_id` in v1.
- Keep `payload_json` normalized around generic fields such as `trackingId`, `customerId`, `customerEmailHash`, `orderId`, `eventDate`, amount/currency/item fields where relevant. The dispatcher maps this to the provider API payload.
- Rename internal helper `findOrCreateSignupParentEvent` to `findOrCreateParentEvent`.
- Resolve the parent event type from provider config in code. For Impact in v1, the parent event type is `signup`.
- Rename internal `clickId` parameters and fields to `trackingId`.
- Rename Stripe checkout metadata from `impactClickId` to `affiliateTrackingId`.
- Read Stripe metadata compatibly during rollout: prefer `affiliateTrackingId`, fall back to legacy `impactClickId` for existing subscriptions and webhook events.
- Keep external Impact-specific names unchanged where required:
  - query param remains `im_ref`
  - cookie contract remains unchanged for compatibility unless a later coordinated change updates `kilo.ai`
  - outbound Impact payload still uses `ClickId`

## Dispatch And Logging

- Enqueue rules:
  - New user with first Impact attribution: create attribution row, then `findOrCreateParentEvent`, then enqueue only the parent event.
  - Existing user who first gains Impact attribution on login: same flow.
  - `trial_start`, `trial_end`, and `sale` enqueue child rows only after ensuring the parent row exists.
  - If the parent row is not yet `delivered`, create the child row as `blocked`.
- Cron route:
  - Add `/api/cron/dispatch-affiliate-events` on `* * * * *`.
  - Each run claims up to 100 eligible `queued` rows with `FOR UPDATE SKIP LOCKED`, sets `delivery_state = 'sending'`, and stamps `claimed_at`.
  - On success, mark row `delivered`.
  - On `5xx` or network error, increment `attempt_count`, set `delivery_state = 'queued'`, clear `claimed_at`, and compute `next_retry_at`.
  - On `4xx`, increment `attempt_count`, mark row `failed`, and clear `claimed_at`.
  - Before claiming new work, return stale `sending` rows with old `claimed_at` back to `queued`.
  - After a parent row becomes `delivered`, promote its `blocked` children to `queued`.
- Replace direct Impact dispatch in:
  - auth user creation
  - after-sign-in attribution recovery
  - KiloClaw trial start
  - Stripe-driven KiloClaw trial end
  - Stripe `invoice.paid` sale tracking
  - billing-worker trial-expiry side effect
- Replace the billing side-effect action with a generic enqueue action rather than direct tracking.
- Structured logs:
  - Use a dedicated logger source such as `affiliate-events`.
  - Every enqueue, claim, dispatch success, retry, unblock, and permanent failure log must include:
    - `affiliate_event_id`
    - `affiliate_parent_event_id`
    - `affiliate_provider`
    - `affiliate_event_type`
    - `affiliate_dedupe_key`
    - `user_id`
    - `delivery_state`
    - `attempt_count`
  - Dispatch logs should also include:
    - `dispatch_source` (`cron`)
    - `action_tracker_id` when provider is Impact
    - `order_id` when present
    - `tracking_id_present`
  - Failure logs should include:
    - `failure_kind` (`http_4xx`, `http_5xx`, `network`)
    - `status_code` when available
  - The DB row id is the primary join key between logs and the event ledger.

## Test Plan

- Schema/service tests:
  - dedupe keys prevent duplicate parent and child rows
  - blocked children do not dispatch before the parent is delivered
  - delivered parents promote blocked children to queued
  - stale `sending` rows are reclaimed from `claimed_at`
  - retries respect `next_retry_at`
- Naming/compat tests:
  - internal enqueue payloads use `trackingId`
  - Stripe checkout writes `affiliateTrackingId`
  - webhook readers accept both `affiliateTrackingId` and legacy `impactClickId`
- Auth-flow tests:
  - new attributed users enqueue exactly one parent event
  - existing users gaining attribution enqueue exactly one parent event
  - repeat attributed logins do not duplicate the parent event
- KiloClaw tests:
  - `trial_start`, `trial_end`, and `sale` enqueue rows instead of calling Impact directly
  - non-attributed users do not enqueue affiliate events
  - attributed users enqueue child rows linked to the correct parent row
- Cron-route tests:
  - unauthorized requests are rejected
  - success marks rows delivered
  - `5xx` requeues with backoff
  - `4xx` marks rows failed
  - success/failure logs include `affiliate_event_id` and `affiliate_dedupe_key`
- Keep and extend `impact.test.ts` so the final Impact adapter still emits `ClickId` correctly from internal `trackingId`.

## Assumptions

- `signup` now means the provider-specific parent event for the user's first attributed association, not only account creation.
- Logs, not extra DB columns, are the source of truth for per-attempt delivery history.
- `created_at` plus the structured logs are sufficient audit history for v1; `delivered_at`, `last_attempt_at`, `last_status_code`, `last_error`, `sending_started_at`, and generic extra timestamps are intentionally omitted.
- `softDeleteUser` must delete `user_affiliate_events` rows in addition to `user_affiliate_attributions`.
