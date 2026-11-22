CREATE TABLE "organization_default_policy_links" (
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"policy_id" uuid NOT NULL,
	CONSTRAINT "PK_organization_default_policy_links" PRIMARY KEY("organization_id","kind")
);
--> statement-breakpoint
CREATE TABLE "organization_group_policy_links" (
	"organization_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"policy_id" uuid NOT NULL,
	CONSTRAINT "PK_organization_group_policy_links" PRIMARY KEY("organization_id","group_id","kind")
);
--> statement-breakpoint
CREATE TABLE "organization_named_policies" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_named_policies_organization_kind_id" UNIQUE("organization_id","kind","id"),
	CONSTRAINT "organization_named_policies_kind_check" CHECK ("organization_named_policies"."kind" IN ('agent_permissions', 'client_configuration')),
	CONSTRAINT "organization_named_policies_name_check" CHECK (char_length(btrim("organization_named_policies"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "organization_named_policies_schema_version_check" CHECK ("organization_named_policies"."schema_version" >= 1),
	CONSTRAINT "organization_named_policies_document_check" CHECK (jsonb_typeof("organization_named_policies"."document") = 'object')
);
--> statement-breakpoint
ALTER TABLE "organization_default_policy_links" ADD CONSTRAINT "FK_organization_default_policy_links_organization" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_default_policy_links" ADD CONSTRAINT "FK_organization_default_policy_links_policy" FOREIGN KEY ("organization_id","kind","policy_id") REFERENCES "public"."organization_named_policies"("organization_id","kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_group_policy_links" ADD CONSTRAINT "FK_organization_group_policy_links_group" FOREIGN KEY ("organization_id","group_id") REFERENCES "public"."organization_groups"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_group_policy_links" ADD CONSTRAINT "FK_organization_group_policy_links_policy" FOREIGN KEY ("organization_id","kind","policy_id") REFERENCES "public"."organization_named_policies"("organization_id","kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_named_policies" ADD CONSTRAINT "FK_organization_named_policies_organization" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_organization_default_policy_links_policy" ON "organization_default_policy_links" USING btree ("organization_id","policy_id","kind");--> statement-breakpoint
CREATE INDEX "IDX_organization_group_policy_links_policy" ON "organization_group_policy_links" USING btree ("organization_id","policy_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_organization_named_policies_organization_id_canonical_name" ON "organization_named_policies" USING btree ("organization_id",lower(btrim("name")));