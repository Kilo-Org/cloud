ALTER TABLE "ai_gateway_sync_providers_state" ADD COLUMN "last_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_gateway_sync_providers_state" ADD COLUMN "last_failure_message" text;--> statement-breakpoint
ALTER TABLE "ai_gateway_sync_providers_state" ADD COLUMN "refresh_failures" jsonb DEFAULT '{}'::jsonb NOT NULL;