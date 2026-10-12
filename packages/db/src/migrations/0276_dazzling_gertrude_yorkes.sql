ALTER TABLE "user_activity_tokens" ADD COLUMN "session_id" text;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_user_activity_tokens_live_session" ON "user_activity_tokens" USING btree ("user_id","session_id") WHERE "user_activity_tokens"."kind" = 'ios_session_activity' AND "user_activity_tokens"."superseded_at" IS NULL;--> statement-breakpoint
BEGIN;
