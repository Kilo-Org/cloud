CREATE TABLE "organization_membership_removals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by" text,
	"previous_role" text NOT NULL,
	CONSTRAINT "UQ_org_membership_removals_org_user" UNIQUE("organization_id","kilo_user_id")
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "require_seats" SET DEFAULT true;--> statement-breakpoint
CREATE INDEX "IDX_org_membership_removals_org_id" ON "organization_membership_removals" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_org_membership_removals_user_id" ON "organization_membership_removals" USING btree ("kilo_user_id");