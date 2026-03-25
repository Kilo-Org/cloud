# Impact.com Affiliate Tracking Integration

## Overview

Replace Rewardful with impact.com for affiliate tracking. Uses a **custom server-side API integration** (POST to impact.com `/Conversions/` endpoint) with a parent-child event structure:

- **Lead** (parent): User sign-up
- **Sale** (child): KiloClaw subscription created (`billing_reason=subscription_create`)
- **Re-subscription** (child): KiloClaw subscription renewal (`billing_reason=subscription_cycle`)
- **Cancellation**: Reversal when KiloClaw subscription is deleted

KiloClaw-only scope for now. Kilo Pass, org seats, and one-time payments are excluded.

---

## Environment Variables

New variables required (server-side unless noted):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_IMPACT_UTT_URL` | UTT script URL (e.g., `https://utt.impactcdn.com/{UUID}.js`) |
| `IMPACT_ACCOUNT_SID` | impact.com Account SID for API authentication |
| `IMPACT_AUTH_TOKEN` | impact.com Auth Token for API authentication |
| `IMPACT_CAMPAIGN_ID` | Program/Campaign ID |
| `IMPACT_LEAD_EVENT_TYPE_ID` | Event Type ID for Lead (sign-up) |
| `IMPACT_SALE_EVENT_TYPE_ID` | Event Type ID for Sale (first subscription) |
| `IMPACT_RESUB_EVENT_TYPE_ID` | Event Type ID for Re-subscription (renewal) |

---

## Phase 1: Spec Files

### Create `.specs/kiloclaw-affiliate-tracking.md`

Business rules only, no implementation details. Content:

```markdown
# KiloClaw Affiliate Tracking

## Status

Draft -- created 2025-07-XX.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Overview

KiloClaw participates in an affiliate tracking program that rewards
partners for referring users who become paying subscribers. The program
tracks four conversion event types across the user and subscription
lifecycle.

## Rules

### Event Types

1. The system MUST track four conversion event types:
   a. **Lead**: captured when a referred user creates an account.
   b. **Sale**: captured when a referred user's first subscription
      invoice is paid.
   c. **Re-subscription**: captured when a referred user's recurring
      subscription invoice is paid.
   d. **Cancellation**: captured when a referred user's subscription
      is terminated, to reverse pending commissions.

### Referral Capture

1. The system MUST capture the affiliate provider's referral identifier
   from the landing page when a visitor arrives via an affiliate link.
2. The captured referral identifier MUST be stored in a first-party
   browser cookie for retrieval during subsequent server-side
   operations.
3. Cookie lifetime SHOULD match the affiliate program's configured
   referral window (typically 30 days).
4. The referral identifier MUST be persisted server-side so that
   webhook-driven events (invoice payments, cancellations) can
   retrieve it without access to the user's browser.

### Attribution Model

1. Attribution is captured at two scopes:
   a. **User-level**: recorded at sign-up for Lead events.
   b. **Subscription-level**: recorded at checkout for Sale,
      Re-subscription, and Cancellation events.
2. A single user MAY have separate attributions from different
   affiliates for different subscriptions. When multiple KiloClaw
   instances per user are supported, each instance's subscription
   MUST independently carry its own affiliate attribution.
3. Once captured, attribution for a given scope (user or specific
   subscription) MUST NOT be overwritten by a subsequent referral.
4. A single user MAY hold attributions from multiple affiliate
   providers simultaneously (one per provider per scope).

### Conversion Reporting

1. The system MUST report Lead events to the affiliate provider when
   a referred user creates an account.
2. The system MUST report Sale events when a referred subscription's
   first invoice is paid.
3. The system MUST report Re-subscription events when a referred
   subscription's renewal invoice is paid.
4. The system MUST report Cancellation events when a referred
   subscription is terminated.
5. Conversion reporting MUST NOT block or delay primary business
   operations (sign-up, checkout, billing). Reports are fire-and-forget;
   failures MUST be logged for operational visibility but MUST NOT
   cause user-facing errors.
6. Each conversion report MUST include the affiliate provider's
   referral identifier and a customer identifier.

### Scope

1. Only KiloClaw subscriptions are tracked. Other products (Kilo Pass,
   organization seats, credit top-ups) are excluded from affiliate
   tracking.
```

### Update `.specs/kiloclaw-billing.md`

Replace line 110-111:

```
6. The system SHOULD include referral tracking data in checkout sessions
   when a referral cookie is present.
```

