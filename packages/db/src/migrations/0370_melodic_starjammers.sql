DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cloud_agent_pending_uploads_status_check'
      AND conrelid = 'public.cloud_agent_pending_uploads'::regclass
      AND pg_get_constraintdef(oid) LIKE '%released%'
  ) THEN
ALTER TABLE "cloud_agent_pending_uploads" DROP CONSTRAINT "cloud_agent_pending_uploads_status_check";
DROP INDEX "IDX_cloud_agent_pending_uploads_expired";
ALTER TABLE "cloud_agent_pending_uploads" ADD CONSTRAINT "cloud_agent_pending_uploads_status_check" CHECK ("cloud_agent_pending_uploads"."status" IN ('pending', 'linked', 'released', 'reaped'));
  END IF;
END $$;--> statement-breakpoint
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_pending_uploads_expired";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_pending_uploads_expired" ON "cloud_agent_pending_uploads" USING btree ("expires_at") WHERE "cloud_agent_pending_uploads"."status" IN ('pending', 'released');--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;
