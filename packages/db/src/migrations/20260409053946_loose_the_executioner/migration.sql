CREATE TABLE "user_affiliate_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"event_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"parent_event_id" uuid,
	"delivery_state" text DEFAULT 'queued' NOT NULL,
	"payload_json" jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_user_affiliate_events_dedupe_key" UNIQUE("dedupe_key"),
	CONSTRAINT "user_affiliate_events_provider_check" CHECK ("user_affiliate_events"."provider" IN ('impact')),
	CONSTRAINT "user_affiliate_events_event_type_check" CHECK ("user_affiliate_events"."event_type" IN ('signup', 'trial_start', 'trial_end', 'sale')),
	CONSTRAINT "user_affiliate_events_delivery_state_check" CHECK ("user_affiliate_events"."delivery_state" IN ('queued', 'blocked', 'sending', 'delivered', 'failed')),
	CONSTRAINT "user_affiliate_events_attempt_count_non_negative_check" CHECK ("user_affiliate_events"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_affiliate_events" ADD CONSTRAINT "user_affiliate_events_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_affiliate_events" ADD CONSTRAINT "user_affiliate_events_parent_event_id_fk" FOREIGN KEY ("parent_event_id") REFERENCES "public"."user_affiliate_events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "IDX_user_affiliate_events_claim_path" ON "user_affiliate_events" USING btree ("delivery_state",coalesce("next_retry_at", '-infinity'::timestamptz),"created_at","id");--> statement-breakpoint
CREATE INDEX "IDX_user_affiliate_events_parent_event_id" ON "user_affiliate_events" USING btree ("parent_event_id");