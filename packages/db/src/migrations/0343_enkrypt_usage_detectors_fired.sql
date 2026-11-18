CREATE TABLE "enkrypt_usage_detector" (
	"detector_id" serial PRIMARY KEY NOT NULL,
	"detector" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enkrypt_usage" ADD COLUMN "fired_detector_ids" integer[];--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_enkrypt_usage_detector" ON "enkrypt_usage_detector" USING btree ("detector");