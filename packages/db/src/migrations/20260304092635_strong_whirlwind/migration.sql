ALTER TABLE "cloud_agent_code_reviews" DROP CONSTRAINT "cloud_agent_code_reviews_cli_session_id_cli_sessions_session_id_fk";
--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ALTER COLUMN "cli_session_id" SET DATA TYPE text;