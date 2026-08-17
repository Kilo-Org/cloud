CREATE TABLE "slack_oauth_credentials" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"platform_integration_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_enterprise_id" text,
	"is_enterprise_install" boolean DEFAULT false NOT NULL,
	"bot_user_id" text,
	"access_token_encrypted" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_encrypted" text,
	"granted_scopes" text[],
	"credential_version" integer DEFAULT 1 NOT NULL,
	"refresh_claimed_at" timestamp with time zone,
	"refresh_attempt_count" integer DEFAULT 0 NOT NULL,
	"next_refresh_attempt_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_oauth_credentials_credential_version_check" CHECK ("slack_oauth_credentials"."credential_version" > 0),
	CONSTRAINT "slack_oauth_credentials_refresh_attempt_count_check" CHECK ("slack_oauth_credentials"."refresh_attempt_count" >= 0),
	CONSTRAINT "slack_oauth_credentials_slack_team_id_check" CHECK ("slack_oauth_credentials"."slack_team_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "slack_oauth_credentials" ADD CONSTRAINT "slack_oauth_credentials_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_slack_oauth_credentials_platform_integration_id" ON "slack_oauth_credentials" USING btree ("platform_integration_id");--> statement-breakpoint
CREATE INDEX "IDX_slack_oauth_credentials_slack_team_id" ON "slack_oauth_credentials" USING btree ("slack_team_id");--> statement-breakpoint
CREATE INDEX "IDX_slack_oauth_credentials_refresh_due" ON "slack_oauth_credentials" USING btree ("access_token_expires_at") WHERE "slack_oauth_credentials"."revoked_at" is null;