# Impact Chargeback Reversal

## Summary

- Add async `sale_reversal` flow for Impact-tracked KiloClaw Stripe sales.
- Trigger reversal enqueue on Stripe `charge.dispute.created`.
- Reverse full Impact commission once per Stripe charge.
- Do not auto-restore commission if dispute later closes in our favor.
- Persist sale outbox rows during `invoice.paid` handling so later disputes always have charge-linked sale row to target.
- Treat legacy pre-rollout sales without stored Impact mapping as manual follow-up.

## Key Changes

### Spec and config

- Update `.specs/impact-affiliate-tracking.md` to state:
  - Stripe-backed personal KiloClaw `SALE` actions must enqueue an Impact reversal on `charge.dispute.created`.
  - No automatic restore path exists for later dispute wins.
  - Partial disputes still reverse the full commission.
  - Pre-rollout sales without stored Impact mapping are out of scope for automatic reversal.
- Add `IMPACT_REVERSAL_DISPOSITION_CODE` in `apps/web/src/lib/config.server.ts`.
- Default reversal disposition to `REJECTED` when env var is unset.

### Schema and types

- Extend `AffiliateEventType` in `packages/db/src/schema-types.ts` with `sale_reversal`.
- Extend `AffiliateEventPayloadJson` in `packages/db/src/schema.ts` with nullable fields:
  - `stripeChargeId`
  - `impactActionId`
  - `impactSubmissionUri`
  - `disputeId`
- Keep using `user_affiliate_events` as durable outbox; do not add a new table.
- Add DB columns on `user_affiliate_events` for:
  - `stripe_charge_id` nullable
  - `impact_action_id` nullable
  - `impact_submission_uri` nullable
- Add index on `(provider, event_type, stripe_charge_id)` to find sale rows by disputed charge quickly.
- Generate migration with `pnpm drizzle generate`. Do not hand-edit migration artifacts.

### Impact client

- Extend `apps/web/src/lib/impact.ts` to parse Impact write responses structurally instead of treating any `2xx` as immediate success.
- For sale creation:
  - Persist immediate `ActionId` when response exposes final action URI.
  - Persist queued submission URI when Impact accepts request asynchronously.
- Add helper to resolve queued submission URIs into final action IDs before reversal dispatch.
- Add reversal helper that sends Impact action reversal request using stored `ActionId`.
- Return dispatch result variants that distinguish:
  - immediate success with action ID
  - queued success awaiting resolution
  - permanent client failure
  - retryable server/network failure

### Affiliate event ledger and dispatcher

- In `apps/web/src/lib/affiliate-events.ts`, treat `sale_reversal` as child event dependent on delivered `sale` event.
- When enqueuing sale events from Stripe invoice flow:
  - store `stripe_charge_id` on the event row
  - persist sale outbox row inline in `handleKiloClawInvoicePaid` instead of deferring enqueue with `after(...)`
  - keep Impact API delivery async; only DB enqueue moves inline
- On successful sale dispatch:
  - write `impact_action_id` if available immediately
  - otherwise write `impact_submission_uri`
- Add helper:
  - `enqueueImpactSaleReversalForCharge({ stripeChargeId, disputeId, amount, currency, eventDate })`
- Reversal dedupe key format:
  - `affiliate:impact:sale_reversal:${stripeChargeId}`
- Reversal enqueue behavior:
  - find delivered or pending Impact `sale` row by `stripe_charge_id`
  - if no sale row exists, treat it as legacy/pre-rollout manual follow-up, log warning, and stop
  - if sale row exists but mapping is not yet available, enqueue blocked child tied to that sale row
  - if sale row already has usable action mapping, enqueue queued reversal row
- Reversal dispatch behavior:
  - load parent sale row
  - if parent has `impact_action_id`, call Impact reversal
  - if parent only has `impact_submission_uri`, resolve queued submission first and persist action ID
  - if submission is still pending, requeue reversal with backoff
  - if mapping resolution fails permanently, mark reversal failed and log manual follow-up requirement
- Parent-failure behavior:
  - if parent sale event reaches `failed`, mark any blocked `sale_reversal` children as `failed`
  - log manual follow-up requirement instead of leaving reversal rows blocked indefinitely
- Keep existing 5-minute parent-processing delay for `signup -> trial/sale` chain only.
- Do not apply signup delay to `sale -> sale_reversal`.

### Stripe webhook integration

- In `apps/web/src/lib/stripe.ts`, add `charge.dispute.created` case in `processStripePaymentEventHook`.
- For dispute events:
  - read `dispute.id`
  - read disputed `charge`
  - read `amount`, `currency`, and `created`
  - enqueue reversal only
- Do not call Impact directly from Stripe webhook path.
- No-op for:
  - disputes without charge ID
  - charges not linked to Impact-tracked KiloClaw sales
  - duplicate disputes for same charge after reversal already queued

## Implementation Notes

- Keep rollout forward-only:
  - new sales after rollout gain stored Impact mapping and support automatic reversal
  - older already-delivered sales without stored mapping only log warnings for manual handling
- Use structured logs for:
  - reversal enqueue
  - missing sale row
  - missing Impact mapping
  - queued submission resolution
  - reversal delivery
  - retry
  - permanent failure
  - parent sale failed before reversal could dispatch
- Include in reversal logs:
  - `affiliate_event_id`
  - `affiliate_parent_event_id`
  - `affiliate_provider`
  - `affiliate_event_type`
  - `affiliate_dedupe_key`
  - `user_id`
  - `stripe_charge_id`
  - `impact_action_id`
  - `dispute_id`

## Test Plan

- `apps/web/src/lib/impact.test.ts`
  - parses immediate sale success with action mapping
  - parses queued sale success with submission URI
  - builds reversal request correctly
  - honors default and overridden reversal disposition code
- `apps/web/src/lib/affiliate-events.test.ts`
  - sale dispatch persists `impact_action_id`
  - queued sale dispatch persists `impact_submission_uri`
  - reversal event blocks until parent sale is delivered
  - queued submission resolution upgrades parent with action ID
  - reversal retries on retryable failures
  - reversal fails permanently on client errors
  - blocked reversal fails when parent sale fails permanently
  - duplicate disputes for same charge do not create duplicate reversal rows
- `apps/web/src/tests/stripe.test.ts`
  - `charge.dispute.created` enqueues reversal for attributed KiloClaw sale
  - unmatched charge does nothing
  - missing charge ID does nothing
  - legacy sale without stored mapping logs warning and does not enqueue reversal
- `packages/db/src/schema.test.ts`
  - `AffiliateEventType` includes `sale_reversal`
- Verification:
  - `pnpm test -- packages/db/src/schema.test.ts apps/web/src/lib/impact.test.ts apps/web/src/lib/affiliate-events.test.ts apps/web/src/tests/stripe.test.ts`
  - `pnpm typecheck`

## Assumptions

- Automatic reversal happens on `charge.dispute.created`, not on later dispute resolution events.
- Full commission reversal is correct even for partial Stripe disputes.
- No restore flow is implemented for won disputes.
- Impact late/locked reversals that cannot be applied automatically are treated as permanent manual follow-up.
