CREATE TABLE "byoc_connections" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"organization_id" uuid,
	"user_id" text,
	"credentials_encrypted" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"runtime" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"setup_status" text DEFAULT 'pending' NOT NULL,
	"setup_step" text,
	"setup_error" text,
	"build_generation" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"upgrade_status" text,
	"upgrade_step" text,
	"upgrade_error" text,
	"setup_started_at" timestamp with time zone,
	"setup_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "byoc_connections_owner_check" CHECK (("byoc_connections"."organization_id" IS NOT NULL AND "byoc_connections"."user_id" IS NULL) OR ("byoc_connections"."organization_id" IS NULL AND "byoc_connections"."user_id" IS NOT NULL)),
	CONSTRAINT "byoc_connections_provider_check" CHECK (length(trim("byoc_connections"."provider")) > 0),
	CONSTRAINT "byoc_connections_config_check" CHECK (jsonb_typeof("byoc_connections"."config") = 'object'),
	CONSTRAINT "byoc_connections_runtime_check" CHECK (jsonb_typeof("byoc_connections"."runtime") = 'object'),
	CONSTRAINT "byoc_connections_status_check" CHECK ("byoc_connections"."setup_status" IN ('pending', 'building', 'ready', 'failed')),
	CONSTRAINT "byoc_connections_ready_fields_check" CHECK ("byoc_connections"."setup_status" <> 'ready' OR "byoc_connections"."setup_completed_at" IS NOT NULL),
	CONSTRAINT "byoc_connections_upgrade_status_check" CHECK ("byoc_connections"."upgrade_status" IS NULL OR "byoc_connections"."upgrade_status" IN ('pending', 'building', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "byoc_connections" ADD CONSTRAINT "byoc_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_byoc_connections_organization_provider" ON "byoc_connections" USING btree ("organization_id","provider") WHERE "byoc_connections"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_byoc_connections_user_provider" ON "byoc_connections" USING btree ("user_id","provider") WHERE "byoc_connections"."user_id" IS NOT NULL;