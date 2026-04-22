# KiloClaw trial inactivity stop verification

## Goal

Manually verify the local implementation of personal trial inactivity auto-stop:

- applies only to **personal** `trialing` subscriptions
- stops compute for instances older than 48 hours when Snowflake shows no qualifying usage in the last 2 calendar days
- writes `kiloclaw_instances.inactive_trial_stopped_at`
- does **not** change billing entitlement fields
- clears the marker on explicit restart

---

## Prerequisites

### 1. Local services running

Start these services:

```bash
docker compose -f dev/docker-compose.yml up -d --wait postgres
pnpm --filter web dev
pnpm --filter kiloclaw dev
pnpm --filter kiloclaw-billing dev -- --test-scheduled
```

Notes:

- `services/kiloclaw` runs on port `8795`
- `services/kiloclaw-billing` runs on port `8807`
- `--test-scheduled` enables Wrangler's scheduled-event test endpoint at `/__scheduled`

### 2. Local DB migrated

The local database must include:

- `kiloclaw_instances.inactive_trial_stopped_at`

Apply your normal local migration flow before testing.

### 3. Secrets configured consistently

These must be present and aligned:

#### `apps/web`

- `INTERNAL_API_SECRET`
- `KILOCLAW_INTERNAL_API_SECRET`

#### `services/kiloclaw/.dev.vars`

- `KILOCLAW_INTERNAL_API_SECRET`

#### `services/kiloclaw-billing/.dev.vars`

- `INTERNAL_API_SECRET`
- `KILOCLAW_INTERNAL_API_SECRET`

Meaning:

- billing -> web uses `INTERNAL_API_SECRET`
- billing -> kiloclaw uses `KILOCLAW_INTERNAL_API_SECRET`

### 4. Snowflake config in billing worker

Populate `services/kiloclaw-billing/.dev.vars` with real Snowflake SQL API credentials.

Minimum required values:

```dotenv
TRIAL_INACTIVITY_STOP_ENABLED=true
TRIAL_INACTIVITY_STOP_DRY_RUN=true
SNOWFLAKE_ACCOUNT_HOST=...
SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER=...
SNOWFLAKE_USERNAME=...
SNOWFLAKE_ROLE=...
SNOWFLAKE_WAREHOUSE=...
SNOWFLAKE_DATABASE=...
SNOWFLAKE_SCHEMA=...
SNOWFLAKE_PUBLIC_KEY_FINGERPRINT=...
SNOWFLAKE_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Important:

- if `SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER` is wrong, local verification will fail open
- use a real PEM/private key pair that Snowflake accepts

### 5. A test user with a personal trial instance

You need a KiloClaw instance that is:

- personal (`organization_id is null`)
- current personal subscription row
- `plan='trial'`
- `status='trialing'`
- not destroyed
- not suspended
- older than 48 hours
- **running** for the actual stop test

Best option:

- use a fresh local-only user with a fresh personal trial instance
- a fresh user is ideal because Snowflake should have no qualifying usage

---

## Useful health checks

### Billing worker health

```bash
curl http://localhost:8807
```

Expected:

```json
{"ok":true,"service":"kiloclaw-billing",...}
```

### Platform status check

```bash
curl \
  -H "x-internal-api-key: $KILOCLAW_INTERNAL_API_SECRET" \
  "http://localhost:8795/api/platform/status?userId=<USER_ID>&instanceId=<INSTANCE_ID>"
```

For the real stop path, you want the instance to be:

```json
{ "status": "running" }
```

---

## Test data prep

### Find the target row

```sql
select
  u.id as user_id,
  u.google_user_email,
  i.id as instance_id,
  i.sandbox_id,
  i.created_at,
  i.inactive_trial_stopped_at,
  i.destroyed_at,
  i.organization_id,
  s.id as subscription_id,
  s.plan,
  s.status,
  s.suspended_at,
  s.destruction_deadline,
  s.transferred_to_subscription_id
from kilocode_users u
left join kiloclaw_instances i
  on i.user_id = u.id
left join kiloclaw_subscriptions s
  on s.instance_id = i.id
where u.google_user_email = '<YOUR_EMAIL>'
order by i.created_at desc nulls last;
```

### Make the instance eligible

```sql
update kiloclaw_instances
set
  created_at = now() - interval '3 days',
  inactive_trial_stopped_at = null,
  destroyed_at = null
where id = '<INSTANCE_ID>';
```

```sql
update kiloclaw_subscriptions
set
  plan = 'trial',
  status = 'trialing',
  suspended_at = null,
  destruction_deadline = null
where id = '<SUBSCRIPTION_ID>';
```

Also ensure:

- `transferred_to_subscription_id is null`

---

## Verification plan

## Phase 1: Dry-run verification

Start here.

### Configure dry-run

In `services/kiloclaw-billing/.dev.vars`:

```dotenv
TRIAL_INACTIVITY_STOP_ENABLED=true
TRIAL_INACTIVITY_STOP_DRY_RUN=true
```

Restart the billing worker if needed.

### Trigger the daily cron

```bash
curl "http://localhost:8807/__scheduled?cron=0+8+*+*+*"
```

### Expected logs

Look for:

- `Enqueued daily trial inactivity kickoff`
- Snowflake `downstream_call` logs with `billingComponent = "snowflake_sql_api"`
- `Trial inactivity dry-run candidate identified`
- `Completed daily trial inactivity run`

### Expected behavior

- no stop happens
- no DB marker is written
- the instance stays running

### Verify DB unchanged

```sql
select inactive_trial_stopped_at
from kiloclaw_instances
where id = '<INSTANCE_ID>';
```

Expected:

- `inactive_trial_stopped_at` is `null`

### Verify platform unchanged

```bash
curl \
  -H "x-internal-api-key: $KILOCLAW_INTERNAL_API_SECRET" \
  "http://localhost:8795/api/platform/status?userId=<USER_ID>&instanceId=<INSTANCE_ID>"
