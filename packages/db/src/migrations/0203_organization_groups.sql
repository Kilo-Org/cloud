CREATE TABLE "organization_group_memberships" (
	"organization_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"assigned_by_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "PK_organization_group_memberships" PRIMARY KEY("organization_id","group_id","kilo_user_id")
);
--> statement-breakpoint
CREATE TABLE "organization_group_policy_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"default_policies" jsonb DEFAULT '[{"type":"model_access","data":{"mode":"all"}}]'::jsonb NOT NULL,
	"policy_revision" integer DEFAULT 1 NOT NULL,
	"updated_by_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_group_policy_settings_revision_check" CHECK ("organization_group_policy_settings"."policy_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "organization_groups" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"policies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_groups_organization_id_id" UNIQUE("organization_id","id"),
	CONSTRAINT "organization_groups_name_check" CHECK (char_length(btrim("organization_groups"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "organization_groups_description_check" CHECK ("organization_groups"."description" IS NULL OR char_length("organization_groups"."description") <= 500)
);
--> statement-breakpoint
ALTER TABLE "organization_group_memberships" ADD CONSTRAINT "FK_organization_group_memberships_group" FOREIGN KEY ("organization_id","group_id") REFERENCES "public"."organization_groups"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_group_memberships" ADD CONSTRAINT "FK_organization_group_memberships_member" FOREIGN KEY ("organization_id","kilo_user_id") REFERENCES "public"."organization_memberships"("organization_id","kilo_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_group_policy_settings" ADD CONSTRAINT "organization_group_policy_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_groups" ADD CONSTRAINT "organization_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_organization_group_memberships_organization_user" ON "organization_group_memberships" USING btree ("organization_id","kilo_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_organization_groups_organization_id_canonical_name" ON "organization_groups" USING btree ("organization_id",lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "IDX_organization_groups_organization_id" ON "organization_groups" USING btree ("organization_id");