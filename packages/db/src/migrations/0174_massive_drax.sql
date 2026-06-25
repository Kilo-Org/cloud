ALTER TABLE "organizations" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_unique" UNIQUE("slug");