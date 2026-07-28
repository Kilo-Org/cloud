ALTER TABLE "user_notification_preferences" ADD COLUMN "chat_messages_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD COLUMN "agent_attention_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD COLUMN "session_status_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD COLUMN "kiloclaw_activity_enabled" boolean DEFAULT true NOT NULL;