ALTER TABLE "platform_access_token_credentials" ALTER COLUMN "owned_by_organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ALTER COLUMN "platform" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_access_token_credentials" ALTER COLUMN "integration_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_oauth_credentials" ALTER COLUMN "platform" DROP NOT NULL;