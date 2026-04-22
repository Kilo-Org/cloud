CREATE TABLE "bot_request_cloud_agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"bot_request_id" uuid NOT NULL,
	"spawn_group_id" uuid NOT NULL,
	"cloud_agent_session_id" text NOT NULL,
	"kilo_session_id" text,
	"execution_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"mode" text,
	"github_repo" text,
	"gitlab_project" text,
	"callback_step" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"terminal_at" timestamp with time zone,
	"continuation_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_request_cloud_agent_sessions" ADD CONSTRAINT "bot_request_cloud_agent_sessions_bot_request_id_bot_requests_id_fk" FOREIGN KEY ("bot_request_id") REFERENCES "public"."bot_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_bot_request_cloud_agent_sessions_cloud_agent_session_id" ON "bot_request_cloud_agent_sessions" USING btree ("cloud_agent_session_id");--> statement-breakpoint
CREATE INDEX "IDX_bot_request_cloud_agent_sessions_bot_request_id" ON "bot_request_cloud_agent_sessions" USING btree ("bot_request_id");--> statement-breakpoint
CREATE INDEX "IDX_bot_request_cloud_agent_sessions_spawn_group" ON "bot_request_cloud_agent_sessions" USING btree ("bot_request_id","spawn_group_id");--> statement-breakpoint
CREATE INDEX "IDX_bot_request_cloud_agent_sessions_status" ON "bot_request_cloud_agent_sessions" USING btree ("bot_request_id","spawn_group_id","status");--> statement-breakpoint
ALTER TABLE "bot_requests" DROP COLUMN "cloud_agent_session_id";