ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_cli_session_id_cli_sessions_session_id_fk";
--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "cli_session_id" SET DATA TYPE text;