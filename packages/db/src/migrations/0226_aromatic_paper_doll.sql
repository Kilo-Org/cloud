COMMIT;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_user_auth_provider_lower_email" ON "user_auth_provider" USING btree (lower("email"));
--> statement-breakpoint
BEGIN;
