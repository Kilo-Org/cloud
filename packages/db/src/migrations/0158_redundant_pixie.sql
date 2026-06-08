CREATE TABLE "security_agent_commands" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"command_type" text NOT NULL,
	"origin" text NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"finding_id" uuid,
	"repo_full_name" text,
	"status" text DEFAULT 'accepted' NOT NULL,
	"result_code" text,
	"last_error_redacted" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_agent_commands_owner_check" CHECK ((
        ("security_agent_commands"."owned_by_user_id" IS NOT NULL AND "security_agent_commands"."owned_by_organization_id" IS NULL) OR
        ("security_agent_commands"."owned_by_user_id" IS NULL AND "security_agent_commands"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "security_agent_commands_type_check" CHECK ("security_agent_commands"."command_type" IN ('sync', 'dismiss_finding', 'start_analysis')),
	CONSTRAINT "security_agent_commands_origin_check" CHECK ("security_agent_commands"."origin" IN ('manual', 'dashboard_refresh', 'enable_initial_sync')),
	CONSTRAINT "security_agent_commands_status_check" CHECK ("security_agent_commands"."status" IN ('accepted', 'running', 'succeeded', 'failed', 'no_op'))
);
--> statement-breakpoint
CREATE TABLE "security_agent_repository_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"repo_full_name" text NOT NULL,
	"last_attempted_at" timestamp with time zone NOT NULL,
	"last_succeeded_at" timestamp with time zone,
	"last_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_agent_repository_sync_state_owner_check" CHECK ((
        ("security_agent_repository_sync_state"."owned_by_user_id" IS NOT NULL AND "security_agent_repository_sync_state"."owned_by_organization_id" IS NULL) OR
        ("security_agent_repository_sync_state"."owned_by_user_id" IS NULL AND "security_agent_repository_sync_state"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "security_agent_commands" ADD CONSTRAINT "security_agent_commands_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_agent_commands" ADD CONSTRAINT "security_agent_commands_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_agent_commands" ADD CONSTRAINT "security_agent_commands_finding_id_security_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."security_findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_agent_repository_sync_state" ADD CONSTRAINT "security_agent_repository_sync_state_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_agent_repository_sync_state" ADD CONSTRAINT "security_agent_repository_sync_state_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_security_agent_commands_org_created" ON "security_agent_commands" USING btree ("owned_by_organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_security_agent_commands_user_created" ON "security_agent_commands" USING btree ("owned_by_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_security_agent_commands_status_updated" ON "security_agent_commands" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_security_agent_commands_finding_created" ON "security_agent_commands" USING btree ("finding_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_agent_repository_sync_state_org_repo" ON "security_agent_repository_sync_state" USING btree ("owned_by_organization_id","repo_full_name") WHERE "security_agent_repository_sync_state"."owned_by_organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_agent_repository_sync_state_user_repo" ON "security_agent_repository_sync_state" USING btree ("owned_by_user_id","repo_full_name") WHERE "security_agent_repository_sync_state"."owned_by_user_id" is not null;