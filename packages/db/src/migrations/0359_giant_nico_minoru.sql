COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_session_step_up_proofs_user_session_binding";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_session_step_up_proofs_user_session_binding" ON "session_step_up_proofs" USING btree ("kilo_user_id","session_id_hash","action_binding_hash");
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
BEGIN;
