ALTER TABLE "bot_request_cloud_agent_sessions" ADD COLUMN "final_message" text;--> statement-breakpoint
ALTER TABLE "bot_request_cloud_agent_sessions" ADD COLUMN "final_message_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_request_cloud_agent_sessions" ADD COLUMN "final_message_error" text;