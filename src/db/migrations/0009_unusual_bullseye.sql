ALTER TABLE "kiloclaw_instances" DROP CONSTRAINT "kiloclaw_instances_status_check";--> statement-breakpoint
DROP INDEX "UQ_kiloclaw_instances_active_user";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_instances_sandbox_id";--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD COLUMN "channels" jsonb;--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD COLUMN "vars" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_instances_active" ON "kiloclaw_instances" USING btree ("user_id","sandbox_id") WHERE "kiloclaw_instances"."destroyed_at" is null;--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" DROP COLUMN "last_started_at";--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" DROP COLUMN "last_stopped_at";