ALTER TABLE "kiloclaw_image_catalog" ADD COLUMN "rollout_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_image_catalog" ADD COLUMN "is_latest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD COLUMN "auto_enroll_in_rollouts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_image_catalog_is_latest" ON "kiloclaw_image_catalog" USING btree ("variant") WHERE "kiloclaw_image_catalog"."is_latest" = true;--> statement-breakpoint

-- Backfill: mark the most recently published 'available' image per variant as :latest.
-- Preserves current production behavior — whatever was :latest before this migration
-- stays :latest. Newly published images post-migration land at is_latest=false and
-- rollout_percent=0; ops promotes them explicitly via the admin Versions page.
--
-- POST-DEPLOY STEP (required if an image was disabled between its registration
-- and this migration): the KV pointer image-version:latest:<variant> was last
-- written by the old registerVersionIfNeeded flow. If that pointer no longer
-- matches the row this backfill marks as is_latest, the resolver will keep
-- returning the stale KV value until the pointer is rewritten.
--
-- To force a sync: in the admin Versions page (/admin/kiloclaw?tab=versions),
-- click "Make :latest" on the row that should be :latest. This calls
-- refreshPointersForVariant() and reconciles KV from Postgres. A no-op if
-- the row is already marked is_latest.
UPDATE "kiloclaw_image_catalog" SET "is_latest" = true WHERE id IN (
  SELECT DISTINCT ON ("variant") id
  FROM "kiloclaw_image_catalog"
  WHERE status = 'available'
  ORDER BY "variant", "published_at" DESC
);