CREATE TABLE "cloud_agent_pr_watch_activity" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"watch_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"delivery_id" text,
	"kind" text NOT NULL,
	"reason" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_agent_pr_watches" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"integration_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"github_app_type" text NOT NULL,
	"repository_id" text NOT NULL,
	"repo_url" text NOT NULL,
	"pr_number" integer NOT NULL,
	"source_session_id" text NOT NULL,
	"source_cloud_agent_session_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"head_ref" text NOT NULL,
	"base_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"pending_revision" integer DEFAULT 0 NOT NULL,
	"policy" jsonb NOT NULL,
	"projection" jsonb NOT NULL,
	"lifecycle_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_pr_watches_status_check" CHECK ("cloud_agent_pr_watches"."status" IN ('watching', 'paused', 'finished')),
	CONSTRAINT "cloud_agent_pr_watches_app_type_check" CHECK ("cloud_agent_pr_watches"."github_app_type" IN ('standard', 'lite')),
	CONSTRAINT "cloud_agent_pr_watches_version_check" CHECK ("cloud_agent_pr_watches"."generation" > 0 AND "cloud_agent_pr_watches"."pending_revision" >= 0 AND "cloud_agent_pr_watches"."pr_number" > 0),
	CONSTRAINT "cloud_agent_pr_watches_repo_url_check" CHECK ("cloud_agent_pr_watches"."repo_url" = lower("cloud_agent_pr_watches"."repo_url") AND "cloud_agent_pr_watches"."repo_url" ~ '^https://github[.]com/[^/]+/[^/]+$')
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_pr_watch_activity" ADD CONSTRAINT "cloud_agent_pr_watch_activity_watch_id_cloud_agent_pr_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."cloud_agent_pr_watches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_pr_watches" ADD CONSTRAINT "cloud_agent_pr_watches_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_pr_watches" ADD CONSTRAINT "cloud_agent_pr_watches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_pr_watches" ADD CONSTRAINT "cloud_agent_pr_watches_integration_id_platform_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_watch_activity_delivery" ON "cloud_agent_pr_watch_activity" USING btree ("watch_id","generation","delivery_id");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_pr_watch_activity_watch" ON "cloud_agent_pr_watch_activity" USING btree ("watch_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_pr_watch_activity_created" ON "cloud_agent_pr_watch_activity" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_watches_live_pr" ON "cloud_agent_pr_watches" USING btree ("repository_id","pr_number") WHERE "cloud_agent_pr_watches"."status" != 'finished';--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_pr_watches_owner" ON "cloud_agent_pr_watches" USING btree ("kilo_user_id","worktree_id");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_pr_watches_updated" ON "cloud_agent_pr_watches" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_pr_watches_event_identity" ON "cloud_agent_pr_watches" USING btree ("installation_id","github_app_type","repository_id","pr_number");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_pr_watches_head" ON "cloud_agent_pr_watches" USING btree ("repository_id","head_sha");