CREATE TABLE "ai_gateway_metadata_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_gateway_sync_providers_state" ADD COLUMN "metadata_cache_stale_alert_last_posted_at" timestamp with time zone;