With:

```
6. The system SHOULD include affiliate referral tracking data in
   checkout sessions when a referral cookie is present. See
   `.specs/kiloclaw-affiliate-tracking.md` for affiliate tracking
   rules.
```

---

## Phase 2: Remove Rewardful

### Delete files
- `src/lib/rewardful.ts` — server-side cookie reader
- `src/types/rewardful.d.ts` — Window type extension

### Remove from `src/app/layout.tsx` (lines 117-128)
Delete the entire Rewardful script block (the `<Script id="rewardful-queue">` inline script and the `<Script src="https://r.wdfl.co/rw.js">` tag).

### Remove from `src/app/(app)/claw/components/CreateInstanceCard.tsx` (lines 167-171)
Delete the `rewardful('convert', { email })` call in the `onSuccess` callback. (Impact Lead tracking will happen server-side at signup instead.)

### Remove Rewardful from checkout sessions

All these files import `getRewardfulReferral` and use it to set `client_reference_id` and/or `metadata: { rewardful: 'false' }` on Stripe checkout sessions:

| File | Lines | What to remove |
|---|---|---|
| `src/routers/kiloclaw-router.ts` | 41, 789-794, 1261-1266 | Import + `client_reference_id` in earlybird + subscription checkouts |
| `src/routers/kilo-pass-router.ts` | 42, 946-951, 971 | Import + `client_reference_id` + `rewardful: 'false'` metadata |
| `src/lib/stripe.ts` | 62, 941-946, 964, 1030-1035, 1135-1140, 1158 | Import + all `client_reference_id` + `rewardful: 'false'` metadata across three checkout flows |
| `src/lib/organizations/organization-auto-top-up.ts` | 9, 29-34, 52 | Import + `client_reference_id` + `rewardful: 'false'` metadata |

### Update tests
- `src/routers/kiloclaw-billing-router.test.ts` — remove Rewardful mock (lines 50-52, 158-162, 348-366)
- `src/routers/kilo-pass-router.test.ts` — remove `rewardful: 'false'` assertion (line 1540)

---

## Phase 3: Database Schema — `user_affiliate_tracking`

### New table in `packages/db/src/schema.ts`

```typescript
export const user_affiliate_tracking = pgTable(
  'user_affiliate_tracking',
  {
    id: uuid()
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .notNull(),
    kilo_user_id: text().notNull(),
    provider: text().notNull(),          // affiliate provider: 'impact', etc.
    referral_id: text().notNull(),       // provider's tracking identifier (generic)
    resource_type: text().notNull(),     // 'user' (Lead) or 'subscription' (Sale)
    resource_id: text().notNull(),       // kilo_user_id for 'user', stripe_subscription_id for 'subscription'
    captured_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('UQ_user_affiliate_tracking_provider_resource').on(
      table.provider,
      table.resource_type,
      table.resource_id,
    ),
    index('IDX_user_affiliate_tracking_kilo_user_id').on(table.kilo_user_id),
  ]
);
```

**Design rationale:**

- **`provider`**: Identifies the affiliate provider ('impact'). Extensible to future providers.
- **`referral_id`**: Generic name for whatever tracking identifier the provider uses (impact.com calls it Click ID / `im_ref`, Rewardful called it a referral UUID, other providers have their own names).
- **`resource_type` + `resource_id`**: Polymorphic reference that avoids nullable columns in unique constraints.
  - For user-level (Lead): `resource_type='user'`, `resource_id=kilo_user_id`
  - For subscription-level (Sale): `resource_type='subscription'`, `resource_id=stripe_subscription_id`
- **Surrogate PK (`id`)**: Since there's no single natural key, a UUID PK avoids issues with composite keys and works well with the existing pattern for PostHog incremental sync.
- **Unique on `(provider, resource_type, resource_id)`**: Ensures one attribution per provider per resource. A user can have:
  - One user-level row per provider (Lead)
  - One row per subscription per provider (Sale)
  - Different subscriptions can have different referral_ids (per-instance attribution)

**Lookup patterns:**

| Use case | Query |
|---|---|
| Lead: was this user referred? | `WHERE kilo_user_id = X AND provider = 'impact' AND resource_type = 'user'` |
| Sale: was this subscription referred? | `WHERE resource_type = 'subscription' AND resource_id = <stripe_sub_id> AND provider = 'impact'` |
| Admin: all attributions for a user | `WHERE kilo_user_id = X` |

