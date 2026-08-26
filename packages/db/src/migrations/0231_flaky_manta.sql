CREATE TABLE "organization_domain_claims" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"workos_organization_id" text,
	"workos_domain_id" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_domain_claims_organization_domain" UNIQUE("organization_id","domain"),
	CONSTRAINT "organization_domain_claims_canonical_domain_check" CHECK (length("organization_domain_claims"."domain") BETWEEN 1 AND 253 AND "organization_domain_claims"."domain" = lower(btrim("organization_domain_claims"."domain"))),
	CONSTRAINT "organization_domain_claims_status_check" CHECK ("organization_domain_claims"."status" IN ('pending', 'verified')),
	CONSTRAINT "organization_domain_claims_verification_shape_check" CHECK (("organization_domain_claims"."status" = 'pending' AND "organization_domain_claims"."verified_at" IS NULL)
        OR ("organization_domain_claims"."status" = 'verified' AND "organization_domain_claims"."verified_at" IS NOT NULL AND "organization_domain_claims"."workos_organization_id" IS NOT NULL AND "organization_domain_claims"."workos_domain_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "organization_domain_claims" ADD CONSTRAINT "organization_domain_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_organization_domain_claims_verified_domain" ON "organization_domain_claims" USING btree ("domain") WHERE "organization_domain_claims"."status" = 'verified';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_organization_domain_claims_workos_domain_id" ON "organization_domain_claims" USING btree ("workos_domain_id") WHERE "organization_domain_claims"."workos_domain_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_organization_domain_claims_organization_id" ON "organization_domain_claims" USING btree ("organization_id");