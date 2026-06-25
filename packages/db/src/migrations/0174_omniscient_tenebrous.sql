ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "slug" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "requested_slug" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT IF NOT EXISTS "organizations_slug_unique" UNIQUE("slug");
