ALTER TABLE "platform_integrations" ADD COLUMN "auth_invalid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD COLUMN "auth_invalid_reason" text;