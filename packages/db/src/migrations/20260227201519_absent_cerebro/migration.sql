CREATE TABLE "kiloclaw_image_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"openclaw_version" text NOT NULL,
	"variant" text DEFAULT 'default' NOT NULL,
	"image_tag" text NOT NULL,
	"image_digest" text,
	"status" text DEFAULT 'available' NOT NULL,
	"description" text,
	"updated_by" text,
	"published_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiloclaw_image_catalog_image_tag_unique" UNIQUE("image_tag")
);
--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_image_catalog_status" ON "kiloclaw_image_catalog" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_image_catalog_variant" ON "kiloclaw_image_catalog" USING btree ("variant");