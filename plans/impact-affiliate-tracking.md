# Impact.com Affiliate Tracking Integration for KiloClaw

## Context

Implementing Impact.com affiliate tracking for KiloClaw subscriptions. External partners drive traffic via tracking links and earn commissions on conversions. This replaces the existing Rewardful integration entirely.

### Events to Track (per Pierluigi's spec)

| Event       | Type          | Payout                     |
| ----------- | ------------- | -------------------------- |
| SIGNUP      | Lead (parent) | Stats-only, $0             |
| TRIAL_START | Sale (child)  | Stats-only or small payout |
| TRIAL_END   | Sale (child)  | Stats-only                 |
| SALE        | Sale (child)  | Commissionable             |

### Integration Architecture (Hybrid)

- **UTT (JavaScript)**: Installed on app.kilo.ai for cross-domain tracking and `identify` calls. Also needed on kilo.ai (separate codebase).
- **Server-side API**: Backend POSTs conversion events to Impact.com Conversions API on signup, trial start, trial end, and subscription payment. More reliable than client-side tracking (resistant to ad blockers/ITP).

---

## Implementation Steps

### 1. Remove Rewardful Integration

**Files to modify:**

- `src/lib/rewardful.ts` -- delete entirely
- `src/types/rewardful.d.ts` -- delete entirely
- `src/routers/kiloclaw-router.ts` ~line 1600-1605 -- remove `getRewardfulReferral()` call and `client_reference_id` from checkout session
- `src/app/layout.tsx` or wherever Rewardful's `rw.js` script is loaded -- remove the script tag
- `package.json` -- remove any Rewardful dependencies if present

### 2. Database Migration: Add `user_affiliate_attributions` Table

Rather than adding an Impact-specific column to `kilocode_users`, introduce a separate `user_affiliate_attributions` table. This decouples affiliate tracking from the user schema and allows us to onboard additional affiliate/tracking programs in the future without further migrations.

**File:** `packages/db/src/schema-types.ts`

Define a provider enum following the existing pattern (`const` object + derived type):

```typescript
export const AffiliateProvider = {
  Impact: 'impact',
} as const;

export type AffiliateProvider = (typeof AffiliateProvider)[keyof typeof AffiliateProvider];
```

New providers are added here as additional entries.

**File:** `packages/db/src/schema.ts`

```typescript
export const user_affiliate_attributions = pgTable(
  'user_affiliate_attributions',
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id),
    provider: text().notNull().$type<AffiliateProvider>(),
    tracking_id: text().notNull(), // provider-specific identifier (e.g. im_ref value for Impact)
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    // One attribution per provider per user (first-touch wins)
    unique('UQ_user_affiliate_attributions_user_provider').on(table.user_id, table.provider),
    index('IDX_user_affiliate_attributions_user_id').on(table.user_id),
    enumCheck('user_affiliate_attributions_provider_check', table.provider, AffiliateProvider),
  ]
);
```

Then run `pnpm drizzle generate` to create the migration.

**Design notes:**

- The `AffiliateProvider` enum is enforced at both the TypeScript level (`$type<>`) and the database level (`enumCheck`).
- The unique constraint on `(user_id, provider)` enforces first-touch attribution per provider. To record a tracking ID, use an upsert that no-ops on conflict.
- Querying a user's Impact tracking ID: `WHERE user_id = ? AND provider = 'impact'`.
- Adding a new provider later only requires adding a value to the `AffiliateProvider` enum and regenerating the migration.

**GDPR note:** The tracking ID is an opaque identifier, not PII. However, since it's associated with a user, update `softDeleteUser` in `src/lib/user.ts` to delete rows from this table on user deletion, and add a corresponding test.

### 3. Environment Variables

Add the following env vars (values will be provided by Impact.com after contract signing):

```env
# Impact.com API credentials
IMPACT_ACCOUNT_SID=           # Account SID from Impact.com dashboard
IMPACT_AUTH_TOKEN=            # Auth Token from Impact.com dashboard

# Impact.com Program/Campaign IDs
IMPACT_CAMPAIGN_ID=           # Campaign/Program ID

# Impact.com Event Type IDs (configured in Impact.com dashboard)
IMPACT_SIGNUP_EVENT_TYPE_ID=       # Lead event for user signup
IMPACT_TRIAL_START_EVENT_TYPE_ID=  # Sale event for trial start
IMPACT_TRIAL_END_EVENT_TYPE_ID=    # Sale event for trial end
IMPACT_SALE_EVENT_TYPE_ID=         # Sale event for KiloClaw payment (initial + renewals)

# Impact.com UTT identifier (for frontend)
NEXT_PUBLIC_IMPACT_UTT_ID=        # UUID for the UTT script URL (e.g. XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXXX)
```

