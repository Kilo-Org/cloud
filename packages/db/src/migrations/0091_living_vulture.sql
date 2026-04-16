ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "transferred_to_subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD CONSTRAINT "kiloclaw_subscriptions_transferred_to_subscription_id_kiloclaw_subscriptions_id_fk" FOREIGN KEY ("transferred_to_subscription_id") REFERENCES "public"."kiloclaw_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscriptions_transferred_to" ON "kiloclaw_subscriptions" USING btree ("transferred_to_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_subscriptions_transferred_to" ON "kiloclaw_subscriptions" USING btree ("transferred_to_subscription_id") WHERE "kiloclaw_subscriptions"."transferred_to_subscription_id" is not null;
--> statement-breakpoint
CREATE TEMP TABLE "__kiloclaw_reassignment_backfill" ON COMMIT DROP AS
WITH "ordered_reassignments" AS (
  SELECT
    "log"."id" AS "change_log_id",
    "log"."subscription_id",
    "log"."created_at" AS "change_created_at",
    "current_sub"."user_id" AS "current_user_id",
    "log"."before_state",
    (NULLIF("log"."before_state"->>'instance_id', ''))::uuid AS "before_instance_id",
    gen_random_uuid() AS "predecessor_id"
  FROM "kiloclaw_subscription_change_log" AS "log"
  INNER JOIN "kiloclaw_subscriptions" AS "current_sub"
    ON "current_sub"."id" = "log"."subscription_id"
  INNER JOIN "kiloclaw_instances" AS "before_instance"
    ON "before_instance"."id" = (NULLIF("log"."before_state"->>'instance_id', ''))::uuid
   AND "before_instance"."organization_id" IS NULL
  INNER JOIN "kiloclaw_instances" AS "after_instance"
    ON "after_instance"."id" = (NULLIF("log"."after_state"->>'instance_id', ''))::uuid
   AND "after_instance"."organization_id" IS NULL
  WHERE NULLIF("log"."before_state"->>'instance_id', '') IS NOT NULL
    AND NULLIF("log"."after_state"->>'instance_id', '') IS NOT NULL
    AND NULLIF("log"."before_state"->>'instance_id', '') <> NULLIF("log"."after_state"->>'instance_id', '')
    AND NULLIF("log"."before_state"->>'plan', '') IS NOT NULL
    AND COALESCE(NULLIF("log"."before_state"->>'user_id', ''), "current_sub"."user_id") = "current_sub"."user_id"
)
SELECT
  "ordered_reassignments".*,
  LEAD("ordered_reassignments"."predecessor_id")
    OVER (
      PARTITION BY "ordered_reassignments"."subscription_id"
      ORDER BY "ordered_reassignments"."change_created_at", "ordered_reassignments"."change_log_id"
    ) AS "next_predecessor_id"
FROM "ordered_reassignments";
--> statement-breakpoint
INSERT INTO "kiloclaw_subscriptions" (
  "id",
  "user_id",
  "stripe_subscription_id",
  "stripe_schedule_id",
  "transferred_to_subscription_id",
  "instance_id",
  "access_origin",
  "payment_source",
  "plan",
  "scheduled_plan",
  "scheduled_by",
  "status",
  "cancel_at_period_end",
  "pending_conversion",
  "trial_started_at",
  "trial_ends_at",
  "current_period_start",
  "current_period_end",
  "credit_renewal_at",
  "commit_ends_at",
  "past_due_since",
  "suspended_at",
  "destruction_deadline",
  "auto_resume_requested_at",
  "auto_resume_retry_after",
  "auto_resume_attempt_count",
  "auto_top_up_triggered_for_period",
  "created_at",
  "updated_at"
)
SELECT
  "backfill"."predecessor_id",
  COALESCE(NULLIF("backfill"."before_state"->>'user_id', ''), "backfill"."current_user_id"),
  NULL,
  NULL,
  COALESCE("backfill"."next_predecessor_id", "backfill"."subscription_id"),
  "backfill"."before_instance_id",
  NULLIF("backfill"."before_state"->>'access_origin', ''),
  NULLIF("backfill"."before_state"->>'payment_source', ''),
  "backfill"."before_state"->>'plan',
  NULL,
  NULL,
  'canceled',
  FALSE,
  FALSE,
  (NULLIF("backfill"."before_state"->>'trial_started_at', ''))::timestamptz,
  (NULLIF("backfill"."before_state"->>'trial_ends_at', ''))::timestamptz,
  (NULLIF("backfill"."before_state"->>'current_period_start', ''))::timestamptz,
  (NULLIF("backfill"."before_state"->>'current_period_end', ''))::timestamptz,
  NULL,
  (NULLIF("backfill"."before_state"->>'commit_ends_at', ''))::timestamptz,
  (NULLIF("backfill"."before_state"->>'past_due_since', ''))::timestamptz,
  (NULLIF("backfill"."before_state"->>'suspended_at', ''))::timestamptz,
  NULL,
  NULL,
  NULL,
  0,
  NULL,
  COALESCE((NULLIF("backfill"."before_state"->>'created_at', ''))::timestamptz, "backfill"."change_created_at"),
  COALESCE((NULLIF("backfill"."before_state"->>'updated_at', ''))::timestamptz, "backfill"."change_created_at")
