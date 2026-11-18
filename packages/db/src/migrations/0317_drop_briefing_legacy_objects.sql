-- Each transaction locks at most one busy table, so no lock cycle with live traffic can form.
-- lock_timeout makes the migration fail fast instead of queueing writes behind it.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_briefing_events" DROP CONSTRAINT IF EXISTS "agent_briefing_events_session_fk";--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_briefing_reports" DROP CONSTRAINT IF EXISTS "agent_briefing_reports_kilo_user_id_kilocode_users_id_fk";--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_briefing_reports" DROP CONSTRAINT IF EXISTS "agent_briefing_reports_organization_id_organizations_id_fk";--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP TABLE IF EXISTS "agent_briefing_events";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_briefing_reports";--> statement-breakpoint
ALTER TABLE "agent_briefing_context_preferences" DROP COLUMN IF EXISTS "ai_enabled";--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
