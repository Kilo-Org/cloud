ALTER TABLE "cli_sessions_v2" ADD COLUMN "live_summary" jsonb;--> statement-breakpoint
ALTER TABLE "user_activity_tokens" ADD COLUMN "session_id" text;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_user_activity_tokens_live_session" ON "user_activity_tokens" USING btree ("user_id","session_id") WHERE "user_activity_tokens"."kind" IN ('ios_session_activity', 'android_session_ongoing') AND "user_activity_tokens"."superseded_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_user_activity_tokens_token_session" ON "user_activity_tokens" USING btree ("token","session_id") NULLS NOT DISTINCT;--> statement-breakpoint
BEGIN;--> statement-breakpoint
ALTER TABLE "user_activity_tokens" ADD CONSTRAINT "UQ_user_activity_tokens_token_session" UNIQUE USING INDEX "UQ_user_activity_tokens_token_session";--> statement-breakpoint
DROP INDEX "UQ_user_activity_tokens_token";