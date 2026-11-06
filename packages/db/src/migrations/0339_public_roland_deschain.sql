ALTER TABLE "user_github_app_tokens" ALTER COLUMN "access_token_expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_github_app_tokens" ALTER COLUMN "refresh_token_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_github_app_tokens" ALTER COLUMN "refresh_token_expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_github_app_tokens" ADD COLUMN "credential_source" text DEFAULT 'github_app' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_github_app_tokens" ADD CONSTRAINT "user_github_app_tokens_source_check" CHECK (("user_github_app_tokens"."credential_source" = 'github_app'
        AND "user_github_app_tokens"."access_token_expires_at" IS NOT NULL
        AND "user_github_app_tokens"."refresh_token_encrypted" IS NOT NULL
        AND "user_github_app_tokens"."refresh_token_expires_at" IS NOT NULL)
        OR ("user_github_app_tokens"."credential_source" = 'provided_token'
        AND "user_github_app_tokens"."github_app_type" = 'standard'
        AND "user_github_app_tokens"."refresh_token_encrypted" IS NULL
        AND "user_github_app_tokens"."refresh_token_expires_at" IS NULL));