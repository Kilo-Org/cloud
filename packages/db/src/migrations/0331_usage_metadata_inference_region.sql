CREATE TABLE "inference_region" (
	"inference_region_id" serial PRIMARY KEY NOT NULL,
	"inference_region" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "microdollar_usage_metadata" ADD COLUMN "inference_region_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_inference_region" ON "inference_region" USING btree ("inference_region");