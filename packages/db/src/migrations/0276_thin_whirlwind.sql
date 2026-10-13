CREATE TABLE "cloud_agent_sandbox_allocation_settings" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"repository_full_name" text,
	"repository_platform" text,
	"allocation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_sandbox_allocation_settings_owner_check" CHECK ((
        ("cloud_agent_sandbox_allocation_settings"."owned_by_user_id" IS NOT NULL AND "cloud_agent_sandbox_allocation_settings"."owned_by_organization_id" IS NULL) OR
        ("cloud_agent_sandbox_allocation_settings"."owned_by_user_id" IS NULL AND "cloud_agent_sandbox_allocation_settings"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "cloud_agent_sandbox_allocation_settings_repo_pair_check" CHECK ((
        ("cloud_agent_sandbox_allocation_settings"."repository_full_name" IS NULL AND "cloud_agent_sandbox_allocation_settings"."repository_platform" IS NULL) OR
        ("cloud_agent_sandbox_allocation_settings"."repository_full_name" IS NOT NULL AND "cloud_agent_sandbox_allocation_settings"."repository_platform" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_sandbox_allocation_settings" ADD CONSTRAINT "cloud_agent_sandbox_allocation_settings_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_sandbox_allocation_settings" ADD CONSTRAINT "cloud_agent_sandbox_allocation_settings_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_sandbox_alloc_org_context" ON "cloud_agent_sandbox_allocation_settings" USING btree ("owned_by_organization_id") WHERE "cloud_agent_sandbox_allocation_settings"."owned_by_organization_id" IS NOT NULL AND "cloud_agent_sandbox_allocation_settings"."repository_full_name" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_sandbox_alloc_user_context" ON "cloud_agent_sandbox_allocation_settings" USING btree ("owned_by_user_id") WHERE "cloud_agent_sandbox_allocation_settings"."owned_by_user_id" IS NOT NULL AND "cloud_agent_sandbox_allocation_settings"."repository_full_name" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_sandbox_alloc_org_repo" ON "cloud_agent_sandbox_allocation_settings" USING btree ("owned_by_organization_id","repository_full_name","repository_platform") WHERE "cloud_agent_sandbox_allocation_settings"."owned_by_organization_id" IS NOT NULL AND "cloud_agent_sandbox_allocation_settings"."repository_full_name" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_sandbox_alloc_user_repo" ON "cloud_agent_sandbox_allocation_settings" USING btree ("owned_by_user_id","repository_full_name","repository_platform") WHERE "cloud_agent_sandbox_allocation_settings"."owned_by_user_id" IS NOT NULL AND "cloud_agent_sandbox_allocation_settings"."repository_full_name" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_sandbox_alloc_org" ON "cloud_agent_sandbox_allocation_settings" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_sandbox_alloc_user" ON "cloud_agent_sandbox_allocation_settings" USING btree ("owned_by_user_id");