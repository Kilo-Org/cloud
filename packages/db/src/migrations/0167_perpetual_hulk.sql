CREATE TABLE "mcp_native_authorization_codes" (
	"authorization_code_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"oauth_client_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"canonical_resource_url" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"granted_scopes" text[] NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"kilo_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_native_refresh_tokens" (
	"refresh_token_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"rotated_from_refresh_token_id" uuid,
	"oauth_client_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"canonical_resource_url" text NOT NULL,
	"granted_scopes" text[] NOT NULL,
	"kilo_user_id" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_native_authorization_codes" ADD CONSTRAINT "mcp_native_authorization_codes_oauth_client_id_mcp_gateway_oauth_clients_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."mcp_gateway_oauth_clients"("oauth_client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_native_authorization_codes" ADD CONSTRAINT "mcp_native_authorization_codes_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_native_refresh_tokens" ADD CONSTRAINT "mcp_native_refresh_tokens_oauth_client_id_mcp_gateway_oauth_clients_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."mcp_gateway_oauth_clients"("oauth_client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_native_refresh_tokens" ADD CONSTRAINT "mcp_native_refresh_tokens_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_native_authorization_codes_code_hash" ON "mcp_native_authorization_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "IDX_mcp_native_authorization_codes_user" ON "mcp_native_authorization_codes" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_native_authorization_codes_client" ON "mcp_native_authorization_codes" USING btree ("oauth_client_id","client_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_native_authorization_codes_expires_at" ON "mcp_native_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_mcp_native_refresh_tokens_token_hash" ON "mcp_native_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "IDX_mcp_native_refresh_tokens_user" ON "mcp_native_refresh_tokens" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_native_refresh_tokens_client" ON "mcp_native_refresh_tokens" USING btree ("oauth_client_id","client_id");--> statement-breakpoint
CREATE INDEX "IDX_mcp_native_refresh_tokens_consumed_revoked" ON "mcp_native_refresh_tokens" USING btree ("consumed_at","revoked_at");