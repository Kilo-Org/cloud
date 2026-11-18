CREATE TABLE "bouncer_credit_event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"user_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_bouncer_credit_event_outbox_event_id_type" ON "bouncer_credit_event_outbox" USING btree ("event_id","event_type");--> statement-breakpoint
CREATE INDEX "IDX_bouncer_credit_event_outbox_status_next_attempt_at" ON "bouncer_credit_event_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "IDX_bouncer_credit_event_outbox_user_id" ON "bouncer_credit_event_outbox" USING btree ("user_id");