CREATE TABLE "kiloclaw_version_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"image_tag" text NOT NULL,
	"pinned_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiloclaw_version_pins_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ADD CONSTRAINT "kiloclaw_version_pins_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ADD CONSTRAINT "kiloclaw_version_pins_image_tag_kiloclaw_image_catalog_image_tag_fk" FOREIGN KEY ("image_tag") REFERENCES "public"."kiloclaw_image_catalog"("image_tag") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ADD CONSTRAINT "kiloclaw_version_pins_pinned_by_kilocode_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;