ALTER TABLE "cli_sessions_v2" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD CONSTRAINT "cli_sessions_v2_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_profile_id" ON "cli_sessions_v2" USING btree ("profile_id");--> statement-breakpoint
BEGIN;
