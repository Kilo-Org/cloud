# Churnkey Cancel Flow Integration

## What is Churnkey?

[Churnkey](https://churnkey.co) is a retention automation platform for self-serve subscription businesses. Its core features are:

- **Cancel Flows** — A hosted modal that intercepts cancellations with surveys, retention offers (pauses, discounts, plan switches), and cancel confirmation. Claims to reduce cancellation volume by ~54%.
- **Payment Recovery** — Automated retry logic and dunning campaigns (email/SMS/in-app) that recover failed payments without customer intervention. Claims to recover up to 89% of failed payments, lifting ARR ~10%.
- **Feedback AI** — Aggregates and categorizes freeform cancellation survey responses at scale using AI.
- **Adaptive Offers** — Personalized discount/retention offers informed by ML trained on millions of cancellation sessions.

Of particular interest to us: cancel flows (replacing our hand-built UIs), pause offers (e.g. for KiloPass in place of cancels), payment recovery (automated), and potentially custom discount offers (less urgent now, but more relevant with monthly Teams + Enterprise billing is a priority).

## Integration Overview

Integrate [Churnkey](https://churnkey.co) cancel flows into KiloCode to replace our hand-built cancellation UIs. Churnkey provides a hosted modal that handles cancellation surveys, retention offers (discounts, pauses, plan switches), and cancel confirmation — all configured from their dashboard.

https://docs.churnkey.co/cancel-flows/quick-start-guide

## What Churnkey Replaces

Today, each product has its own cancel UX:

- **KiloPass** (`CancelKiloPassSubscriptionModal` → `KiloPassCancellationFeedbackModal`): A 3-step modal flow — streak/bonus loss warning → cancellation reason survey + freeform feedback → confirm cancel. Feedback is written to our `userFeedback` table.
- **KiloClaw** (`CancelDialog`): A simple "are you sure?" confirmation dialog.
- **KiloPass Teams** (`CancelSubscriptionModal`): A simple "are you sure?" confirmation dialog.

Churnkey replaces all three UIs with its modal. The cancel modals and their state management are removed; the backend cancel routes stay.

## What We Need to Build

1. **Churnkey script loading** — Add the Churnkey JS snippet to the app (similar to how Rewardful is loaded in `layout.tsx`).
2. **HMAC auth endpoint** — A backend route that generates the Churnkey `authHash` (HMAC-SHA256 of the Stripe customer ID, using the Churnkey API key).
3. **A shared hook** that fetches the auth hash and calls `window.churnkey.init('show', ...)` — used by all three cancel flows.
4. **Wire it up** — Replace the cancel button handlers in each product to invoke Churnkey instead of opening the local modals. Delete the old modal components.

## Open Questions

### 1. Should Churnkey execute cancellations directly against Stripe, or should we keep that in our backend?

All three products have cancel logic that does more than `cancel_at_period_end: true`:

- KiloPass and KiloClaw both release subscription schedules first, with error handling for already-released/canceled schedules.
- All three update local DB state (`cancel_at_period_end`, clearing `scheduled_plan`/`scheduled_by`, etc.).

If Churnkey talks to Stripe directly, our local DB only gets updated asynchronously via webhooks, and our schedule-release error handling doesn't run.

The alternative is using Churnkey's `handleCancel` callback to call our existing backend routes — Churnkey handles the UI only, and we retain control of the actual cancellation. Downside: we'd also need `handleDiscount` / `handlePause` callbacks if we want to offer those, since Churnkey won't auto-apply offers when handler callbacks are defined.

### 2. Same question for offers (discounts, pauses, plan switches)

These are less risky than cancellation since we don't have complex local state around them. Letting Churnkey apply discounts/pauses directly in Stripe is plausible. A hybrid approach — let Churnkey handle offers directly, override only `handleCancel` — may be the pragmatic choice.

### 3. One Churnkey flow or separate flows per product?

KiloPass, KiloClaw, and Teams have different value props, pricing, and user profiles. Options:

- **Separate flows** configured in the Churnkey dashboard — cleanest, tailored copy/offers per product.
- **Single flow with customer segmentation** using a `product` attribute — works but harder to manage.

### 4. What happens to KiloPass cancellation feedback?

Today we write reasons + freeform text to our `userFeedback` table. With Churnkey, survey data lives in Churnkey's analytics dashboard instead. Options:

- Accept the trade-off — use Churnkey's dashboard for cancellation feedback.
- Forward feedback to our own table too, via the `handleCancel` callback which receives `surveyResponse` and `freeformFeedback`.

### 5. Can Churnkey reproduce the KiloPass streak/bonus warning?

The current cancel modal shows users they'll lose their streak and first-time subscriber bonus, with dynamic values (`currentStreakMonths`, `bonusPercent`). This would need to be recreated in the Churnkey flow builder — either as static copy or dynamic content driven by customer attributes. Need to verify Churnkey's templating supports this level of personalization.

### 6. Teams/Orgs: The Stripe customer is the org, not the user

For KiloPass and KiloClaw, the Stripe customer ID comes from the user's record. For Teams, it comes from the organization. The HMAC endpoint needs to handle both cases. Also need to verify Churnkey doesn't assume the person interacting with the modal is the Stripe customer — in Teams, it's an org owner acting on behalf of the org.
