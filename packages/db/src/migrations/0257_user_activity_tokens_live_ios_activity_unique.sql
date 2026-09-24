COMMIT; -- Custom SQL migration file, put your code below! --
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_user_activity_tokens_live_ios_activity";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_user_activity_tokens_live_ios_activity" ON "user_activity_tokens" USING btree ("user_id",coalesce("organization_id", '')) WHERE "user_activity_tokens"."kind" = 'ios_activity' AND "user_activity_tokens"."superseded_at" IS NULL;--> statement-breakpoint
BEGIN;
