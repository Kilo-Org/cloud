CREATE TABLE "sales_demo_spend_ledger" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_kilo_user_id" text,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone DEFAULT now() NOT NULL,
	"microdollars_used" bigint NOT NULL,
	CONSTRAINT "sales_demo_spend_ledger_spend_positive" CHECK ("sales_demo_spend_ledger"."microdollars_used" > 0)
);
--> statement-breakpoint
ALTER TABLE "sales_demo_spend_ledger" ADD CONSTRAINT "sales_demo_spend_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;