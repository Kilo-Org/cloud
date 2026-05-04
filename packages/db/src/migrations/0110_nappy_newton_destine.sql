CREATE TABLE "kiloclaw_scheduled_action_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"kind" text DEFAULT 'notice' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_scheduled_action_notifications" ADD CONSTRAINT "kiloclaw_scheduled_action_notifications_target_id_kiloclaw_scheduled_action_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."kiloclaw_scheduled_action_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_scheduled_action_notifications_target_kind_channel" ON "kiloclaw_scheduled_action_notifications" USING btree ("target_id","kind","channel");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_scheduled_action_notifications_pending" ON "kiloclaw_scheduled_action_notifications" USING btree ("target_id") WHERE "kiloclaw_scheduled_action_notifications"."status" = 'pending';
