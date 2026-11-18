ALTER TABLE "user_notification_preferences" ADD COLUMN "notification_previews" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_push_tokens" ADD COLUMN "app_version" text;