### Generate migration

```bash
pnpm drizzle generate
```

### GDPR compliance

Update `softDeleteUser` in `src/lib/user.ts` to delete all rows from `user_affiliate_tracking` where `kilo_user_id` matches. Add corresponding test in `src/lib/user.test.ts`.

---

## Phase 4: Client-Side — UTT Script + Click ID Capture

### Replace Rewardful block in `src/app/layout.tsx`

Replace the deleted Rewardful block with the impact.com UTT:

```tsx
{process.env.NEXT_PUBLIC_IMPACT_UTT_URL && (
  <>
    <Script id="impact-utt" strategy="beforeInteractive">
      {`(function(a,b,c,d,e,f,g){e['ire_o']=c;e[c]=e[c]||function(){(e[c].a=e[c].a||[]).push(arguments)};f=d.createElement(b);g=d.getElementsByTagName(b)[0];f.async=1;f.src=a;g.parentNode.insertBefore(f,g);})('${process.env.NEXT_PUBLIC_IMPACT_UTT_URL}','script','ire',document,window);`}
    </Script>
    <Script id="impact-click-capture" strategy="afterInteractive">
      {`ire('generateClickId',function(c){if(c){document.cookie='impact_click_id='+encodeURIComponent(c)+';path=/;max-age=2592000;SameSite=Lax'+(location.protocol==='https:'?';Secure':'')}});`}
    </Script>
  </>
)}
```

This:
1. Loads the UTT script (same pattern as Rewardful's `rw.js`)
2. Uses `ire('generateClickId', callback)` to capture the `im_ref` Click ID
3. Stores it in a first-party cookie `impact_click_id` (30-day expiry, matching typical referral window)

### Type declaration — `src/types/impact.d.ts`

Replace `src/types/rewardful.d.ts` with:

```typescript
declare global {
  interface Window {
    ire?: (...args: unknown[]) => void;
  }
}
```

### Identify function (authenticated pages)

_Deferred to follow-up._ On pages where the user is authenticated, call `ire('identify', ...)` for cross-device attribution. Not required for core integration.

---

## Phase 5: Server-Side Infrastructure — `src/lib/impact.ts`

### Cookie reader

```typescript
import 'server-only';
import { cookies } from 'next/headers';

const IMPACT_COOKIE = 'impact_click_id';

export async function getImpactClickId(): Promise<string | undefined> {
  try {
    const jar = await cookies();
    const value = jar.get(IMPACT_COOKIE)?.value;
    return value && value.length > 0 ? value : undefined;
  } catch (error) {
    console.warn('Failed to read impact click ID cookie', error);
    return undefined;
  }
}
```

### Conversions API client

```typescript
import 'server-only';

const IMPACT_API_BASE = 'https://api.impact.com/Advertisers';

type TrackConversionParams = {
  eventTypeId: string;
  clickId: string;
  customerId: string;
  orderId: string;
  customerEmail?: string;
  currencyCode?: string;
  eventDate?: string;
  items?: Array<{
    sku: string;
    name: string;
    category: string;
    quantity: number;
    subTotal: number;
  }>;
};

export async function trackImpactConversion(params: TrackConversionParams): Promise<void> {
  const accountSid = process.env.IMPACT_ACCOUNT_SID;
  const authToken = process.env.IMPACT_AUTH_TOKEN;
  const campaignId = process.env.IMPACT_CAMPAIGN_ID;

  if (!accountSid || !authToken || !campaignId) return;

  const body = new URLSearchParams();
  body.append('CampaignId', campaignId);
  body.append('EventTypeId', params.eventTypeId);
  body.append('ClickId', params.clickId);
  body.append('CustomerId', params.customerId);
  body.append('OrderId', params.orderId);
  body.append('EventDate', params.eventDate ?? new Date().toISOString());
  body.append('CurrencyCode', params.currencyCode ?? 'USD');

  if (params.customerEmail) {
    body.append('CustomerEmail', params.customerEmail);
  }

  if (params.items) {
    params.items.forEach((item, i) => {
      const n = i + 1;
      body.append(`ItemSku${n}`, item.sku);
      body.append(`ItemName${n}`, item.name);
      body.append(`ItemCategory${n}`, item.category);
      body.append(`ItemQuantity${n}`, String(item.quantity));
      body.append(`ItemSubTotal${n}`, item.subTotal.toFixed(2));
    });
  }

  const url = `${IMPACT_API_BASE}/${accountSid}/Conversions`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      console.error(`Impact conversion API error: ${response.status}`, await response.text());
    }
  } catch (error) {
    // Fire-and-forget; never block the main flow
    console.error('Impact conversion API call failed', error);
  }
}
```

Key design decisions:
- **Fire-and-forget**: The API call never blocks or throws. Affiliate tracking is supplementary — checkout/signup must never fail because impact.com is down.
- **No retry logic in v1**: impact.com recommends retries for 5XX. Can add a simple retry wrapper later or use a queue. For now, failures are logged.
- Standard HTTP Basic auth per impact.com docs.

---

## Phase 6: Lead Tracking (Sign-Up)

### Where: `src/lib/user.ts` — `createOrUpdateUser()`

After the user is created (line ~320, after the DB transaction), and before PostHog capture:

1. Read the `impact_click_id` cookie via `getImpactClickId()`
2. If present, insert a user-level row into `user_affiliate_tracking`
3. Fire the Lead conversion to impact.com API

```typescript
// After savedUser is created, before PostHog capture
const impactClickId = await getImpactClickId();
if (impactClickId) {
  // Persist user-level attribution for Lead event
  await db
    .insert(user_affiliate_tracking)
    .values({
      kilo_user_id: savedUser.id,
      provider: 'impact',
      referral_id: impactClickId,
      resource_type: 'user',
      resource_id: savedUser.id,
    })
    .onConflictDoNothing(); // idempotent

  // Track Lead conversion (fire-and-forget)
  const leadEventTypeId = process.env.IMPACT_LEAD_EVENT_TYPE_ID;
  if (leadEventTypeId) {
    trackImpactConversion({
      eventTypeId: leadEventTypeId,
      clickId: impactClickId,
      customerId: savedUser.id,
      orderId: `lead-${savedUser.id}`,
      customerEmail: savedUser.google_user_email,
    }).catch(() => {}); // swallow — logged internally
  }
}
```

The `orderId: lead-${savedUser.id}` serves as the parent event ID that child Sale events reference.

---

## Phase 7: Subscription-Level Attribution at Checkout

### Where: `src/routers/kiloclaw-router.ts` — `createSubscriptionCheckout`

At checkout time, read the cookie and:
1. Store `impact_click_id` in Stripe subscription metadata (so it flows through to `invoice.paid` webhook)
2. After checkout session is created, persist a subscription-level attribution row

Since we don't have the `stripe_subscription_id` at checkout time (it's created asynchronously by Stripe), the subscription-level DB row is inserted **in the webhook handler** when `customer.subscription.created` fires, not at checkout. The cookie is passed through Stripe metadata as a bridge.

