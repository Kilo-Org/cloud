CREATE TABLE "kiloclaw_scheduled_action_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheduled_action_id" uuid NOT NULL,
	"stage_index" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"notice_sent_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_scheduled_action_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheduled_action_id" uuid NOT NULL,
	"stage_id" uuid,
	"instance_id" uuid NOT NULL,
	"source_image_tag" text,
	"target_image_tag" text,
	"user_id" text NOT NULL,
	"applied_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_scheduled_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_type" text NOT NULL,
	"target_image_tag" text,
	"override_pins" boolean DEFAULT false NOT NULL,
	"notice_lead_hours" integer DEFAULT 24 NOT NULL,
	"notice_subject" text DEFAULT '' NOT NULL,
	"notice_body" text DEFAULT '' NOT NULL,
	"reason" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"total_count" integer DEFAULT 0 NOT NULL,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_scheduled_action_stages" ADD CONSTRAINT "kiloclaw_scheduled_action_stages_scheduled_action_id_kiloclaw_scheduled_actions_id_fk" FOREIGN KEY ("scheduled_action_id") REFERENCES "public"."kiloclaw_scheduled_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_scheduled_action_targets" ADD CONSTRAINT "kiloclaw_scheduled_action_targets_scheduled_action_id_kiloclaw_scheduled_actions_id_fk" FOREIGN KEY ("scheduled_action_id") REFERENCES "public"."kiloclaw_scheduled_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_scheduled_action_targets" ADD CONSTRAINT "kiloclaw_scheduled_action_targets_stage_id_kiloclaw_scheduled_action_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."kiloclaw_scheduled_action_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_scheduled_action_targets" ADD CONSTRAINT "kiloclaw_scheduled_action_targets_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_scheduled_action_targets" ADD CONSTRAINT "kiloclaw_scheduled_action_targets_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_scheduled_actions" ADD CONSTRAINT "kiloclaw_scheduled_actions_target_image_tag_kiloclaw_image_catalog_image_tag_fk" FOREIGN KEY ("target_image_tag") REFERENCES "public"."kiloclaw_image_catalog"("image_tag") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_scheduled_actions" ADD CONSTRAINT "kiloclaw_scheduled_actions_created_by_kilocode_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_scheduled_action_stages_parent_index" ON "kiloclaw_scheduled_action_stages" USING btree ("scheduled_action_id","stage_index");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_scheduled_action_stages_notice_due" ON "kiloclaw_scheduled_action_stages" USING btree ("scheduled_at") WHERE "kiloclaw_scheduled_action_stages"."notice_sent_at" IS NULL AND "kiloclaw_scheduled_action_stages"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_scheduled_action_targets_parent_instance" ON "kiloclaw_scheduled_action_targets" USING btree ("scheduled_action_id","instance_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_scheduled_action_targets_stage" ON "kiloclaw_scheduled_action_targets" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_scheduled_action_targets_pending_by_instance" ON "kiloclaw_scheduled_action_targets" USING btree ("instance_id") WHERE "kiloclaw_scheduled_action_targets"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_scheduled_actions_status" ON "kiloclaw_scheduled_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_scheduled_actions_action_type" ON "kiloclaw_scheduled_actions" USING btree ("action_type");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_scheduled_actions_created_by" ON "kiloclaw_scheduled_actions" USING btree ("created_by");