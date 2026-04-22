CREATE TABLE "bot_request_cloud_agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"bot_request_id" uuid NOT NULL,
	"spawn_group_id" uuid,
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
CREATE UNIQUE INDEX "UQ_bot_request_cas_cloud_agent_session_id" ON "bot_request_cloud_agent_sessions" USING btree ("cloud_agent_session_id");--> statement-breakpoint
CREATE INDEX "IDX_bot_request_cas_bot_request_id" ON "bot_request_cloud_agent_sessions" USING btree ("bot_request_id");--> statement-breakpoint
CREATE INDEX "IDX_bot_request_cas_bot_request_id_spawn_group_id" ON "bot_request_cloud_agent_sessions" USING btree ("bot_request_id","spawn_group_id");--> statement-breakpoint
CREATE INDEX "IDX_bot_request_cas_bot_request_id_spawn_group_id_status" ON "bot_request_cloud_agent_sessions" USING btree ("bot_request_id","spawn_group_id","status");--> statement-breakpoint
INSERT INTO "bot_request_cloud_agent_sessions" (
  "bot_request_id",
  "spawn_group_id",
  "cloud_agent_session_id",
  "status",
  "terminal_at",
  "created_at",
  "updated_at"
)
SELECT
  br."id",
  NULL,
  br."cloud_agent_session_id",
  CASE
    WHEN br."status" = 'completed' THEN 'completed'
    WHEN br."status" = 'error' THEN 'failed'
    ELSE 'running'
  END,
  CASE
    WHEN br."status" IN ('completed', 'error') THEN br."updated_at"
    ELSE NULL
  END,
  br."created_at",
  br."updated_at"
FROM "bot_requests" br
WHERE br."cloud_agent_session_id" IS NOT NULL
ON CONFLICT ("cloud_agent_session_id") DO NOTHING;