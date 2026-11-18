CREATE TABLE "cloud_agent_workspace_folders" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"name" text NOT NULL,
	"color" text DEFAULT 'default' NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_workspace_folders_color_check" CHECK ("cloud_agent_workspace_folders"."color" IN ('default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple')),
	CONSTRAINT "cloud_agent_workspace_folders_name_check" CHECK (char_length(btrim("cloud_agent_workspace_folders"."name")) BETWEEN 1 AND 200 AND "cloud_agent_workspace_folders"."name" = btrim("cloud_agent_workspace_folders"."name")),
	CONSTRAINT "cloud_agent_workspace_folders_position_check" CHECK ("cloud_agent_workspace_folders"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_worktrees" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "cloud_agent_workspace_folders" ADD CONSTRAINT "cloud_agent_workspace_folders_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_workspace_folders" ADD CONSTRAINT "cloud_agent_workspace_folders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_workspace_folders_owner_scope_order" ON "cloud_agent_workspace_folders" USING btree ("kilo_user_id","organization_id","position","id");--> statement-breakpoint
ALTER TABLE "cloud_agent_worktrees" ADD CONSTRAINT "cloud_agent_worktrees_folder_id_cloud_agent_workspace_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."cloud_agent_workspace_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_worktrees_folder_id" ON "cloud_agent_worktrees" USING btree ("folder_id") WHERE "cloud_agent_worktrees"."folder_id" is not null;