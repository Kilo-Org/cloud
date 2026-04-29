ALTER TABLE "kiloclaw_image_catalog" ADD COLUMN "rollout_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_image_catalog" ADD COLUMN "is_latest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD COLUMN "kiloclaw_early_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Backfill: mark the most recently published 'available' image per variant as :latest.
-- Preserves current production behavior. After this migration registerVersionIfNeeded()
-- stops auto promoting new images to :latest. Without this backfill no image would
-- have is_latest=true and the per variant :latest KV pointer would be cleared on the
-- next admin slider change.
--
-- POST DEPLOY STEP (only required if an image was disabled between its registration
-- and this migration): the KV pointer image-version:latest:<variant> was last written
-- by the old registerVersionIfNeeded flow. If that pointer no longer matches the row
-- this backfill marks as is_latest, the resolver will keep returning the stale KV
-- value until the pointer is rewritten. To force a sync: in the admin Versions page
-- (/admin/kiloclaw?tab=versions), click "Make :latest" on the row that should be
-- :latest. This calls refreshPointersForVariant() and reconciles KV from Postgres.
UPDATE "kiloclaw_image_catalog" SET "is_latest" = true WHERE id IN (
  SELECT DISTINCT ON ("variant") id
  FROM "kiloclaw_image_catalog"
  WHERE status = 'available'
  ORDER BY "variant", "published_at" DESC
);--> statement-breakpoint

CREATE UNIQUE INDEX "UQ_kiloclaw_image_catalog_one_latest_per_variant" ON "kiloclaw_image_catalog" USING btree ("variant") WHERE "kiloclaw_image_catalog"."is_latest" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_image_catalog_one_candidate_per_variant" ON "kiloclaw_image_catalog" USING btree ("variant") WHERE "kiloclaw_image_catalog"."is_latest" = false AND "kiloclaw_image_catalog"."rollout_percent" > 0 AND "kiloclaw_image_catalog"."status" = 'available';