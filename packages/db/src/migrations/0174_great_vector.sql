CREATE TABLE "mcp_gateway_oauth_grants" (
	"oauth_grant_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"oauth_client_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"owner_scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"config_id" uuid NOT NULL,
	"connect_resource_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"granted_scopes" text[] NOT NULL,
	"execution_context" jsonb NOT NULL,
	"config_version" integer NOT NULL,
	"grant_status" text DEFAULT 'active' NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_oauth_grants_config_version_positive" CHECK ("mcp_gateway_oauth_grants"."config_version" > 0),
	CONSTRAINT "mcp_gateway_oauth_grants_owner_scope" CHECK ("mcp_gateway_oauth_grants"."owner_scope" IN ('personal', 'organization')),
	CONSTRAINT "mcp_gateway_oauth_grants_status" CHECK ("mcp_gateway_oauth_grants"."grant_status" IN ('pending', 'active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "mcp_gateway_audit_events" ADD COLUMN "oauth_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_codes" ADD COLUMN "oauth_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_requests" ADD COLUMN "oauth_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_gateway_pending_provider_authorizations" ADD COLUMN "oauth_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_gateway_refresh_tokens" ADD COLUMN "oauth_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_gateway_oauth_grants" ADD CONSTRAINT "mcp_gateway_oauth_grants_oauth_client_id_mcp_gateway_oauth_clients_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."mcp_gateway_oauth_clients"("oauth_client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_oauth_grants" ADD CONSTRAINT "mcp_gateway_oauth_grants_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_oauth_grants" ADD CONSTRAINT "mcp_gateway_oauth_grants_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_oauth_grants" ADD CONSTRAINT "mcp_gateway_oauth_grants_connect_resource_id_mcp_gateway_connect_resources_connect_resource_id_fk" FOREIGN KEY ("connect_resource_id") REFERENCES "public"."mcp_gateway_connect_resources"("connect_resource_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_oauth_grants" ADD CONSTRAINT "mcp_gateway_oauth_grants_instance_id_mcp_gateway_connection_instances_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."mcp_gateway_connection_instances"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_oauth_grants_active_binding" ON "mcp_gateway_oauth_grants" USING btree ("oauth_client_id","kilo_user_id","connect_resource_id","redirect_uri") WHERE "mcp_gateway_oauth_grants"."revoked_at" is null and "mcp_gateway_oauth_grants"."grant_status" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_oauth_grants_client" ON "mcp_gateway_oauth_grants" USING btree ("oauth_client_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_oauth_grants_user" ON "mcp_gateway_oauth_grants" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_oauth_grants_config" ON "mcp_gateway_oauth_grants" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_oauth_grants_owner" ON "mcp_gateway_oauth_grants" USING btree ("owner_scope","owner_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_oauth_grants_resource" ON "mcp_gateway_oauth_grants" USING btree ("connect_resource_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_oauth_grants_instance" ON "mcp_gateway_oauth_grants" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_oauth_grants_revoked_at" ON "mcp_gateway_oauth_grants" USING btree ("revoked_at");--> statement-breakpoint
ALTER TABLE "mcp_gateway_audit_events" ADD CONSTRAINT "mcp_gateway_audit_events_oauth_grant_id_mcp_gateway_oauth_grants_oauth_grant_id_fk" FOREIGN KEY ("oauth_grant_id") REFERENCES "public"."mcp_gateway_oauth_grants"("oauth_grant_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_codes" ADD CONSTRAINT "mcp_gateway_authorization_codes_oauth_grant_id_mcp_gateway_oauth_grants_oauth_grant_id_fk" FOREIGN KEY ("oauth_grant_id") REFERENCES "public"."mcp_gateway_oauth_grants"("oauth_grant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_requests" ADD CONSTRAINT "mcp_gateway_authorization_requests_oauth_grant_id_mcp_gateway_oauth_grants_oauth_grant_id_fk" FOREIGN KEY ("oauth_grant_id") REFERENCES "public"."mcp_gateway_oauth_grants"("oauth_grant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_pending_provider_authorizations" ADD CONSTRAINT "mcp_gateway_pending_provider_authorizations_oauth_grant_id_mcp_gateway_oauth_grants_oauth_grant_id_fk" FOREIGN KEY ("oauth_grant_id") REFERENCES "public"."mcp_gateway_oauth_grants"("oauth_grant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_refresh_tokens" ADD CONSTRAINT "mcp_gateway_refresh_tokens_oauth_grant_id_mcp_gateway_oauth_grants_oauth_grant_id_fk" FOREIGN KEY ("oauth_grant_id") REFERENCES "public"."mcp_gateway_oauth_grants"("oauth_grant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_audit_events_grant" ON "mcp_gateway_audit_events" USING btree ("oauth_grant_id") WHERE "mcp_gateway_audit_events"."oauth_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_authorization_codes_grant" ON "mcp_gateway_authorization_codes" USING btree ("oauth_grant_id") WHERE "mcp_gateway_authorization_codes"."oauth_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_authorization_requests_grant" ON "mcp_gateway_authorization_requests" USING btree ("oauth_grant_id") WHERE "mcp_gateway_authorization_requests"."oauth_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_pending_provider_authorizations_grant" ON "mcp_gateway_pending_provider_authorizations" USING btree ("oauth_grant_id") WHERE "mcp_gateway_pending_provider_authorizations"."oauth_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_refresh_tokens_grant" ON "mcp_gateway_refresh_tokens" USING btree ("oauth_grant_id") WHERE "mcp_gateway_refresh_tokens"."oauth_grant_id" is not null;