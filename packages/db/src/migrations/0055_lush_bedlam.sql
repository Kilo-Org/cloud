ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "payment_source" text;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "credit_renewal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "auto_top_up_triggered_for_period" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD CONSTRAINT "kiloclaw_subscriptions_payment_source_check" CHECK ("kiloclaw_subscriptions"."payment_source" IN ('stripe', 'credits'));