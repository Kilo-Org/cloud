ALTER TABLE "kiloclaw_subscriptions" DROP CONSTRAINT "kiloclaw_subscriptions_user_id_unique";--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "instance_id" uuid;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "payment_source" text;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "pending_conversion" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "credit_renewal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "auto_top_up_triggered_for_period" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD CONSTRAINT "kiloclaw_subscriptions_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_subscriptions_instance" ON "kiloclaw_subscriptions" USING btree ("instance_id") WHERE "kiloclaw_subscriptions"."instance_id" is not null;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD CONSTRAINT "kiloclaw_subscriptions_payment_source_check" CHECK ("kiloclaw_subscriptions"."payment_source" IN ('stripe', 'credits'));--> statement-breakpoint

-- Backfill instance_id on existing kiloclaw_subscriptions rows.
-- For each subscription, set instance_id to the user's most recently created
-- active (non-destroyed) instance. Rows with no matching instance are left NULL.
UPDATE "kiloclaw_subscriptions" s
SET "instance_id" = (
  SELECT i."id"
  FROM "kiloclaw_instances" i
  WHERE i."user_id" = s."user_id"
    AND i."destroyed_at" IS NULL
  ORDER BY i."created_at" DESC
  LIMIT 1
);--> statement-breakpoint

-- Backfill payment_source to 'stripe' for existing rows that have a Stripe subscription ID.
UPDATE "kiloclaw_subscriptions"
SET "payment_source" = 'stripe'
WHERE "stripe_subscription_id" IS NOT NULL
  AND "payment_source" IS NULL;