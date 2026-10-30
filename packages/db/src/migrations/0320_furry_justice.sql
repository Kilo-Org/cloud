CREATE TABLE "oauth_refresh_exchange_leases" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"platform_oauth_credential_id" uuid,
	"user_github_app_token_id" uuid,
	"attempt_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_exchange_leases_owner_check" CHECK (num_nonnulls("oauth_refresh_exchange_leases"."platform_oauth_credential_id", "oauth_refresh_exchange_leases"."user_github_app_token_id") = 1),
	CONSTRAINT "oauth_refresh_exchange_leases_attempt_id_check" CHECK ("oauth_refresh_exchange_leases"."attempt_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "oauth_refresh_exchange_leases" ADD CONSTRAINT "oauth_refresh_exchange_leases_platform_oauth_credential_id_platform_oauth_credentials_id_fk" FOREIGN KEY ("platform_oauth_credential_id") REFERENCES "public"."platform_oauth_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_exchange_leases" ADD CONSTRAINT "oauth_refresh_exchange_leases_user_github_app_token_id_user_github_app_tokens_id_fk" FOREIGN KEY ("user_github_app_token_id") REFERENCES "public"."user_github_app_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_oauth_refresh_exchange_leases_platform_oauth_credential_id" ON "oauth_refresh_exchange_leases" USING btree ("platform_oauth_credential_id") WHERE "oauth_refresh_exchange_leases"."platform_oauth_credential_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_oauth_refresh_exchange_leases_user_github_app_token_id" ON "oauth_refresh_exchange_leases" USING btree ("user_github_app_token_id") WHERE "oauth_refresh_exchange_leases"."user_github_app_token_id" is not null;