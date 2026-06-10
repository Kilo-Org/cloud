CREATE TABLE "agent_environment_profile_kilo_commands" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"template" text NOT NULL,
	"agent" text,
	"model" text,
	"subtask" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_agent_env_profile_kilo_cmds_profile_name" UNIQUE("profile_id","name")
);
--> statement-breakpoint
ALTER TABLE "agent_environment_profile_kilo_commands" ADD CONSTRAINT "agent_environment_profile_kilo_commands_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_agent_env_profile_kilo_cmds_profile_id" ON "agent_environment_profile_kilo_commands" USING btree ("profile_id");