```

Expected:

- still `running`

---

## Phase 2: Real inactivity stop verification

### Configure real mode

In `services/kiloclaw-billing/.dev.vars`:

```dotenv
TRIAL_INACTIVITY_STOP_ENABLED=true
TRIAL_INACTIVITY_STOP_DRY_RUN=false
```

Restart the billing worker.

### Pre-check

Confirm the target instance is still:

- personal
- trialing
- older than 48h
- unmarked
- `running`

### Trigger the daily cron

```bash
curl "http://localhost:8807/__scheduled?cron=0+8+*+*+*"
```

### Expected behavior

For the chosen user:

- Snowflake query returns no qualifying activity
- billing checks `/api/platform/status`
- sees `running`
- billing calls `/api/platform/stop`
- billing writes `inactive_trial_stopped_at`
- billing does **not** mutate entitlement fields

### Verify DB marker written

```sql
select
  inactive_trial_stopped_at,
  destroyed_at
from kiloclaw_instances
where id = '<INSTANCE_ID>';
```

Expected:

- `inactive_trial_stopped_at` is non-null
- `destroyed_at` is still null

### Verify subscription fields unchanged

```sql
select
  plan,
  status,
  trial_started_at,
  trial_ends_at,
  suspended_at,
  destruction_deadline,
  past_due_since
from kiloclaw_subscriptions
where id = '<SUBSCRIPTION_ID>';
```

Expected:

- `plan = 'trial'`
- `status = 'trialing'`
- `suspended_at` unchanged/null
- `destruction_deadline` unchanged/null
- no billing-state mutation

### Verify platform status changed

```bash
curl \
  -H "x-internal-api-key: $KILOCLAW_INTERNAL_API_SECRET" \
  "http://localhost:8795/api/platform/status?userId=<USER_ID>&instanceId=<INSTANCE_ID>"
```

Expected:

- no longer `running`
- likely `stopped`

### Verify admin UI

Open:

- `/admin/kiloclaw`
- `/admin/kiloclaw/<INSTANCE_ID>`

Expected:

- list filter `Inactive Trial Stopped` includes the instance
- active filter excludes it
- stats show an inactive-trial-stopped count
- detail page shows:
  - `Inactive Trial Stopped` badge
  - `Inactive Trial Stopped At` timestamp

---

## Phase 3: Explicit restart clears the marker

## User start path

From the normal user UI, explicitly start the instance again.

Expected:

- instance starts
- `inactive_trial_stopped_at` is cleared

Verify:

```sql
select inactive_trial_stopped_at
from kiloclaw_instances
where id = '<INSTANCE_ID>';
```

Expected:

- `null`

And in admin UI:

- badge disappears
- instance returns to `Active`

## Admin start path

To verify the admin path too:

1. re-run the inactivity stop flow, or manually set the marker
2. use admin instance detail -> Start

Expected:

- marker cleared
- admin detail/list show `Active`

---

## Phase 4: Negative-path checks

### A. Feature disabled

Set:

```dotenv
TRIAL_INACTIVITY_STOP_ENABLED=false
```

Trigger:

```bash
curl "http://localhost:8807/__scheduled?cron=0+8+*+*+*"
```

Expected:

- logs show inactivity stop disabled
- no Snowflake calls
- no platform stop calls
- no DB changes

### B. Missing Snowflake config

Set enabled true, but remove one required Snowflake var.

Expected:

- structured log about missing config
- run skips cleanly
- no stop
- no marker write

### C. Instance already stopped

If platform status is already non-running and marker is null, trigger the cron.

Expected:

- no marker is written
- this confirms the implementation only marks instances it actually stopped from `running`

### D. User with recent Snowflake usage

If you intentionally test with a user known to have recent qualifying KiloClaw usage:

Expected:

- no stop
- no marker

---

## Recommended order

1. dry-run with a fresh user
2. real stop with the same user
3. explicit restart from user UI
4. explicit restart from admin UI
5. optional negative-path checks

---

## Common gotchas

- if the instance is not actually `running`, the worker will not mark it
- org instances are excluded
- non-current personal subscription rows are excluded
- if Snowflake auth breaks, the flow fails open and nothing stops
- if the user has qualifying recent usage, nothing stops
- time semantics are intentionally mixed:
  - instance age = true `> 48 hours`
  - Snowflake usage window = last 2 **calendar days**

---

## Minimal checklist

- [ ] Postgres running
- [ ] DB migrated
- [ ] web / kiloclaw / billing all running
- [ ] billing worker started with `--test-scheduled`
- [ ] billing `.dev.vars` contains real Snowflake creds
- [ ] personal trial instance exists and is running
- [ ] instance backdated >48h
- [ ] dry-run cron succeeds
- [ ] real cron stops the instance
- [ ] `inactive_trial_stopped_at` is written
- [ ] admin UI shows `Inactive Trial Stopped`
- [ ] explicit start clears the marker
