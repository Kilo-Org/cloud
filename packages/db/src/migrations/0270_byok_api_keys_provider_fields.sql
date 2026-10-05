ALTER TABLE "byok_api_keys" ADD COLUMN IF NOT EXISTS "base_url" TEXT;--> statement-breakpoint
ALTER TABLE "byok_api_keys" ADD COLUMN IF NOT EXISTS "display_name" TEXT;--> statement-breakpoint
ALTER TABLE "byok_api_keys" ADD COLUMN IF NOT EXISTS "provider_api" TEXT;
