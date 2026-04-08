DROP INDEX "UQ_user_push_tokens_user_token";--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_push_tokens_token" ON "user_push_tokens" USING btree ("token");