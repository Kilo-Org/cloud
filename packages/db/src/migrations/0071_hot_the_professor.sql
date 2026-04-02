CREATE TABLE "kilo_pass_pause_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_pass_subscription_id" uuid NOT NULL,
	"paused_at" timestamp with time zone NOT NULL,
	"resumes_at" timestamp with time zone,
	"resumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilo_pass_pause_events_resumed_at_after_paused_at_check" CHECK ("kilo_pass_pause_events"."resumed_at" IS NULL OR "kilo_pass_pause_events"."resumed_at" >= "kilo_pass_pause_events"."paused_at")
);
--> statement-breakpoint
ALTER TABLE "kilo_pass_pause_events" ADD CONSTRAINT "kilo_pass_pause_events_kilo_pass_subscription_id_kilo_pass_subscriptions_id_fk" FOREIGN KEY ("kilo_pass_subscription_id") REFERENCES "public"."kilo_pass_subscriptions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_pause_events_subscription_id" ON "kilo_pass_pause_events" USING btree ("kilo_pass_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_pause_events_one_open_per_sub" ON "kilo_pass_pause_events" USING btree ("kilo_pass_subscription_id") WHERE "kilo_pass_pause_events"."resumed_at" IS NULL;