```typescript
// In createSubscriptionCheckout
const impactClickId = await getImpactClickId();

const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  customer: stripeCustomerId,
  // ... existing config ...
  subscription_data: {
    metadata: {
      type: 'kiloclaw',
      plan: input.plan,
      kiloUserId: ctx.user.id,
      ...(impactClickId && { impact_click_id: impactClickId }),
    },
  },
  // ...
});
```

### Where: `src/lib/kiloclaw/stripe-handlers.ts` — `handleKiloClawSubscriptionCreated()`

After the subscription is created in the DB, persist subscription-level attribution:

```typescript
// After the subscription upsert in the transaction
const impactClickId = subscription.metadata?.impact_click_id;
if (impactClickId) {
  await db
    .insert(user_affiliate_tracking)
    .values({
      kilo_user_id: kiloUserId,
      provider: 'impact',
      referral_id: impactClickId,
      resource_type: 'subscription',
      resource_id: subscription.id,
    })
    .onConflictDoNothing();
}
```

This ensures subscription-level attribution is persisted with the actual Stripe subscription ID, and works correctly for multi-instance scenarios where each instance can be attributed differently.

---

## Phase 8: Sale + Re-subscription Tracking (invoice.paid)

### Add KiloClaw branch to `invoice.paid` handler in `src/lib/stripe.ts`

Currently, KiloClaw invoices fall through silently (no handler). The unused `invoiceLooksLikeKiloClawByPriceId()` classifier already exists at `src/lib/kiloclaw/stripe-invoice-classifier.server.ts:25`.

Add a new branch after the Kilo Pass check and before auto-topup:

