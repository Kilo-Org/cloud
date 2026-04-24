CREATE TABLE "kiloclaw_subscription_change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"before_state" jsonb,
	"after_state" jsonb,
	CONSTRAINT "kiloclaw_subscription_change_log_actor_type_check" CHECK ("kiloclaw_subscription_change_log"."actor_type" IN ('user', 'system')),
	CONSTRAINT "kiloclaw_subscription_change_log_action_check" CHECK ("kiloclaw_subscription_change_log"."action" IN ('created', 'status_changed', 'plan_switched', 'period_advanced', 'canceled', 'reactivated', 'suspended', 'destruction_scheduled', 'reassigned', 'backfilled', 'payment_source_changed', 'schedule_changed', 'admin_override'))
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_earlybird_purchases" DROP CONSTRAINT "kiloclaw_earlybird_purchases_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "kiloclaw_email_log" DROP CONSTRAINT "kiloclaw_email_log_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" DROP CONSTRAINT "kiloclaw_instances_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" DROP CONSTRAINT "kiloclaw_subscriptions_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" DROP CONSTRAINT "kiloclaw_version_pins_instance_id_kiloclaw_instances_id_fk";
--> statement-breakpoint
DROP INDEX "UQ_kiloclaw_email_log_user_type";--> statement-breakpoint
ALTER TABLE "kiloclaw_email_log" ADD COLUMN "instance_id" uuid;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "access_origin" text;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscription_change_log" ADD CONSTRAINT "kiloclaw_subscription_change_log_subscription_id_kiloclaw_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."kiloclaw_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscription_change_log_subscription_created_at" ON "kiloclaw_subscription_change_log" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscription_change_log_created_at" ON "kiloclaw_subscription_change_log" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "kiloclaw_earlybird_purchases" ADD CONSTRAINT "kiloclaw_earlybird_purchases_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_email_log" ADD CONSTRAINT "kiloclaw_email_log_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_email_log" ADD CONSTRAINT "kiloclaw_email_log_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD CONSTRAINT "kiloclaw_instances_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD CONSTRAINT "kiloclaw_subscriptions_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ADD CONSTRAINT "kiloclaw_version_pins_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_email_log_user_type_global" ON "kiloclaw_email_log" USING btree ("user_id","email_type") WHERE "kiloclaw_email_log"."instance_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_email_log_user_instance_type" ON "kiloclaw_email_log" USING btree ("user_id","instance_id","email_type") WHERE "kiloclaw_email_log"."instance_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_instances_active_personal_by_user" ON "kiloclaw_instances" USING btree ("user_id") WHERE "kiloclaw_instances"."organization_id" IS NULL AND "kiloclaw_instances"."destroyed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_instances_active_org_by_user_org" ON "kiloclaw_instances" USING btree ("user_id","organization_id") WHERE "kiloclaw_instances"."organization_id" IS NOT NULL AND "kiloclaw_instances"."destroyed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscriptions_user_id" ON "kiloclaw_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscriptions_user_status" ON "kiloclaw_subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscriptions_earlybird_origin" ON "kiloclaw_subscriptions" USING btree ("user_id","access_origin") WHERE "kiloclaw_subscriptions"."access_origin" = 'earlybird';--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD CONSTRAINT "kiloclaw_subscriptions_access_origin_check" CHECK ("kiloclaw_subscriptions"."access_origin" IN ('earlybird'));