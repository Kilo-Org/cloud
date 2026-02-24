ALTER TABLE "models_by_provider" ALTER COLUMN "data" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "models_by_provider" ADD COLUMN "vercel_providers" jsonb;