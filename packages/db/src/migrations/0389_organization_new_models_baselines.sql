CREATE TABLE "organization_new_models_baselines" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_new_models_baselines" ADD CONSTRAINT "organization_new_models_baselines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;