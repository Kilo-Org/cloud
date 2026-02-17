CREATE TABLE "gastown_towns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"town_name" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"fly_machine_id" text,
	"fly_volume_id" text,
	"fly_region" text DEFAULT 'iad',
	"status" text DEFAULT 'provisioning' NOT NULL,
	"last_r2_sync_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destroyed_at" timestamp with time zone,
	CONSTRAINT "gastown_towns_sandbox_id_unique" UNIQUE("sandbox_id"),
	CONSTRAINT "gastown_towns_status_check" CHECK ("gastown_towns"."status" IN ('provisioning', 'running', 'stopped', 'destroyed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_gastown_towns_active_per_user_name" ON "gastown_towns" USING btree ("user_id","town_name") WHERE "gastown_towns"."destroyed_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "gastown_towns" ADD CONSTRAINT "gastown_towns_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "gastown_rigs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"town_id" uuid NOT NULL,
	"rig_name" text NOT NULL,
	"repo_url" text NOT NULL,
	"branch" text DEFAULT 'main',
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gastown_rigs_status_check" CHECK ("gastown_rigs"."status" IN ('active', 'removed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_gastown_rigs_town_name" ON "gastown_rigs" USING btree ("town_id","rig_name") WHERE "gastown_rigs"."status" = 'active';
--> statement-breakpoint
ALTER TABLE "gastown_rigs" ADD CONSTRAINT "gastown_rigs_town_id_gastown_towns_id_fk" FOREIGN KEY ("town_id") REFERENCES "public"."gastown_towns"("id") ON DELETE cascade ON UPDATE no action;