FROM "__kiloclaw_reassignment_backfill" AS "backfill"
LEFT JOIN "kiloclaw_subscriptions" AS "existing_instance_row"
  ON "existing_instance_row"."instance_id" = "backfill"."before_instance_id"
WHERE "existing_instance_row"."id" IS NULL;
--> statement-breakpoint
WITH "detached_current" AS (
  SELECT "sub".*
  FROM "kiloclaw_subscriptions" AS "sub"
  WHERE "sub"."instance_id" IS NULL
    AND "sub"."transferred_to_subscription_id" IS NULL
), "single_detached_users" AS (
  SELECT "detached"."user_id", MIN(("detached"."id")::text)::uuid AS "detached_id"
  FROM "detached_current" AS "detached"
  GROUP BY "detached"."user_id"
  HAVING COUNT(*) = 1
), "current_personal_rows" AS (
  SELECT "sub"."id", "sub"."user_id", "sub"."instance_id"
  FROM "kiloclaw_subscriptions" AS "sub"
  INNER JOIN "kiloclaw_instances" AS "instance"
    ON "instance"."id" = "sub"."instance_id"
   AND "instance"."organization_id" IS NULL
  WHERE "sub"."transferred_to_subscription_id" IS NULL
), "attach_candidates" AS (
  SELECT
    "single_detached_users"."detached_id",
    MIN(("instance"."id")::text) FILTER (WHERE "existing_instance_row"."id" IS NULL)::uuid AS "candidate_instance_id"
  FROM "single_detached_users"
  INNER JOIN "detached_current" AS "detached"
    ON "detached"."id" = "single_detached_users"."detached_id"
  INNER JOIN "kiloclaw_instances" AS "instance"
    ON "instance"."user_id" = "single_detached_users"."user_id"
   AND "instance"."organization_id" IS NULL
  LEFT JOIN "kiloclaw_subscriptions" AS "existing_instance_row"
    ON "existing_instance_row"."instance_id" = "instance"."id"
  LEFT JOIN "current_personal_rows" AS "current_personal"
    ON "current_personal"."user_id" = "single_detached_users"."user_id"
  LEFT JOIN "kiloclaw_subscriptions" AS "conflict"
    ON "detached"."stripe_subscription_id" IS NOT NULL
   AND "conflict"."stripe_subscription_id" = "detached"."stripe_subscription_id"
   AND "conflict"."id" <> "detached"."id"
  GROUP BY "single_detached_users"."detached_id"
  HAVING COUNT(DISTINCT "current_personal"."id") = 0
     AND COUNT(*) FILTER (WHERE "existing_instance_row"."id" IS NULL) = 1
     AND COUNT("conflict"."id") = 0
)
UPDATE "kiloclaw_subscriptions" AS "detached"
SET "instance_id" = "attach_candidates"."candidate_instance_id"
FROM "attach_candidates"
WHERE "detached"."id" = "attach_candidates"."detached_id";
--> statement-breakpoint
CREATE TEMP TABLE "__kiloclaw_detached_merge_candidates" ON COMMIT DROP AS
WITH "detached_current" AS (
  SELECT "sub".*
  FROM "kiloclaw_subscriptions" AS "sub"
  WHERE "sub"."instance_id" IS NULL
    AND "sub"."transferred_to_subscription_id" IS NULL
), "single_detached_users" AS (
  SELECT "detached"."user_id", MIN(("detached"."id")::text)::uuid AS "detached_id"
  FROM "detached_current" AS "detached"
  GROUP BY "detached"."user_id"
  HAVING COUNT(*) = 1
), "current_personal_rows" AS (
  SELECT "sub".*
  FROM "kiloclaw_subscriptions" AS "sub"
  INNER JOIN "kiloclaw_instances" AS "instance"
    ON "instance"."id" = "sub"."instance_id"
   AND "instance"."organization_id" IS NULL
  WHERE "sub"."transferred_to_subscription_id" IS NULL
), "single_current_personal_rows" AS (
  SELECT MIN(("current_personal"."id")::text)::uuid AS "target_id", "current_personal"."user_id"
  FROM "current_personal_rows" AS "current_personal"
  GROUP BY "current_personal"."user_id"
  HAVING COUNT(*) = 1
)
SELECT
  "detached"."id" AS "detached_id",
  "target"."id" AS "target_id",
  "detached"."stripe_subscription_id",
  "detached"."stripe_schedule_id",
  "detached"."access_origin",
  "detached"."payment_source",
  "detached"."plan",
  "detached"."scheduled_plan",
  "detached"."scheduled_by",
  "detached"."status",
  "detached"."cancel_at_period_end",
  "detached"."pending_conversion",
  "detached"."trial_started_at",
  "detached"."trial_ends_at",
  "detached"."current_period_start",
  "detached"."current_period_end",
  "detached"."credit_renewal_at",
  "detached"."commit_ends_at",
  "detached"."past_due_since",
  "detached"."suspended_at",
  "detached"."destruction_deadline",
  "detached"."auto_resume_requested_at",
  "detached"."auto_resume_retry_after",
  "detached"."auto_resume_attempt_count",
  "detached"."auto_top_up_triggered_for_period"
