CREATE TABLE "organization_recommendation_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid NOT NULL,
	"recommendation_key" text NOT NULL,
	"dismissed_by_user_id" text,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_org_recommendation_dismissals_org_key" UNIQUE("owned_by_organization_id","recommendation_key")
);
--> statement-breakpoint
ALTER TABLE "organization_recommendation_dismissals" ADD CONSTRAINT "organization_recommendation_dismissals_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_recommendation_dismissals" ADD CONSTRAINT "organization_recommendation_dismissals_dismissed_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;