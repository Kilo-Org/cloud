ALTER TABLE "kiloclaw_cli_runs" ADD COLUMN "instance_id" uuid;--> statement-breakpoint
ALTER TABLE "kiloclaw_cli_runs" ADD CONSTRAINT "kiloclaw_cli_runs_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_cli_runs_instance_id" ON "kiloclaw_cli_runs" USING btree ("instance_id");--> statement-breakpoint
UPDATE "kiloclaw_cli_runs" AS r
SET "instance_id" = i."id"
FROM "kiloclaw_instances" AS i
WHERE r."instance_id" IS NULL
  AND r."user_id" = i."user_id"
  AND i."organization_id" IS NULL
  AND i."destroyed_at" IS NULL;