**File:** Add these to `src/env.ts` (or equivalent env validation schema) -- make them optional so the app doesn't crash in environments where Impact isn't configured. Server-side vars use `z.string().optional()`, and the UTT ID uses `NEXT_PUBLIC_` prefix for client access.

### 4. Impact.com API Client (`src/lib/impact.ts`)

Create a server-side API client for Impact.com's Conversions API.

**Key functions:**

```typescript
// SHA-1 hash email for Impact.com (they apply additional HMAC on their end)
function hashEmailForImpact(email: string): string;

// Send a Lead conversion (SIGNUP)
async function trackSignupConversion(params: {
  clickId: string | null;
  customerId: string; // our user ID
  customerEmail: string; // raw email (will be hashed)
  eventDate: Date;
}): Promise<void>;

// Send a Sale conversion (TRIAL_START, TRIAL_END, SALE)
async function trackSaleConversion(params: {
  eventTypeId: string;
  clickId: string | null;
  customerId: string;
  customerEmail: string;
  orderId: string; // Stripe invoice ID or subscription ID
  amount: number; // in USD (decimal)
  currencyCode: string;
  eventDate: Date;
  itemCategory: string; // e.g. "kiloclaw-standard", "kiloclaw-trial"
  itemName: string; // e.g. "KiloClaw Standard Plan"
  promoCode?: string;
}): Promise<void>;
```

**API call format** (from Impact docs):

```
POST https://api.impact.com/Advertisers/{AccountSID}/Conversions
Authorization: Basic base64(AccountSID:AuthToken)
Content-Type: application/x-www-form-urlencoded

CampaignId=...&EventTypeId=...&ClickId=...&CustomerId=...&CustomerEmail=...&OrderId=...&ItemSubTotal1=...&ItemCategory1=...&ItemName1=...&ItemQuantity1=1&CurrencyCode=USD&EventDate=...
```

**Error handling:**

- Log failures but don't block the main flow (fire-and-forget with retry)
- Retry on 5xx responses (Impact.com recommends this)
- Gate all calls behind `IMPACT_ACCOUNT_SID` being set (no-op when not configured)

### 5. Frontend: Install UTT Script

**File:** `src/app/layout.tsx` (or the root layout)

Add the UTT script to the `<head>`:

```html
<script type="text/javascript">
  (function (a, b, c, d, e, f, g) {
    e['ire_o'] = c;
    e[c] =
      e[c] ||
      function () {
        (e[c].a = e[c].a || []).push(arguments);
      };
    f = d.createElement(b);
    g = d.getElementsByTagName(b)[0];
    f.async = 1;
    f.src = a;
    g.parentNode.insertBefore(f, g);
  })('https://utt.impactcdn.com/{NEXT_PUBLIC_IMPACT_UTT_ID}.js', 'script', 'ire', document, window);
</script>
```

Gate behind `NEXT_PUBLIC_IMPACT_UTT_ID` being set. The UTT ID is environment-specific (different for test vs production).

**Cross-domain note:** UTT installed on both kilo.ai (marketing site, separate codebase) and app.kilo.ai (this codebase) handles cross-domain tracking automatically. Impact.com configures the domains in their dashboard.

### 6. Frontend: `identify` Call on Authentication

After a user logs in or signs up, call the UTT `identify` function to bridge the user's identity for cross-device attribution.

**File:** Create a client component `src/components/ImpactIdentify.tsx` (or add to an existing authenticated layout wrapper)

```typescript
// Called once user is authenticated
ire('identify', {
  customerId: userId,
  customerEmail: sha1(userEmail), // SHA-1 hashed
  customProfileId: '', // UUID cookie if we generate one, or empty string
});
```

This should fire on every authenticated page load (in the root authenticated layout). Use the `ire` global injected by the UTT script.

**Type definition:** Add `src/types/impact.d.ts`:

```typescript
declare global {
  interface Window {
    ire?: (...args: unknown[]) => void;
  }
  function ire(...args: unknown[]): void;
}
```

### 7. Click ID Capture: Preserve `im_ref` Through Auth Flow