```typescript
case 'invoice.paid': {
  const invoice = event.data.object;

  // Existing: Kilo Pass handler
  if (invoiceLooksLikeKiloPassByPriceId(invoice)) {
    await handleKiloPassInvoicePaid({ eventId: event.id, invoice, stripe: client });
    break;
  }

  // NEW: KiloClaw — track subscription conversions to impact.com
  if (invoiceLooksLikeKiloClawByPriceId(invoice)) {
    await trackKiloClawInvoiceForImpact(invoice);
    // Don't break — fall through to existing handlers if needed
  }

  // Existing: Auto-topup handlers...
}
```

### New function: `trackKiloClawInvoiceForImpact()`

Location: `src/lib/kiloclaw/impact-tracking.ts` (new file)

```typescript
export async function trackKiloClawInvoiceForImpact(invoice: Stripe.Invoice): Promise<void> {
  const billingReason = invoice.billing_reason;
  const isFirstSubscription = billingReason === 'subscription_create';
  const isRenewal = billingReason === 'subscription_cycle';

  if (!isFirstSubscription && !isRenewal) return;

  // Resolve the Stripe subscription ID from the invoice
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id;
  if (!subscriptionId) return;

  // Look up subscription-level attribution from DB
  const attribution = await db.query.user_affiliate_tracking.findFirst({
    where: and(
      eq(user_affiliate_tracking.resource_type, 'subscription'),
      eq(user_affiliate_tracking.resource_id, subscriptionId),
      eq(user_affiliate_tracking.provider, 'impact'),
    ),
  });

  if (!attribution) return; // Subscription was not affiliate-referred

  const eventTypeId = isFirstSubscription
    ? process.env.IMPACT_SALE_EVENT_TYPE_ID
    : process.env.IMPACT_RESUB_EVENT_TYPE_ID;

  if (!eventTypeId) return;

  const amountDollars = (invoice.amount_paid ?? 0) / 100;
  const description = invoice.lines?.data?.[0]?.description ?? 'KiloClaw Subscription';

  await trackImpactConversion({
    eventTypeId,
    clickId: attribution.referral_id,
    customerId: attribution.kilo_user_id,
    orderId: invoice.id,
    customerEmail: invoice.customer_email ?? undefined,
    currencyCode: (invoice.currency ?? 'usd').toUpperCase(),
    eventDate: invoice.finalized_at
      ? new Date(invoice.finalized_at * 1000).toISOString()
      : undefined,
    items: [{
      sku: 'kiloclaw-subscription',
      name: description,
      category: 'KiloClaw',
      quantity: 1,
      subTotal: amountDollars,
    }],
  });
}
```

---

## Phase 9: Cancellation Tracking

### Where: `src/lib/kiloclaw/stripe-handlers.ts` — `handleKiloClawSubscriptionDeleted()`

After the DB update (line ~685), add impact.com reversal tracking:

```typescript
// Look up subscription-level attribution
const attribution = await db.query.user_affiliate_tracking.findFirst({
  where: and(
    eq(user_affiliate_tracking.resource_type, 'subscription'),
    eq(user_affiliate_tracking.resource_id, subscription.id),
    eq(user_affiliate_tracking.provider, 'impact'),
  ),
});

if (attribution) {
  const saleEventTypeId = process.env.IMPACT_SALE_EVENT_TYPE_ID;
  if (saleEventTypeId) {
    const latestInvoiceId = typeof subscription.latest_invoice === 'string'
      ? subscription.latest_invoice
      : subscription.latest_invoice?.id;

    if (latestInvoiceId) {
      await trackImpactConversion({
        eventTypeId: saleEventTypeId,
        clickId: attribution.referral_id,
        customerId: kiloUserId,
        orderId: latestInvoiceId,
        items: [{
          sku: 'kiloclaw-subscription',
          name: 'KiloClaw Subscription Cancellation',
          category: 'KiloClaw',
          quantity: 1,
          subTotal: 0,
        }],
      });
    }
  }
}
```

**Note:** The exact reversal mechanism depends on how impact.com is configured. If they expect a separate reversal API endpoint rather than a zero-amount conversion, this will need adjustment during end-to-end testing with impact.com's team.

---

## Phase 10: Earlybird + Non-KiloClaw Checkout Cleanup

The earlybird checkout in `src/routers/kiloclaw-router.ts` (line ~789) previously passed `client_reference_id` for Rewardful. Since earlybird is a one-time payment (not a subscription) and is out of scope for impact.com tracking, simply remove the Rewardful reference. No impact.com replacement is needed here.

