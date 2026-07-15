ALTER TABLE "platform_access_token_credentials" DROP CONSTRAINT "UQ_platform_access_token_credentials_platform_integration_id";--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ALTER COLUMN "provider_scopes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ALTER COLUMN "provider_verified_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ALTER COLUMN "last_validated_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_oauth_credentials" ALTER COLUMN "authorized_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_oauth_credentials" ALTER COLUMN "refresh_token_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ADD COLUMN "provider_resource_id" text;--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ADD COLUMN "provider_base_url" text;--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ADD COLUMN "authorized_by_user_id" text;--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ADD COLUMN "provider_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "platform_oauth_credentials" ADD COLUMN "provider_base_url" text;--> statement-breakpoint
ALTER TABLE "platform_oauth_credentials" ADD COLUMN "oauth_client_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ADD CONSTRAINT "platform_access_token_credentials_authorized_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_access_token_credentials_integration_level" ON "platform_access_token_credentials" USING btree ("platform_integration_id") WHERE "platform_access_token_credentials"."provider_resource_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_access_token_credentials_resource" ON "platform_access_token_credentials" USING btree ("platform_integration_id","provider_credential_type","provider_resource_id") WHERE "platform_access_token_credentials"."provider_resource_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_platform_access_token_credentials_authorized_by_user_id" ON "platform_access_token_credentials" USING btree ("authorized_by_user_id");--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ADD CONSTRAINT "platform_access_token_credentials_credential_version_check" CHECK ("platform_access_token_credentials"."credential_version" > 0);--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ADD CONSTRAINT "platform_access_token_credentials_resource_id_check" CHECK ("platform_access_token_credentials"."provider_resource_id" IS NULL OR "platform_access_token_credentials"."provider_resource_id" <> '');--> statement-breakpoint
ALTER TABLE "platform_oauth_credentials" ADD CONSTRAINT "platform_oauth_credentials_credential_version_check" CHECK ("platform_oauth_credentials"."credential_version" > 0);