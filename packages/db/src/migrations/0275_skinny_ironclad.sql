ALTER TABLE "ai_gateway_config" ADD COLUMN "preferred_models" jsonb;--> statement-breakpoint
ALTER TABLE "ai_gateway_config" ADD COLUMN "unavailable_models" jsonb;