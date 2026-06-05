CREATE TABLE "mcp_gateway_assignments" (
	"assignment_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"assigned_by_kilo_user_id" text,
	"single_user_slot" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_audit_events" (
	"audit_event_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"actor_kilo_user_id" text,
	"owner_scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"config_id" uuid,
	"connect_resource_id" uuid,
	"instance_id" uuid,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"correlation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_audit_events_owner_scope" CHECK ("mcp_gateway_audit_events"."owner_scope" IN ('personal', 'organization')),
	CONSTRAINT "mcp_gateway_audit_events_outcome" CHECK ("mcp_gateway_audit_events"."outcome" IN ('success', 'failure', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_authorization_codes" (
	"authorization_code_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"authorization_request_id" uuid NOT NULL,
	"oauth_client_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"owner_scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"config_id" uuid NOT NULL,
	"route_key" text NOT NULL,
	"canonical_resource_url" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"granted_scopes" text[] NOT NULL,
	"code_challenge" text,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"execution_context" jsonb NOT NULL,
	"kilo_user_id" text NOT NULL,
	"instance_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_authorization_codes_owner_scope" CHECK ("mcp_gateway_authorization_codes"."owner_scope" IN ('personal', 'organization'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_authorization_requests" (
	"authorization_request_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"request_state_hash" text NOT NULL,
	"oauth_client_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"owner_scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"config_id" uuid NOT NULL,
	"route_key" text NOT NULL,
	"canonical_resource_url" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"requested_scopes" text[] NOT NULL,
	"granted_scopes" text[] NOT NULL,
	"oauth_state" text,
	"code_challenge" text,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"execution_context" jsonb NOT NULL,
	"kilo_user_id" text NOT NULL,
	"instance_id" uuid NOT NULL,
	"request_status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_authorization_requests_owner_scope" CHECK ("mcp_gateway_authorization_requests"."owner_scope" IN ('personal', 'organization')),
	CONSTRAINT "mcp_gateway_authorization_requests_status" CHECK ("mcp_gateway_authorization_requests"."request_status" IN ('pending', 'completed', 'error'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_config_secrets" (
	"config_secret_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"secret_kind" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_config_secrets_version_positive" CHECK ("mcp_gateway_config_secrets"."secret_version" > 0),
	CONSTRAINT "mcp_gateway_config_secrets_kind" CHECK ("mcp_gateway_config_secrets"."secret_kind" IN ('static_provider_credentials', 'dynamic_registration', 'static_headers'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_configs" (
	"config_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owner_scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"remote_url" text NOT NULL,
	"auth_mode" text NOT NULL,
	"sharing_mode" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"path_passthrough" boolean DEFAULT false NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"discovered_provider_metadata" jsonb,
	"registry_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auxiliary_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_kilo_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_configs_name_not_empty" CHECK (length(trim("mcp_gateway_configs"."name")) > 0),
	CONSTRAINT "mcp_gateway_configs_config_version_positive" CHECK ("mcp_gateway_configs"."config_version" > 0),
	CONSTRAINT "mcp_gateway_configs_personal_single_user" CHECK ("mcp_gateway_configs"."owner_scope" <> 'personal' OR "mcp_gateway_configs"."sharing_mode" = 'single_user'),
	CONSTRAINT "mcp_gateway_configs_owner_scope" CHECK ("mcp_gateway_configs"."owner_scope" IN ('personal', 'organization')),
	CONSTRAINT "mcp_gateway_configs_auth_mode" CHECK ("mcp_gateway_configs"."auth_mode" IN ('none', 'static_headers', 'oauth_dynamic', 'oauth_static')),
	CONSTRAINT "mcp_gateway_configs_sharing_mode" CHECK ("mcp_gateway_configs"."sharing_mode" IN ('single_user', 'multi_user'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_connect_resources" (
	"connect_resource_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"owner_scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"route_key" text NOT NULL,
	"canonical_url" text NOT NULL,
	"route_status" text DEFAULT 'active' NOT NULL,
	"route_version" integer DEFAULT 1 NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_connect_resources_route_key_format" CHECK ("mcp_gateway_connect_resources"."route_key" ~ '^[A-Za-z0-9_-]{32,}$'),
	CONSTRAINT "mcp_gateway_connect_resources_route_version_positive" CHECK ("mcp_gateway_connect_resources"."route_version" > 0),
	CONSTRAINT "mcp_gateway_connect_resources_owner_scope" CHECK ("mcp_gateway_connect_resources"."owner_scope" IN ('personal', 'organization')),
	CONSTRAINT "mcp_gateway_connect_resources_route_status" CHECK ("mcp_gateway_connect_resources"."route_status" IN ('active', 'rotated', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_connection_instances" (
	"instance_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"owner_scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"instance_status" text DEFAULT 'active' NOT NULL,
	"instance_version" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_connection_instances_version_positive" CHECK ("mcp_gateway_connection_instances"."instance_version" > 0),
	CONSTRAINT "mcp_gateway_connection_instances_owner_scope" CHECK ("mcp_gateway_connection_instances"."owner_scope" IN ('personal', 'organization')),
	CONSTRAINT "mcp_gateway_connection_instances_status" CHECK ("mcp_gateway_connection_instances"."instance_status" IN ('active', 'needs_reauth', 'revoked', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_oauth_clients" (
	"oauth_client_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text,
	"registration_token_hash" text NOT NULL,
	"client_secret_hash" text,
	"token_endpoint_auth_method" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"grant_types" text[] NOT NULL,
	"response_types" text[] NOT NULL,
	"declared_scopes" text[] NOT NULL,
	"registration_access_token_expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_oauth_clients_client_id_format" CHECK ("mcp_gateway_oauth_clients"."client_id" ~ '^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$'),
	CONSTRAINT "mcp_gateway_oauth_clients_auth_method" CHECK ("mcp_gateway_oauth_clients"."token_endpoint_auth_method" IN ('none', 'client_secret_post', 'client_secret_basic'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_pending_provider_authorizations" (
	"pending_provider_authorization_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"authorization_request_id" uuid,
	"config_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"owner_scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"route_key" text NOT NULL,
	"canonical_resource_url" text NOT NULL,
	"remote_url" text NOT NULL,
	"auth_mode" text NOT NULL,
	"provider_authorization_endpoint" text NOT NULL,
	"provider_token_endpoint" text NOT NULL,
	"encrypted_state" text NOT NULL,
	"execution_context" jsonb NOT NULL,
	"config_version" integer NOT NULL,
	"pending_status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_pending_provider_authorizations_config_version_positive" CHECK ("mcp_gateway_pending_provider_authorizations"."config_version" > 0),
	CONSTRAINT "mcp_gateway_pending_provider_authorizations_owner_scope" CHECK ("mcp_gateway_pending_provider_authorizations"."owner_scope" IN ('personal', 'organization')),
	CONSTRAINT "mcp_gateway_pending_provider_authorizations_auth_mode" CHECK ("mcp_gateway_pending_provider_authorizations"."auth_mode" IN ('none', 'static_headers', 'oauth_dynamic', 'oauth_static')),
	CONSTRAINT "mcp_gateway_pending_provider_authorizations_status" CHECK ("mcp_gateway_pending_provider_authorizations"."pending_status" IN ('pending', 'completed', 'error'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_provider_grants" (
	"provider_grant_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"encrypted_grant" text NOT NULL,
	"provider_subject" text,
	"grant_scope" text,
	"expires_at" timestamp with time zone,
	"grant_status" text DEFAULT 'active' NOT NULL,
	"grant_version" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_provider_grants_version_positive" CHECK ("mcp_gateway_provider_grants"."grant_version" > 0),
	CONSTRAINT "mcp_gateway_provider_grants_status" CHECK ("mcp_gateway_provider_grants"."grant_status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_rate_limit_windows" (
	"rate_limit_window_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"ip_hash" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_rate_limit_windows_attempt_count_non_negative" CHECK ("mcp_gateway_rate_limit_windows"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_refresh_tokens" (
	"refresh_token_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"rotated_from_refresh_token_id" uuid,
	"oauth_client_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"owner_scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"config_id" uuid NOT NULL,
	"route_key" text NOT NULL,
	"canonical_resource_url" text NOT NULL,
	"granted_scopes" text[] NOT NULL,
	"execution_context" jsonb NOT NULL,
	"kilo_user_id" text NOT NULL,
	"instance_id" uuid NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_gateway_refresh_tokens_owner_scope" CHECK ("mcp_gateway_refresh_tokens"."owner_scope" IN ('personal', 'organization'))
);
--> statement-breakpoint
ALTER TABLE "mcp_gateway_assignments" ADD CONSTRAINT "mcp_gateway_assignments_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_assignments" ADD CONSTRAINT "mcp_gateway_assignments_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_assignments" ADD CONSTRAINT "mcp_gateway_assignments_assigned_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("assigned_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_audit_events" ADD CONSTRAINT "mcp_gateway_audit_events_actor_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("actor_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_audit_events" ADD CONSTRAINT "mcp_gateway_audit_events_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_audit_events" ADD CONSTRAINT "mcp_gateway_audit_events_connect_resource_id_mcp_gateway_connect_resources_connect_resource_id_fk" FOREIGN KEY ("connect_resource_id") REFERENCES "public"."mcp_gateway_connect_resources"("connect_resource_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_audit_events" ADD CONSTRAINT "mcp_gateway_audit_events_instance_id_mcp_gateway_connection_instances_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."mcp_gateway_connection_instances"("instance_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_codes" ADD CONSTRAINT "mcp_gateway_authorization_codes_authorization_request_id_mcp_gateway_authorization_requests_authorization_request_id_fk" FOREIGN KEY ("authorization_request_id") REFERENCES "public"."mcp_gateway_authorization_requests"("authorization_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_codes" ADD CONSTRAINT "mcp_gateway_authorization_codes_oauth_client_id_mcp_gateway_oauth_clients_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."mcp_gateway_oauth_clients"("oauth_client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_codes" ADD CONSTRAINT "mcp_gateway_authorization_codes_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_codes" ADD CONSTRAINT "mcp_gateway_authorization_codes_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_codes" ADD CONSTRAINT "mcp_gateway_authorization_codes_instance_id_mcp_gateway_connection_instances_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."mcp_gateway_connection_instances"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_requests" ADD CONSTRAINT "mcp_gateway_authorization_requests_oauth_client_id_mcp_gateway_oauth_clients_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."mcp_gateway_oauth_clients"("oauth_client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_requests" ADD CONSTRAINT "mcp_gateway_authorization_requests_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_requests" ADD CONSTRAINT "mcp_gateway_authorization_requests_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_authorization_requests" ADD CONSTRAINT "mcp_gateway_authorization_requests_instance_id_mcp_gateway_connection_instances_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."mcp_gateway_connection_instances"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_config_secrets" ADD CONSTRAINT "mcp_gateway_config_secrets_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_configs" ADD CONSTRAINT "mcp_gateway_configs_created_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("created_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_connect_resources" ADD CONSTRAINT "mcp_gateway_connect_resources_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_connection_instances" ADD CONSTRAINT "mcp_gateway_connection_instances_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_connection_instances" ADD CONSTRAINT "mcp_gateway_connection_instances_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_pending_provider_authorizations" ADD CONSTRAINT "mcp_gateway_pending_provider_authorizations_authorization_request_id_mcp_gateway_authorization_requests_authorization_request_id_fk" FOREIGN KEY ("authorization_request_id") REFERENCES "public"."mcp_gateway_authorization_requests"("authorization_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_pending_provider_authorizations" ADD CONSTRAINT "mcp_gateway_pending_provider_authorizations_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_pending_provider_authorizations" ADD CONSTRAINT "mcp_gateway_pending_provider_authorizations_instance_id_mcp_gateway_connection_instances_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."mcp_gateway_connection_instances"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_pending_provider_authorizations" ADD CONSTRAINT "mcp_gateway_pending_provider_authorizations_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_provider_grants" ADD CONSTRAINT "mcp_gateway_provider_grants_instance_id_mcp_gateway_connection_instances_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."mcp_gateway_connection_instances"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_refresh_tokens" ADD CONSTRAINT "mcp_gateway_refresh_tokens_oauth_client_id_mcp_gateway_oauth_clients_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."mcp_gateway_oauth_clients"("oauth_client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_refresh_tokens" ADD CONSTRAINT "mcp_gateway_refresh_tokens_config_id_mcp_gateway_configs_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_gateway_configs"("config_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_refresh_tokens" ADD CONSTRAINT "mcp_gateway_refresh_tokens_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_refresh_tokens" ADD CONSTRAINT "mcp_gateway_refresh_tokens_instance_id_mcp_gateway_connection_instances_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."mcp_gateway_connection_instances"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_assignments_active" ON "mcp_gateway_assignments" USING btree ("config_id","kilo_user_id") WHERE "mcp_gateway_assignments"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_assignments_single_user_slot" ON "mcp_gateway_assignments" USING btree ("config_id","single_user_slot") WHERE "mcp_gateway_assignments"."revoked_at" is null and "mcp_gateway_assignments"."single_user_slot" is not null;--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_assignments_config" ON "mcp_gateway_assignments" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_assignments_user" ON "mcp_gateway_assignments" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_audit_events_config" ON "mcp_gateway_audit_events" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_audit_events_owner" ON "mcp_gateway_audit_events" USING btree ("owner_scope","owner_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_audit_events_created_at" ON "mcp_gateway_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_authorization_codes_code_hash" ON "mcp_gateway_authorization_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_authorization_codes_expires_at" ON "mcp_gateway_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_authorization_codes_client" ON "mcp_gateway_authorization_codes" USING btree ("oauth_client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_authorization_requests_state_hash" ON "mcp_gateway_authorization_requests" USING btree ("request_state_hash");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_authorization_requests_config" ON "mcp_gateway_authorization_requests" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_authorization_requests_user" ON "mcp_gateway_authorization_requests" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_authorization_requests_expires_at" ON "mcp_gateway_authorization_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_config_secrets_active_kind" ON "mcp_gateway_config_secrets" USING btree ("config_id","secret_kind") WHERE "mcp_gateway_config_secrets"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_config_secrets_config" ON "mcp_gateway_config_secrets" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_configs_owner" ON "mcp_gateway_configs" USING btree ("owner_scope","owner_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_configs_enabled" ON "mcp_gateway_configs" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_configs_remote_url" ON "mcp_gateway_configs" USING btree ("remote_url");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_connect_resources_route_key" ON "mcp_gateway_connect_resources" USING btree ("route_key");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_connect_resources_active_config" ON "mcp_gateway_connect_resources" USING btree ("config_id") WHERE "mcp_gateway_connect_resources"."route_status" = 'active';--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_connect_resources_config" ON "mcp_gateway_connect_resources" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_connect_resources_canonical_url" ON "mcp_gateway_connect_resources" USING btree ("canonical_url");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_connection_instances_non_terminal" ON "mcp_gateway_connection_instances" USING btree ("owner_scope","owner_id","kilo_user_id","config_id") WHERE "mcp_gateway_connection_instances"."instance_status" IN ('active', 'needs_reauth');--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_connection_instances_config" ON "mcp_gateway_connection_instances" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_connection_instances_user" ON "mcp_gateway_connection_instances" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_oauth_clients_client_id" ON "mcp_gateway_oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_oauth_clients_registration_token_hash" ON "mcp_gateway_oauth_clients" USING btree ("registration_token_hash");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_oauth_clients_deleted_at" ON "mcp_gateway_oauth_clients" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_pending_provider_authorizations_state_hash" ON "mcp_gateway_pending_provider_authorizations" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_pending_provider_authorizations_config" ON "mcp_gateway_pending_provider_authorizations" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_pending_provider_authorizations_expires_at" ON "mcp_gateway_pending_provider_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_provider_grants_active_instance" ON "mcp_gateway_provider_grants" USING btree ("instance_id") WHERE "mcp_gateway_provider_grants"."grant_status" = 'active';--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_provider_grants_instance" ON "mcp_gateway_provider_grants" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_rate_limit_windows_ip_window" ON "mcp_gateway_rate_limit_windows" USING btree ("ip_hash","window_started_at");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_rate_limit_windows_window" ON "mcp_gateway_rate_limit_windows" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_gateway_refresh_tokens_token_hash" ON "mcp_gateway_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_refresh_tokens_user" ON "mcp_gateway_refresh_tokens" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_refresh_tokens_config" ON "mcp_gateway_refresh_tokens" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_gateway_refresh_tokens_consumed_at" ON "mcp_gateway_refresh_tokens" USING btree ("consumed_at");