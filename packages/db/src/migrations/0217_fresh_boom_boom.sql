CREATE TABLE "external_side_effect_outbox" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"operation" text DEFAULT 'send_org_invite_email' NOT NULL,
	"invitation_id" uuid NOT NULL,
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
CREATE UNIQUE INDEX "UQ_external_side_effect_outbox_invitation_id" ON "external_side_effect_outbox" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "IDX_external_side_effect_outbox_status_next_attempt_at" ON "external_side_effect_outbox" USING btree ("status","next_attempt_at");