CREATE TABLE "organization_new_models_baselines" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_new_models_baselines" ADD CONSTRAINT "organization_new_models_baselines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "organization_new_models_baselines" ("organization_id", "snapshot_id")
SELECT "organizations"."id", latest."id"
FROM "organizations"
CROSS JOIN (SELECT max("id") AS "id" FROM "models_by_provider") latest
WHERE "organizations"."settings"->>'disable_new_models' = 'true'
  AND "organizations"."deleted_at" IS NULL
  AND latest."id" IS NOT NULL
ON CONFLICT ("organization_id") DO NOTHING;