FROM "single_detached_users"
INNER JOIN "detached_current" AS "detached"
  ON "detached"."id" = "single_detached_users"."detached_id"
INNER JOIN "single_current_personal_rows"
  ON "single_current_personal_rows"."user_id" = "single_detached_users"."user_id"
INNER JOIN "kiloclaw_subscriptions" AS "target"
  ON "target"."id" = "single_current_personal_rows"."target_id"
WHERE "target"."stripe_subscription_id" IS NULL
  AND "target"."payment_source" IS NULL
  AND "target"."plan" = 'trial'
  AND NOT EXISTS (
    SELECT 1
    FROM "kiloclaw_subscriptions" AS "conflict"
    WHERE "detached"."stripe_subscription_id" IS NOT NULL
      AND "conflict"."stripe_subscription_id" = "detached"."stripe_subscription_id"
      AND "conflict"."id" NOT IN ("detached"."id", "target"."id")
  );
--> statement-breakpoint
UPDATE "kiloclaw_subscriptions" AS "detached"
SET
  "transferred_to_subscription_id" = "merge"."target_id",
  "status" = 'canceled',
  "stripe_subscription_id" = NULL,
  "stripe_schedule_id" = NULL,
  "credit_renewal_at" = NULL,
  "cancel_at_period_end" = FALSE,
  "pending_conversion" = FALSE,
  "scheduled_plan" = NULL,
  "scheduled_by" = NULL,
  "auto_resume_requested_at" = NULL,
  "auto_resume_retry_after" = NULL,
  "auto_resume_attempt_count" = 0,
  "auto_top_up_triggered_for_period" = NULL,
  "destruction_deadline" = NULL
FROM "__kiloclaw_detached_merge_candidates" AS "merge"
WHERE "detached"."id" = "merge"."detached_id";
--> statement-breakpoint
UPDATE "kiloclaw_subscriptions" AS "target"
SET
  "stripe_subscription_id" = "merge"."stripe_subscription_id",
  "stripe_schedule_id" = "merge"."stripe_schedule_id",
  "access_origin" = "merge"."access_origin",
  "payment_source" = "merge"."payment_source",
  "plan" = "merge"."plan",
  "scheduled_plan" = "merge"."scheduled_plan",
  "scheduled_by" = "merge"."scheduled_by",
  "status" = "merge"."status",
  "cancel_at_period_end" = "merge"."cancel_at_period_end",
  "pending_conversion" = "merge"."pending_conversion",
  "trial_started_at" = "merge"."trial_started_at",
  "trial_ends_at" = "merge"."trial_ends_at",
  "current_period_start" = "merge"."current_period_start",
  "current_period_end" = "merge"."current_period_end",
  "credit_renewal_at" = "merge"."credit_renewal_at",
  "commit_ends_at" = "merge"."commit_ends_at",
  "past_due_since" = "merge"."past_due_since",
  "suspended_at" = "merge"."suspended_at",
  "destruction_deadline" = "merge"."destruction_deadline",
  "auto_resume_requested_at" = "merge"."auto_resume_requested_at",
  "auto_resume_retry_after" = "merge"."auto_resume_retry_after",
  "auto_resume_attempt_count" = "merge"."auto_resume_attempt_count",
  "auto_top_up_triggered_for_period" = "merge"."auto_top_up_triggered_for_period"
FROM "__kiloclaw_detached_merge_candidates" AS "merge"
WHERE "target"."id" = "merge"."target_id";