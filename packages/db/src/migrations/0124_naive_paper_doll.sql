CREATE TABLE "kiloclaw_morning_briefing_configs" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cron" text DEFAULT '0 7 * * *' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"interest_topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_morning_briefing_configs" ADD CONSTRAINT "kiloclaw_morning_briefing_configs_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_morning_briefing_configs_enabled" ON "kiloclaw_morning_briefing_configs" USING btree ("instance_id") WHERE "kiloclaw_morning_briefing_configs"."enabled" = true;