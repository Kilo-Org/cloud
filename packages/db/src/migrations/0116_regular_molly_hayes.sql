CREATE TABLE "agent_environment_profile_agents" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_agent_env_profile_agents_profile_slug" UNIQUE("profile_id","slug")
);
--> statement-breakpoint
CREATE TABLE "agent_environment_profile_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout" integer,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_agent_env_profile_mcp_servers_profile_name" UNIQUE("profile_id","name")
);
--> statement-breakpoint
CREATE TABLE "agent_environment_profile_skills" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_type" text NOT NULL,
	"source_url" text,
	"raw_markdown" text NOT NULL,
	"files" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_agent_env_profile_skills_profile_name" UNIQUE("profile_id","name")
);
--> statement-breakpoint
ALTER TABLE "agent_environment_profiles" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_environment_profile_agents" ADD CONSTRAINT "agent_environment_profile_agents_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environment_profile_mcp_servers" ADD CONSTRAINT "agent_environment_profile_mcp_servers_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environment_profile_skills" ADD CONSTRAINT "agent_environment_profile_skills_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_agent_env_profile_agents_profile_id" ON "agent_environment_profile_agents" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_env_profile_mcp_servers_profile_id" ON "agent_environment_profile_mcp_servers" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_env_profile_skills_profile_id" ON "agent_environment_profile_skills" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_env_profiles_created_by_user_id" ON "agent_environment_profiles" USING btree ("created_by_user_id");