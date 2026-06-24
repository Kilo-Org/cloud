CREATE TABLE "platform_access_token_credentials" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"platform_integration_id" uuid NOT NULL,
	"owned_by_organization_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"integration_type" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone,
	"provider_credential_type" text NOT NULL,
	"provider_scopes" text[] NOT NULL,
	"provider_verified_at" timestamp with time zone NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"last_validated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_platform_access_token_credentials_platform_integration_id" UNIQUE("platform_integration_id"),
	CONSTRAINT "platform_access_token_credentials_platform_check" CHECK ("platform_access_token_credentials"."platform" = 'bitbucket'),
	CONSTRAINT "platform_access_token_credentials_integration_type_check" CHECK ("platform_access_token_credentials"."integration_type" = 'workspace_access_token'),
	CONSTRAINT "platform_access_token_credentials_provider_type_check" CHECK ("platform_access_token_credentials"."provider_credential_type" = 'workspace_access_token'),
	CONSTRAINT "platform_access_token_credentials_version_positive_check" CHECK ("platform_access_token_credentials"."credential_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "platform_oauth_credentials" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"platform_integration_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"authorized_by_user_id" text NOT NULL,
	"provider_subject_id" text NOT NULL,
	"provider_subject_login" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_encrypted" text NOT NULL,
	"refresh_token_expires_at" timestamp with time zone,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ADD CONSTRAINT "FK_platform_access_token_credentials_parent" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_oauth_credentials" ADD CONSTRAINT "platform_oauth_credentials_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_oauth_credentials" ADD CONSTRAINT "platform_oauth_credentials_authorized_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_oauth_credentials_platform_integration_id" ON "platform_oauth_credentials" USING btree ("platform_integration_id");--> statement-breakpoint
CREATE INDEX "IDX_platform_oauth_credentials_platform_subject" ON "platform_oauth_credentials" USING btree ("platform","provider_subject_id");--> statement-breakpoint
CREATE INDEX "IDX_platform_oauth_credentials_authorized_by_user_id" ON "platform_oauth_credentials" USING btree ("authorized_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_user_bitbucket" ON "platform_integrations" USING btree ("owned_by_user_id","platform") WHERE "platform_integrations"."platform" = 'bitbucket' AND "platform_integrations"."owned_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_org_bitbucket" ON "platform_integrations" USING btree ("owned_by_organization_id","platform") WHERE "platform_integrations"."platform" = 'bitbucket' AND "platform_integrations"."owned_by_organization_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_access_token_auth_invalidation_pair_check" CHECK ((
        "platform_integrations"."platform" <> 'bitbucket' OR
        "platform_integrations"."integration_type" <> 'workspace_access_token' OR
        (
          ("platform_integrations"."auth_invalid_at" IS NULL AND "platform_integrations"."auth_invalid_reason" IS NULL) OR
          ("platform_integrations"."auth_invalid_at" IS NOT NULL AND "platform_integrations"."auth_invalid_reason" IS NOT NULL)
        )
      ));