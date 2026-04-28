ALTER TABLE "kiloclaw_image_catalog" ADD COLUMN "rollout_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_image_catalog" ADD COLUMN "is_latest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD COLUMN "auto_enroll_in_rollouts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_image_catalog_is_latest" ON "kiloclaw_image_catalog" USING btree ("variant") WHERE "kiloclaw_image_catalog"."is_latest" = true;--> statement-breakpoint

-- Backfill: mark the most recently published 'available' image per variant as :latest.
-- Preserves current production behavior — whatever was :latest before this migration
-- stays :latest. Newly published images post-migration land at is_latest=false and
-- rollout_percent=0; ops promotes them explicitly via the admin Versions page.
UPDATE "kiloclaw_image_catalog" SET "is_latest" = true WHERE id IN (
  SELECT DISTINCT ON ("variant") id
  FROM "kiloclaw_image_catalog"
  WHERE status = 'available'
  ORDER BY "variant", "published_at" DESC
);