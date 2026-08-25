-- Retire the KiloClaw Impact Advocate referral program.
--
-- KiloClaw referral rewards can no longer be earned or applied: fresh KiloClaw
-- instance provisioning is closed, so no account can make a first paid KiloClaw
-- subscription payment, and the reward application sweep has been removed.
--
-- Historical referral rows are retained for accounting and support history, and
-- already-applied free months stay applied. This migration only closes out the
-- work that can never complete:
--   1. rewards still awaiting application are canceled;
--   2. queued Impact Advocate redemptions for those rewards are terminated so
--      the shared redemption sweep stops retrying them forever.
UPDATE "impact_referral_rewards"
SET "status" = 'canceled',
    "review_reason" = 'kiloclaw_referral_program_retired'
WHERE "product" = 'kiloclaw'
  AND "reward_kind" = 'kiloclaw_free_month'
  AND "status" IN ('pending', 'earned');
-->  statement-breakpoint
UPDATE "impact_advocate_reward_redemptions"
SET "state" = 'failed',
    "next_retry_at" = NULL,
    "redeem_response_payload" = jsonb_build_object('error', 'retired_advocate_program')
WHERE "state" IN ('queued', 'retrying')
  AND "reward_id" IN (
    SELECT "id"
    FROM "impact_referral_rewards"
    WHERE "product" = 'kiloclaw'
      AND "reward_kind" = 'kiloclaw_free_month'
  );
