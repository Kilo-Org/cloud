# Referral happy path — human verification script

## Goal

Prove that:

1. an eligible **referrer** can get a referral link,
2. a brand-new **referee** signs up through that link,
3. the referral touch is recorded,
4. the referee’s **first paid personal KiloClaw conversion** is attributed to the referral,
5. both referral rewards are granted,
6. both rewards are applied in the happy path.

> Use this in staging or any environment with Impact Advocate configured.
> A fully local end-to-end happy path is not sufficient right now because local verification showed `/api/impact-advocate/token` returning `503` when Advocate is unconfigured.

## Preconditions

Before starting, confirm all of these are true:

- Environment has:
  - Impact Advocate configured
  - Impact conversion reporting configured
  - test payments available
- You have read-only DB access for verification
- You can log in as two different test users
- The **referrer already has an active eligible personal KiloClaw subscription**
  - this matters so the referrer reward can be **applied immediately** instead of staying `pending`

## Running locally via ngrok

If you are testing against a locally running app instead of staging, use an HTTPS ngrok URL rather than `http://localhost:3000`, because the Impact Advocate widget may require an allowlisted non-localhost origin.

Basic setup:

1. Start the app locally:

```bash
pnpm dev:start
```

2. Start ngrok in a separate terminal:

```bash
ngrok http 3000
```

3. Copy the HTTPS forwarding URL from ngrok, then set it as the app base URL and restart the app:

```bash
export APP_URL_OVERRIDE=https://<your-ngrok-subdomain>.ngrok-free.app
pnpm dev:stop
pnpm dev:start
```

4. Open the site through the ngrok URL, not localhost.

Notes:

- Ask the Impact / SaaSquatch admin to allowlist the exact ngrok origin if the referral widget is blocked by CORS.
- If the ngrok hostname changes, update `APP_URL_OVERRIDE`, restart the app, and re-allowlist the new origin if needed.
- For payment verification, keep the entire flow on the same ngrok origin so auth and Stripe redirects stay consistent.

## Test accounts

Use two fresh accounts:

- **Referrer**: `qa-referrer-<date>@example.com`
- **Referee**: `qa-referee-<date>@example.com`

Use unique emails each run.

## Step 1: Prepare the referrer

1. Sign in as the **referrer**
2. Go to **Profile**
3. Confirm the **Referral Program** section is visible
4. Open the referral widget / referral sharing UI
5. Copy the generated referral link

### Expected

- The widget loads successfully
- No error banner is shown
- You can copy a referral link
- The link contains referral params, typically including:
  - `_saasquatch`
  - `rsCode`
  - optionally medium params like:
    - `rsShareMedium`
    - `rsEngagementMedium`

### Capture

- Screenshot of Profile page with Referral Program visible
- Screenshot of the widget or copied link UI
- The copied referral URL

## Step 2: Sign up the referee through the referral link

1. Open a fresh incognito/private window
2. Paste the copied referral link
3. Complete signup as the **referee**
4. Complete any required onboarding
5. Land in the signed-in app

### Expected

- Signup succeeds normally
- Referral params survive auth/onboarding redirects
- The user reaches the app successfully
- No auth-flow breakage

### Capture

- Final app URL after signup
- Screenshot of successful logged-in state

## Step 3: Verify referral touch capture in the DB

Look up both users:

```sql
select id, google_user_email, created_at
from kilocode_users
where google_user_email in (
  'qa-referrer-<date>@example.com',
  'qa-referee-<date>@example.com'
)
order by google_user_email;
```

Save:

- `<referrer_user_id>`
- `<referee_user_id>`

Now verify the referee touch:

```sql
select
  id,
  user_id,
  touch_type,
  provider,
  rs_code,
  rs_share_medium,
  rs_engagement_medium,
  touched_at,
  expires_at
from kiloclaw_attribution_touches
where user_id = '<referee_user_id>'
order by touched_at desc;
```

### Expected

At least one row exists with:

- `touch_type = 'referral'`
- `provider = 'impact_advocate'`
- `rs_code` populated
- `expires_at` populated
- the touch is attached to the referee user

Optional relationship check:

```sql
select
  referee_user_id,
  referrer_user_id,
  source_touch_id,
  created_at
from kiloclaw_referrals
where referee_user_id = '<referee_user_id>';
```

### Expected

- One row linking referee to referrer

## Step 4: Verify referrer participant exists

```sql
select
  user_id,
  advocate_id,
  advocate_account_id,
  opaque_referral_identifier,
  registration_state,
  registered_at,
  last_error_code
from impact_advocate_participants
where user_id = '<referrer_user_id>';
```

### Expected

- row exists
- `registration_state = 'registered'`
- `opaque_referral_identifier` is populated

## Step 5: Purchase the referee’s first paid personal KiloClaw subscription

