CREATE TABLE "pending_impact_sale_reversals" (
	"stripe_charge_id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"amount" real NOT NULL,
	"currency" text NOT NULL,
	"event_date" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_impact_sale_reversals_attempt_count_non_negative_check" CHECK ("pending_impact_sale_reversals"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_affiliate_events" DROP CONSTRAINT "user_affiliate_events_event_type_check";--> statement-breakpoint
ALTER TABLE "user_affiliate_events" ADD COLUMN "stripe_charge_id" text;--> statement-breakpoint
ALTER TABLE "user_affiliate_events" ADD COLUMN "impact_action_id" text;--> statement-breakpoint
ALTER TABLE "user_affiliate_events" ADD COLUMN "impact_submission_uri" text;--> statement-breakpoint
CREATE INDEX "IDX_user_affiliate_events_provider_event_type_charge" ON "user_affiliate_events" USING btree ("provider","event_type","stripe_charge_id");--> statement-breakpoint
ALTER TABLE "user_affiliate_events" ADD CONSTRAINT "user_affiliate_events_event_type_check" CHECK ("user_affiliate_events"."event_type" IN ('signup', 'trial_start', 'trial_end', 'sale', 'sale_reversal'));