ALTER TABLE "cli_sessions_v2" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "status_updated_at" timestamp with time zone;