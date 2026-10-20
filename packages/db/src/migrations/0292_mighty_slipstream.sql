ALTER TABLE "cli_sessions" ADD COLUMN "is_fork" boolean DEFAULT false NOT NULL;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_shared_cli_sessions_kilo_user_id" ON "shared_cli_sessions" USING btree ("kilo_user_id");--> statement-breakpoint
BEGIN;--> statement-breakpoint
-->  statement-breakpoint
UPDATE "cli_sessions" SET "is_fork" = true WHERE "forked_from" IS NOT NULL;
