CREATE TABLE "kiloclaw_instances" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"status" text DEFAULT 'provisioned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_stopped_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_instances_active_user" ON "kiloclaw_instances" USING btree ("user_id") WHERE "kiloclaw_instances"."status" != 'destroyed';--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_instances_sandbox_id" ON "kiloclaw_instances" USING btree ("sandbox_id") WHERE "kiloclaw_instances"."status" != 'destroyed';