When a user arrives at app.kilo.ai with `?im_ref=...` (passed from kilo.ai or directly from an affiliate link), we need to persist it through the OAuth flow and store it in the `user_affiliate_attributions` table.

**Step 7a: Preserve through OAuth callback**

**File:** `src/lib/getSignInCallbackUrl.ts`

Add `im_ref` to the list of preserved query parameters (alongside existing `source` and `callbackPath`):

```typescript
const imRef = searchParams.get('im_ref');
if (imRef) url.searchParams.set('im_ref', imRef);
```

**Step 7b: Read im_ref after OAuth and store attribution**

**File:** `src/app/users/after-sign-in/` (the OAuth callback handler)

After successful authentication:

1. Read `im_ref` from the callback URL's query params
2. Upsert a row into `user_affiliate_attributions` with `provider = 'impact'` and the click ID (no-op on conflict to preserve first-touch)

**File:** `src/lib/user.ts` in `createOrUpdateUser()`

Add an optional `impactClickId` parameter. After the user row is created/updated, insert the attribution:

```typescript
if (impactClickId) {
  await db
    .insert(user_affiliate_attributions)
    .values({ user_id: userId, provider: 'impact', tracking_id: impactClickId })
    .onConflictDoNothing();
}
```

The unique constraint on `(user_id, provider)` enforces first-touch attribution automatically.

### 8. Track SIGNUP Event (Lead)

When a new user is created, fire a Lead conversion to Impact.com.

**File:** `src/lib/user.ts` in `createOrUpdateUser()`

After the user row is inserted (inside or just after the transaction), if this is a new user and they have an `impactClickId`:

```typescript
// Fire-and-forget, don't block user creation
trackSignupConversion({
  clickId: impactClickId,
  customerId: newUserId,
  customerEmail: args.google_user_email,
  eventDate: new Date(),
}).catch(err => console.error('Impact signup tracking failed:', err));
```

**Note:** This is the "Lead" event in Impact's parent-child structure. The Impact API correlates subsequent Sale events via `CustomerId`, so we don't need to store the returned action ID.

### 9. Track TRIAL_START Event

When a KiloClaw trial subscription is created.

**File:** `src/lib/kiloclaw/stripe-handlers.ts` (or wherever trial creation is handled)

Identify the code path where a trial subscription transitions to active. Look up the user's attribution and fire:

```typescript
const attribution = await getAffiliateAttribution(userId, 'impact');

trackSaleConversion({
  eventTypeId: env.IMPACT_TRIAL_START_EVENT_TYPE_ID,
  clickId: attribution?.tracking_id ?? null,
  customerId: user.id,
  customerEmail: user.google_user_email,
  orderId: stripeSubscriptionId,
  amount: 0, // trial is free
  currencyCode: 'usd',
  eventDate: new Date(),
  itemCategory: 'kiloclaw-trial',
  itemName: 'KiloClaw Trial',
});
```

### 10. Track TRIAL_END Event

When a KiloClaw trial subscription ends (either by converting to paid or expiring).

**File:** `src/lib/kiloclaw/stripe-handlers.ts`

In the subscription status change handler, when trial → active or trial → canceled:

```typescript
trackSaleConversion({
  eventTypeId: env.IMPACT_TRIAL_END_EVENT_TYPE_ID,
  clickId: attribution?.tracking_id ?? null,
  customerId: user.id,
  customerEmail: user.google_user_email,
  orderId: stripeSubscriptionId,
  amount: 0,
  currencyCode: 'usd',
  eventDate: new Date(),
  itemCategory: 'kiloclaw-trial-end',
  itemName: 'KiloClaw Trial End',
});
```

### 11. Track SALE Event (Commissionable)

When a KiloClaw subscription invoice is paid (initial purchase or renewal). This is the primary commissionable event.

**File:** `src/lib/kiloclaw/stripe-handlers.ts` in `handleKiloClawInvoicePaid()`

After successful invoice settlement, look up the attribution and fire the conversion:

```typescript
const attribution = await getAffiliateAttribution(userId, 'impact');

trackSaleConversion({
  eventTypeId: env.IMPACT_SALE_EVENT_TYPE_ID,
  clickId: attribution?.tracking_id ?? null,
  customerId: userId,
  customerEmail: user?.google_user_email ?? '',
  orderId: invoiceId, // Stripe invoice ID as unique order identifier
  amount: amountPaidUsd, // invoice.amount_paid converted to dollars
  currencyCode: invoice.currency ?? 'usd',
  eventDate: new Date(),
  itemCategory: `kiloclaw-${plan}`, // e.g. "kiloclaw-standard", "kiloclaw-commit"
  itemName: `KiloClaw ${plan} Plan`,
  promoCode: invoice.discount?.coupon?.name,
});
```

