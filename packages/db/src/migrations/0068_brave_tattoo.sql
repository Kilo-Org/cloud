ALTER TABLE "kiloclaw_version_pins" RENAME COLUMN "user_id" TO "instance_id";--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ALTER COLUMN "instance_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" DROP CONSTRAINT "kiloclaw_version_pins_user_id_unique";--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" DROP CONSTRAINT "kiloclaw_version_pins_user_id_kilocode_users_id_fk";
--> statement-breakpoint
UPDATE "kiloclaw_version_pins" AS p
SET "instance_id" = i."id"::text
FROM "kiloclaw_instances" AS i
WHERE i."user_id" = p."instance_id"
  AND i."organization_id" IS NULL
  AND i."destroyed_at" IS NULL;--> statement-breakpoint
DELETE FROM "kiloclaw_version_pins" WHERE "instance_id" IS NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ALTER COLUMN "instance_id" TYPE uuid USING "instance_id"::uuid;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ALTER COLUMN "instance_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ADD CONSTRAINT "kiloclaw_version_pins_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ADD CONSTRAINT "kiloclaw_version_pins_instance_id_unique" UNIQUE("instance_id");
