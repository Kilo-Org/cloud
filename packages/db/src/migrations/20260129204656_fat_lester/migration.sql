ALTER TABLE "cli_sessions_v2" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "cloud_agent_session_id" text;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "created_on_platform" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD CONSTRAINT "cli_sessions_v2_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cli_sessions_v2_cloud_agent_session_id" ON "cli_sessions_v2" USING btree ("cloud_agent_session_id") WHERE "cli_sessions_v2"."cloud_agent_session_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_cli_sessions_v2_organization_id" ON "cli_sessions_v2" USING btree ("organization_id");