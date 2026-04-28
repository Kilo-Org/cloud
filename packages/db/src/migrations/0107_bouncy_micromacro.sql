ALTER TABLE "kilocode_users" ADD COLUMN "kiloclaw_early_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" DROP COLUMN "auto_enroll_in_rollouts";