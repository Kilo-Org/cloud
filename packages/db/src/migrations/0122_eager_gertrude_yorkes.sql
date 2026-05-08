DELETE FROM "bot_requests" WHERE "platform_message_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "bot_requests" ALTER COLUMN "platform_message_id" SET NOT NULL;