1. Stay signed in as the **referee**
2. Go through the normal personal KiloClaw purchase flow
3. Complete the first real/test payment
4. Wait for billing side effects / webhook processing to complete

### Expected

- Purchase succeeds
- This is the referee’s **first monetized personal** KiloClaw paid period
- No support override is needed
- No affiliate flow should win over the referral in this happy path

### Capture

- Screenshot of successful purchase / active subscription UI
- Any order/payment ID shown in the UI or logs

## Step 6: Verify the referral conversion in the DB

```sql
select
  id,
  referee_user_id,
  referrer_user_id,
  winning_touch_type,
  qualified,
  disqualification_reason,
  source_payment_id,
  converted_at,
  created_at
from kiloclaw_referral_conversions
where referee_user_id = '<referee_user_id>'
order by created_at desc
limit 1;
```

Save `<conversion_id>`.

### Expected

- row exists
- `winning_touch_type = 'referral'`
- `qualified = true`
- `disqualification_reason is null`

## Step 7: Verify both beneficiary decisions were granted

```sql
select
  beneficiary_role,
  outcome,
  reason,
  months_granted
from kiloclaw_referral_reward_decisions
where conversion_id = '<conversion_id>'
order by beneficiary_role;
```

### Expected

Exactly two rows:

- `referee` -> `outcome = 'granted'`
- `referrer` -> `outcome = 'granted'`

And:

- `months_granted = 1` for both
- `reason is null`

## Step 8: Verify both rewards were created and applied

```sql
select
  id,
  beneficiary_user_id,
  beneficiary_role,
  status,
  months_granted,
  applied_at,
  expires_at
from kiloclaw_referral_rewards
where conversion_id = '<conversion_id>'
order by beneficiary_role;
```

### Expected

Exactly two rows:

- one for the referee
- one for the referrer

And in the happy path:

- both have `status = 'applied'`
- both have `months_granted = 1`
- both have `applied_at` populated

Now verify reward application records:

```sql
select
  reward_id,
  subscription_id,
  applied_at,
  created_at
from kiloclaw_referral_reward_applications
where reward_id in (
  select id
  from kiloclaw_referral_rewards
  where conversion_id = '<conversion_id>'
)
order by created_at;
```

### Expected

- application rows exist for both rewards

## Step 9: Verify billing moved the renewal boundary forward

Referee subscription:

```sql
select
  id,
  user_id,
  status,
  plan,
  current_period_end,
  credit_renewal_at
from kiloclaw_subscriptions
where user_id = '<referee_user_id>'
order by created_at desc
limit 1;
```

Referrer subscription:

```sql
select
  id,
  user_id,
  status,
  plan,
  current_period_end,
  credit_renewal_at
from kiloclaw_subscriptions
where user_id = '<referrer_user_id>'
order by created_at desc
limit 1;
```

### Expected

- both subscriptions are eligible personal subscriptions
- the next unpaid renewal boundary is delayed by roughly **1 month**
- in practice, you should see `current_period_end` and/or `credit_renewal_at` advanced compared with the pre-reward state

Optional log check:

```sql
select
  subscription_id,
  action,
  reason,
  created_at
from kiloclaw_subscription_change_log
where reason = 'referral_reward:applied'
  and subscription_id in (
    select id from kiloclaw_subscriptions
    where user_id in ('<referrer_user_id>', '<referee_user_id>')
  )
order by created_at desc;
```

### Expected

- entries exist showing reward application side effects

## Step 10: Verify Impact conversion reporting succeeded

```sql
select
  conversion_id,
  state,
  response_status_code,
  delivered_at,
  error
from impact_conversion_reports
where conversion_id = '<conversion_id>';
```

### Expected

- row exists
- `state = 'delivered'`
- `error is null`

## UI sanity check after reward application

1. Refresh the **referee** billing/subscription UI
2. Refresh the **referrer** billing/subscription UI

### Expected

- both accounts still load normally
- no broken billing state
- next renewal/billing date reflects the added month, if surfaced in UI

## Pass criteria

The happy path passes if all of the following are true:

- referrer can open referral sharing UI and copy a link
- referee can sign up via that link successfully
- referee has a stored referral touch
- conversion row exists for the referee’s first paid personal conversion
- conversion is:
  - `winning_touch_type = referral`
  - `qualified = true`
- two decision rows exist and both are `granted`
- two reward rows exist and both are `applied`
- reward application rows exist
- billing renewal boundary moved forward by 1 month
- Impact conversion report is `delivered`

## Fail examples

Treat the run as failed if any of these happen:

- referral widget does not load
- signup loses referral attribution through redirects
- no `impact_advocate` referral touch is stored
- conversion is recorded with:
  - `winning_touch_type = affiliate`
  - `winning_touch_type = none`
  - `qualified = false`
- either beneficiary decision is not `granted`
- either reward stays `pending` in this happy-path setup
- no reward application rows are created
- Impact report is `failed` or `retrying`
