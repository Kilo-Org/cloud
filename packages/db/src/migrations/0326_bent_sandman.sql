-- The first transaction is atomic, so the directory_id column marks whether all of it already applied.
-- A failed concurrent index build commits this part without recording the migration.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'directory_id'
	) THEN
		ALTER TABLE "organizations" ADD COLUMN "directory_id" text;
		ALTER TABLE "organizations" ADD COLUMN "directory_group_id" text;
		ALTER TABLE "organizations" ADD COLUMN "directory_idp_id" text;
		ALTER TABLE "organizations" ADD COLUMN "external_org_id" text;
	END IF;
END $$;--> statement-breakpoint
COMMIT;--> statement-breakpoint
-- The server default statement_timeout can cancel these concurrent builds in production.
SET statement_timeout = 0;--> statement-breakpoint
-- A cancelled build leaves an INVALID index under its name; drop each so a retry rebuilds it.
DROP INDEX CONCURRENTLY IF EXISTS "UQ_organizations_directory_group_id";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_organizations_directory_group_id" ON "organizations" USING btree ("directory_group_id") WHERE "organizations"."directory_group_id" IS NOT NULL AND "organizations"."deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_organizations_external_org_id";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_organizations_external_org_id" ON "organizations" USING btree ("external_org_id") WHERE "organizations"."external_org_id" IS NOT NULL AND "organizations"."deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_organizations_directory_idp_id";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_organizations_directory_idp_id" ON "organizations" USING btree ("directory_idp_id") WHERE "organizations"."directory_idp_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_organizations_directory_id";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_organizations_directory_id" ON "organizations" USING btree ("directory_id") WHERE "organizations"."directory_id" IS NOT NULL;--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;