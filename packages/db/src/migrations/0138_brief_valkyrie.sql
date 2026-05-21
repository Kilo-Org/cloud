CREATE TABLE "kiloclaw_composio_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"composio_agent_key_encrypted" text,
	"composio_user_api_key_encrypted" text,
	"composio_api_key_encrypted" text,
	"composio_org_id" text,
	"composio_org_name" text,
	"composio_project_id" text,
	"composio_consumer_user_id" text,
	"google_calendar_connected_account_id" text,
	"composio_agent_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "kiloclaw_composio_identities_owner_type_check" CHECK ("kiloclaw_composio_identities"."owner_type" IN ('user', 'organization_user')),
	CONSTRAINT "kiloclaw_composio_identities_status_check" CHECK ("kiloclaw_composio_identities"."status" IN ('pending', 'active', 'revoked')),
	CONSTRAINT "kiloclaw_composio_identities_owner_scope_check" CHECK (("kiloclaw_composio_identities"."owner_type" = 'user' AND "kiloclaw_composio_identities"."organization_id" IS NULL) OR ("kiloclaw_composio_identities"."owner_type" = 'organization_user' AND "kiloclaw_composio_identities"."organization_id" IS NOT NULL)),
	CONSTRAINT "kiloclaw_composio_identities_active_complete_check" CHECK ("kiloclaw_composio_identities"."status" <> 'active' OR ("kiloclaw_composio_identities"."composio_agent_key_encrypted" IS NOT NULL AND "kiloclaw_composio_identities"."composio_user_api_key_encrypted" IS NOT NULL AND "kiloclaw_composio_identities"."composio_org_id" IS NOT NULL AND "kiloclaw_composio_identities"."composio_project_id" IS NOT NULL AND "kiloclaw_composio_identities"."composio_consumer_user_id" IS NOT NULL AND "kiloclaw_composio_identities"."revoked_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD COLUMN "composio_config_source" text;--> statement-breakpoint
ALTER TABLE "kiloclaw_composio_identities" ADD CONSTRAINT "kiloclaw_composio_identities_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_composio_identities" ADD CONSTRAINT "kiloclaw_composio_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_composio_identities_current_user" ON "kiloclaw_composio_identities" USING btree ("user_id") WHERE "kiloclaw_composio_identities"."owner_type" = 'user' AND "kiloclaw_composio_identities"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_composio_identities_current_org_user" ON "kiloclaw_composio_identities" USING btree ("organization_id","user_id") WHERE "kiloclaw_composio_identities"."owner_type" = 'organization_user' AND "kiloclaw_composio_identities"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_composio_identities_user" ON "kiloclaw_composio_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_composio_identities_organization" ON "kiloclaw_composio_identities" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD CONSTRAINT "kiloclaw_instances_composio_config_source_check" CHECK ("kiloclaw_instances"."composio_config_source" IS NULL OR "kiloclaw_instances"."composio_config_source" IN ('managed', 'manual'));