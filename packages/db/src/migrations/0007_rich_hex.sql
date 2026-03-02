CREATE TABLE "kiloclaw_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"status" text DEFAULT 'provisioned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_stopped_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	CONSTRAINT "kiloclaw_instances_status_check" CHECK ("kiloclaw_instances"."status" IN ('provisioned', 'running', 'stopped', 'destroyed'))
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD CONSTRAINT "kiloclaw_instances_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_instances_active_user" ON "kiloclaw_instances" USING btree ("user_id") WHERE "kiloclaw_instances"."destroyed_at" is null;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_instances_sandbox_id" ON "kiloclaw_instances" USING btree ("sandbox_id") WHERE "kiloclaw_instances"."destroyed_at" is null;