CREATE TABLE "kiloclaw_email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"email_type" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"stripe_subscription_id" text,
	"stripe_schedule_id" text,
	"plan" text NOT NULL,
	"scheduled_plan" text,
	"scheduled_by" text,
	"status" text NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"trial_started_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"commit_ends_at" timestamp with time zone,
	"past_due_since" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"destruction_deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiloclaw_subscriptions_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "kiloclaw_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "kiloclaw_subscriptions_plan_check" CHECK ("kiloclaw_subscriptions"."plan" IN ('trial', 'commit', 'standard')),
	CONSTRAINT "kiloclaw_subscriptions_scheduled_plan_check" CHECK ("kiloclaw_subscriptions"."scheduled_plan" IN ('commit', 'standard')),
	CONSTRAINT "kiloclaw_subscriptions_scheduled_by_check" CHECK ("kiloclaw_subscriptions"."scheduled_by" IN ('auto', 'user')),
	CONSTRAINT "kiloclaw_subscriptions_status_check" CHECK ("kiloclaw_subscriptions"."status" IN ('trialing', 'active', 'past_due', 'canceled', 'unpaid'))
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_email_log" ADD CONSTRAINT "kiloclaw_email_log_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD CONSTRAINT "kiloclaw_subscriptions_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_email_log_user_type" ON "kiloclaw_email_log" USING btree ("user_id","email_type");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscriptions_status" ON "kiloclaw_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscriptions_stripe_schedule_id" ON "kiloclaw_subscriptions" USING btree ("stripe_schedule_id");