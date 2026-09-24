CREATE TABLE "organization_e2b_compute_credentials" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_encrypted" jsonb NOT NULL,
	"consent_version" text NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_e2b_compute_credentials_organization" UNIQUE("organization_id"),
	CONSTRAINT "organization_e2b_compute_credentials_consent_version_check" CHECK ("organization_e2b_compute_credentials"."consent_version" = 'e2b-direct-v1')
);
--> statement-breakpoint
ALTER TABLE "organization_e2b_compute_credentials" ADD CONSTRAINT "organization_e2b_compute_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;