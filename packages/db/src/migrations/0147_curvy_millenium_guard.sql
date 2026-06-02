ALTER TABLE "kiloclaw_composio_identities" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "kiloclaw_composio_identities" CASCADE;--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" DROP CONSTRAINT "kiloclaw_instances_composio_config_source_check";--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" DROP COLUMN "composio_config_source";