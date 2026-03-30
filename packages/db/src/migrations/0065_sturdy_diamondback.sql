ALTER TABLE "api_request_log" ADD COLUMN "feature" text;--> statement-breakpoint
ALTER TABLE "api_request_log" ADD COLUMN "api_kind" text;--> statement-breakpoint
ALTER TABLE "api_request_log" ADD COLUMN "session_id" text;