**Important:** This should fire for every `invoice.paid` event, not just the first one. Impact.com handles recurring commission logic internally based on their contract configuration, so they need to see each subscription payment.

### 12. Stripe Checkout Metadata Update

Pass the Impact click ID through Stripe checkout so it's available in webhook handlers even if the attribution table lookup fails.

**File:** `src/routers/kiloclaw-router.ts` in `createSubscriptionCheckout`

Look up the attribution and include the click ID in checkout metadata:

```typescript
const attribution = await getAffiliateAttribution(ctx.user.id, 'impact');

// In session creation:
subscription_data: {
  metadata: {
    type: 'kiloclaw',
    plan: input.plan,
    kiloUserId: ctx.user.id,
    impactClickId: attribution?.tracking_id ?? '',
  },
},
```

---

## File Summary

| Action   | File                                  | Description                                       |
| -------- | ------------------------------------- | ------------------------------------------------- |
| Delete   | `src/lib/rewardful.ts`                | Remove Rewardful integration                      |
| Delete   | `src/types/rewardful.d.ts`            | Remove Rewardful types                            |
| Edit     | `src/routers/kiloclaw-router.ts`      | Remove Rewardful, add Impact metadata to checkout |
| Edit     | `src/app/layout.tsx`                  | Remove Rewardful script, add UTT script           |
| Edit     | `packages/db/src/schema.ts`           | Add `user_affiliate_attributions` table           |
| Generate | `packages/db/src/migrations/`         | `pnpm drizzle generate`                           |
| Create   | `src/lib/impact.ts`                   | Impact.com API client                             |
| Create   | `src/types/impact.d.ts`               | TypeScript declarations for `ire()`               |
| Create   | `src/components/ImpactIdentify.tsx`   | Client component for identify call                |
| Edit     | `src/lib/getSignInCallbackUrl.ts`     | Preserve `im_ref` through OAuth                   |
| Edit     | `src/lib/user.ts`                     | Store attribution, track signup, GDPR cleanup     |
| Edit     | `src/lib/user.test.ts`                | Add GDPR test for `user_affiliate_attributions`   |
| Edit     | `src/lib/kiloclaw/stripe-handlers.ts` | Track trial + subscription events                 |
| Edit     | `src/env.ts`                          | Add Impact env var validation                     |

---

## Testing Plan

1. **Unit tests**: Test `hashEmailForImpact()`, test Impact API client with mocked HTTP
2. **GDPR test**: Verify `softDeleteUser` deletes `user_affiliate_attributions` rows
3. **Integration test**: End-to-end flow with test Impact.com account (provided during onboarding)
4. **Manual E2E test** (per Impact.com's testing requirements):
   - Create a test partner account in Impact dashboard
   - Click a test tracking link → verify `im_ref` captured
   - Sign up → verify Lead conversion appears in Impact
   - Start trial → verify Trial Start event
   - Pay subscription → verify Sale conversion with correct amount
   - Check Impact dashboard for attribution

---

## Open Items (Require Input From Impact.com)

These depend on values from your Impact.com account which aren't available until after contract + account setup:

1. **Account SID + Auth Token** -- from Impact.com dashboard Settings > API
2. **Campaign ID** -- from Impact.com after program creation
3. **Event Type IDs** -- for each event (SIGNUP, TRIAL_START, TRIAL_END, SALE). Impact's Implementation Engineer configures these.
4. **UTT Script ID** -- the UUID in the UTT script URL, from Settings > General > Tracking
5. **Cross-domain configuration** -- Impact configures kilo.ai + app.kilo.ai in their dashboard

---

## Sequencing

The implementation can be split into these PRs:

**PR 1: Database + API Client + Remove Rewardful**

- Schema migration (add `user_affiliate_attributions` table)
- Create `src/lib/impact.ts` API client
- Remove Rewardful code
- Add env vars to validation schema
- GDPR update

**PR 2: Click ID Capture + Frontend UTT**

- Install UTT script
- Preserve `im_ref` through auth flow
- Store affiliate attribution on user creation
- `identify` call component

**PR 3: Server-side Conversion Tracking**

- Signup Lead event
- Trial start/end events
- Sale event (initial + renewals)
- Checkout metadata update
