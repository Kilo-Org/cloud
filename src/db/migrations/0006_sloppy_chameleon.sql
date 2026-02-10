ALTER TABLE "deployments" ADD COLUMN "created_from" text;--> statement-breakpoint
UPDATE "deployments" SET "created_from" = 'app_builder' WHERE "source_type" = 'app-builder';--> statement-breakpoint
UPDATE "deployments" SET "created_from" = 'deploy' WHERE "source_type" != 'app-builder';