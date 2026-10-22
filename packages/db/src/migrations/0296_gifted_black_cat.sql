ALTER TABLE "contributor_champion_memberships" ADD COLUMN "credits_window_granted_microdollars" bigint DEFAULT 0 NOT NULL;-->  statement-breakpoint
UPDATE "contributor_champion_memberships"
SET "credits_window_granted_microdollars" = "credit_amount_microdollars"
WHERE "credits_last_granted_at" IS NOT NULL
  AND "credits_last_granted_at" > now() - interval '30 days';