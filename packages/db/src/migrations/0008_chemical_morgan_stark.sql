ALTER TABLE "deployments" ADD COLUMN "internal_worker_name" text;
UPDATE "deployments" SET "internal_worker_name" = "deployment_slug" WHERE "internal_worker_name" IS NULL;
ALTER TABLE "deployments" ALTER COLUMN "internal_worker_name" SET NOT NULL;
