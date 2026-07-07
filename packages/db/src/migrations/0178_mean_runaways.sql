ALTER TABLE "organizations" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_max_length_check" CHECK ("organizations"."slug" IS NULL OR length("organizations"."slug") <= 32) NOT VALID;--> statement-breakpoint
ALTER TABLE "organizations" VALIDATE CONSTRAINT "organizations_slug_max_length_check";
