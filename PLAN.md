# Bulk Extend KiloClaw Trial — Implementation Plan

## Goal

Admin page: drop a CSV of emails, match to existing users, enter number of days, extend/resurrect trials.

## Branch Strategy

**Start fresh from `origin/main`.** The current branch (`feat/kiloclaw-bulk-extend-trial`) has ~15,600 lines of diff, mostly merge conflict artifacts that removed large sections of `kiloclaw-router.ts`. Implementing on it would carry unreviable noise. The actual feature is ~500 lines of new code.

## What Changes (5 files touched, 0 new tables)

| File                                            | Change                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `src/routers/admin/extend-claw-trial-router.ts` | **New file.** Two tRPC mutations: `matchCsv` and `extendTrials`.   |
| `src/app/admin/extend-claw-trial/page.tsx`      | **New file.** Three-step admin wizard (upload → review → results). |
| `src/routers/admin-router.ts`                   | Add import + mount `extendClawTrial` sub-router.                   |
| `src/app/admin/components/AppSidebar.tsx`       | Add nav item to Product & Engineering section.                     |

No new database tables. No migration. No changes to `kiloclaw-router.ts`, `user.ts`, `schema.ts`, or `schema-types.ts`.

## What Gets Removed vs Current Branch

- **`kiloclaw_trial_grants` table** — Not created. No migration, no schema addition, no GDPR handling needed.
- **`kiloclaw-router.ts` changes** — Removed entirely. No "pre-grant" lookup at provisioning time.
- **`user.ts` GDPR changes** — Removed entirely (no new PII-containing table).
- **`schema-types.ts` audit action** — Not added. Reuse existing `update_trial_end` / `reset_trial` actions.

## Backend: `extend-claw-trial-router.ts`

### `matchCsv` mutation

**Input:** `{ csvText: string }` — raw CSV text (file read as text on frontend, sent as string).

**Processing:**

1. Parse CSV server-side: split lines, detect header row, find email column (column containing `@`), extract and deduplicate emails.
2. Batch query `kilocode_users` with `inArray(google_user_email, emails)` to resolve user IDs.
3. For matched users, batch query `kiloclaw_subscriptions` with `inArray(user_id, matchedUserIds)` to get subscription status.
4. Categorize each email into one of:
   - `trialing` — has subscription with `status = 'trialing'` (can extend)
   - `canceled` — has subscription with `status = 'canceled'` (can resurrect)
   - `paid` — has subscription with `status` in `['active', 'past_due', 'unpaid']` (skip, show warning)
   - `no_subscription` — user exists but no kiloclaw subscription (skip)
   - `unmatched` — email not found in `kilocode_users`

**Output:** `{ matched: Array<{ email, userId, userName, subscriptionStatus }>, unmatched: string[] }`

### `extendTrials` mutation

**Input:** `{ userIds: string[], days: number }` — operates on user IDs, not emails.

**Processing (sequential, per-user, no transactions):**

1. For each userId, fetch their `kiloclaw_subscriptions` row.
2. **If `trialing`:** Update `trial_ends_at = GREATEST(trial_ends_at, now()) + interval '${days} days'`. Write audit log with action `kiloclaw.subscription.update_trial_end`, metadata includes `{ source: 'bulk_extend', days }`.
3. **If `canceled`:** Reset to trialing — same pattern as existing `updateKiloClawTrialEndAt` (set status/plan, clear Stripe fields, clear email logs, set new trial dates). Write audit log with action `kiloclaw.subscription.reset_trial`, metadata includes `{ source: 'bulk_extend', days }`. Best-effort instance start.
4. **If paid/missing:** Skip with error in results.
5. Each user wrapped in try/catch for error isolation.

**Output:** `Array<{ userId, email, action: 'extended' | 'restarted' | 'skipped' | 'error', message: string }>`

**No DB transactions.** Each user's subscription update and audit log are independent writes. If the audit log write fails, the subscription update still stands (audit is best-effort, consistent with how external-action audits work elsewhere).

## Frontend: `page.tsx`

Three-step wizard (same UI pattern as `/admin/bulk-credits`):

### Step 1: Upload CSV

- Drag-and-drop zone + file picker (accepts `.csv`)
- Read file as text, send raw text to `matchCsv` mutation
- Enter number of days (default 7)

### Step 2: Review Matches

- Table of matched users grouped by action:
  - Trialing users (will be extended) — show current `trial_ends_at`
  - Canceled users (will be resurrected) — show "will restart trial"
  - Paid users — show as "skipped (active subscription)" with warning
  - No subscription — show as "skipped (no KiloClaw subscription)"
- Unmatched emails shown separately
- "Extend N Trials" button (count excludes paid/no-sub/unmatched)
- CSV export for unmatched emails

### Step 3: Results

- Summary stats (extended count, restarted count, errors)
- Per-user results table
- CSV export for results

## Audit Trail

Reuses existing audit actions from `KiloClawAdminAuditAction`:

- `kiloclaw.subscription.update_trial_end` — for extending active trials
- `kiloclaw.subscription.reset_trial` — for resurrecting canceled subscriptions

Metadata includes `{ source: 'bulk_extend', days: N }` to distinguish bulk operations from single-user admin edits. No schema change needed.

## Edge Cases

- **Duplicate emails in CSV:** Deduplicated during parsing.
- **User has no subscription row:** Skipped. Per billing spec, trials are created at provisioning time — we don't create subscriptions out of band.
- **Race condition between match and extend:** Backend re-validates subscription status at extend time (same pattern as bulk-credits).
- **Large CSVs:** Capped at 1000 emails (same as bulk-credits).

## Verification Plan

1. `pnpm typecheck` — no type errors
2. `pnpm lint` — no lint errors
3. Manual test: upload CSV with mix of trialing, canceled, paid, and unknown emails
4. Verify audit logs are created with correct actions and metadata