Same applies to non-KiloClaw checkout flows (Kilo Pass, org seats, credit top-ups) — remove Rewardful references, no impact.com replacement needed.

---

## Phase 11: Tests

### Unit tests for `src/lib/impact.ts`
- `getImpactClickId()` returns the cookie value when set, `undefined` when not
- `trackImpactConversion()` sends correct payload to the API
- `trackImpactConversion()` does not throw on API errors

### Update `src/routers/kiloclaw-billing-router.test.ts`
- Remove Rewardful mock (`@/lib/rewardful` mock at lines 50-52)
- Add mock for `@/lib/impact` if testing click_id passthrough in checkout metadata
- Update the "includes client_reference_id when rewardful cookie is set" test → replace with "includes impact_click_id in subscription metadata when cookie is set"

### Update `src/routers/kilo-pass-router.test.ts`
- Remove `rewardful: 'false'` assertion (line 1540)

### New tests for impact tracking
- `src/lib/kiloclaw/impact-tracking.test.ts`:
  - Tracks Sale for `subscription_create` billing reason
  - Tracks Re-subscription for `subscription_cycle` billing reason
  - Skips tracking when no attribution exists for subscription
  - Skips when env vars are not configured

### GDPR test
- `src/lib/user.test.ts` — verify `softDeleteUser` deletes from `user_affiliate_tracking`

---

## Files Changed Summary

| Action | File | Description |
|---|---|---|
| **Create** | `.specs/kiloclaw-affiliate-tracking.md` | Business rules spec for affiliate tracking |
| **Modify** | `.specs/kiloclaw-billing.md` | Reference affiliate tracking spec |
| **Delete** | `src/lib/rewardful.ts` | Rewardful server module |
| **Delete** | `src/types/rewardful.d.ts` | Rewardful Window type |
| **Create** | `src/lib/impact.ts` | Cookie reader + Conversions API client |
| **Create** | `src/types/impact.d.ts` | Window type for `ire()` |
| **Create** | `src/lib/kiloclaw/impact-tracking.ts` | KiloClaw invoice → impact.com conversion tracker |
| **Modify** | `packages/db/src/schema.ts` | Add `user_affiliate_tracking` table |
| **Create** | `packages/db/src/migrations/0059_*.sql` | Migration for new table |
| **Modify** | `src/app/layout.tsx` | Replace Rewardful with UTT script |
| **Modify** | `src/app/(app)/claw/components/CreateInstanceCard.tsx` | Remove `rewardful('convert')` |
| **Modify** | `src/lib/user.ts` | Add Lead tracking + user-level attribution at signup |
| **Modify** | `src/lib/stripe.ts` | Remove Rewardful import, add KiloClaw invoice.paid branch |
| **Modify** | `src/routers/kiloclaw-router.ts` | Remove Rewardful, add `impact_click_id` to subscription metadata |
| **Modify** | `src/routers/kilo-pass-router.ts` | Remove Rewardful references |
| **Modify** | `src/lib/organizations/organization-auto-top-up.ts` | Remove Rewardful references |
| **Modify** | `src/lib/kiloclaw/stripe-handlers.ts` | Persist subscription-level attribution + cancellation tracking |
| **Modify** | `src/lib/user.ts` (`softDeleteUser`) | GDPR: delete attribution on user deletion |
| **Modify** | `src/routers/kiloclaw-billing-router.test.ts` | Update Rewardful → impact mocks/assertions |
| **Modify** | `src/routers/kilo-pass-router.test.ts` | Remove Rewardful assertion |

---

## Sequencing

1. Spec files (Phase 1)
2. Schema change + migration (Phase 3) — foundation
3. `src/lib/impact.ts` (Phase 5) — core infrastructure
4. Remove Rewardful (Phase 2) + add UTT (Phase 4) — swap client-side tracking
5. Lead tracking in signup (Phase 6)
6. Subscription-level attribution at checkout + subscription.created (Phase 7)
7. Sale/Re-subscription tracking in invoice.paid (Phase 8)
8. Cancellation tracking (Phase 9)
9. Non-KiloClaw cleanup (Phase 10)
10. Tests (Phase 11)

---

## Out of Scope (Future)

- `ire('identify')` on authenticated pages for cross-device attribution
- Tracking non-KiloClaw products (Kilo Pass, org seats, one-time payments)
- Retry logic / queue for failed impact.com API calls
- Promo code passthrough to impact.com (`OrderPromoCode` field)
