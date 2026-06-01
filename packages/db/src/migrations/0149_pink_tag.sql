CREATE TABLE "cloud_agent_session_runs" (
	"cloud_agent_session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"wrapper_run_id" text,
	"status" text NOT NULL,
	"queued_at" timestamp with time zone,
	"dispatch_accepted_at" timestamp with time zone,
	"agent_activity_observed_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"failure_stage" text,
	"failure_code" text,
	"error_message_redacted" text,
	"error_expires_at" timestamp with time zone,
	CONSTRAINT "cloud_agent_session_runs_cloud_agent_session_id_message_id_pk" PRIMARY KEY("cloud_agent_session_id","message_id"),
	CONSTRAINT "cloud_agent_session_runs_status_check" CHECK ("cloud_agent_session_runs"."status" IN ('queued', 'accepted', 'completed', 'failed', 'interrupted')),
	CONSTRAINT "cloud_agent_session_runs_failure_classification_check" CHECK (("cloud_agent_session_runs"."failure_stage" IS NULL AND "cloud_agent_session_runs"."failure_code" IS NULL) OR
        ("cloud_agent_session_runs"."failure_stage" = 'pre_dispatch' AND "cloud_agent_session_runs"."failure_code" IN ('sandbox_connect_failed', 'workspace_setup_failed', 'kilo_server_failed', 'wrapper_start_failed', 'invalid_delivery_request', 'session_metadata_missing', 'model_missing', 'delivery_failure_unknown')) OR
        ("cloud_agent_session_runs"."failure_stage" = 'post_dispatch_no_activity' AND "cloud_agent_session_runs"."failure_code" IN ('wrapper_disconnected', 'wrapper_no_output', 'wrapper_ping_timeout', 'wrapper_error_before_activity', 'missing_assistant_reply')) OR
        ("cloud_agent_session_runs"."failure_stage" = 'agent_activity' AND "cloud_agent_session_runs"."failure_code" IN ('assistant_error', 'wrapper_error_after_activity')) OR
        ("cloud_agent_session_runs"."failure_stage" = 'interruption' AND "cloud_agent_session_runs"."failure_code" IN ('user_interrupt', 'container_shutdown', 'system_interrupt')) OR
        ("cloud_agent_session_runs"."failure_stage" = 'unknown' AND "cloud_agent_session_runs"."failure_code" = 'unclassified')),
	CONSTRAINT "cloud_agent_session_runs_error_message_bounded_check" CHECK ("cloud_agent_session_runs"."error_message_redacted" IS NULL OR char_length("cloud_agent_session_runs"."error_message_redacted") <= 4096),
	CONSTRAINT "cloud_agent_session_runs_error_expiry_check" CHECK (("cloud_agent_session_runs"."error_message_redacted" IS NULL AND "cloud_agent_session_runs"."error_expires_at" IS NULL) OR
        ("cloud_agent_session_runs"."error_message_redacted" IS NOT NULL AND "cloud_agent_session_runs"."error_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cloud_agent_sessions" (
	"cloud_agent_session_id" text PRIMARY KEY NOT NULL,
	"kilo_session_id" text NOT NULL,
	"initial_message_id" text NOT NULL,
	"sandbox_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"failure_at" timestamp with time zone,
	"failure_stage" text,
	"failure_code" text,
	"error_message_redacted" text,
	"error_expires_at" timestamp with time zone,
	CONSTRAINT "cloud_agent_sessions_failure_classification_check" CHECK (("cloud_agent_sessions"."failure_at" IS NULL AND "cloud_agent_sessions"."failure_stage" IS NULL AND "cloud_agent_sessions"."failure_code" IS NULL) OR
        ("cloud_agent_sessions"."failure_at" IS NOT NULL AND "cloud_agent_sessions"."failure_stage" = 'sandbox_identity' AND "cloud_agent_sessions"."failure_code" = 'sandbox_id_derivation_failed') OR
        ("cloud_agent_sessions"."failure_at" IS NOT NULL AND "cloud_agent_sessions"."failure_stage" = 'registration' AND "cloud_agent_sessions"."failure_code" = 'do_registration_rejected') OR
        ("cloud_agent_sessions"."failure_at" IS NOT NULL AND "cloud_agent_sessions"."failure_stage" = 'initial_admission' AND "cloud_agent_sessions"."failure_code" IN ('initial_admission_rejected', 'initial_queue_full', 'invalid_initial_intent')) OR
        ("cloud_agent_sessions"."failure_at" IS NOT NULL AND "cloud_agent_sessions"."failure_stage" = 'transport' AND "cloud_agent_sessions"."failure_code" = 'do_rpc_outcome_unknown')),
	CONSTRAINT "cloud_agent_sessions_error_message_bounded_check" CHECK ("cloud_agent_sessions"."error_message_redacted" IS NULL OR char_length("cloud_agent_sessions"."error_message_redacted") <= 4096),
	CONSTRAINT "cloud_agent_sessions_error_expiry_check" CHECK (("cloud_agent_sessions"."error_message_redacted" IS NULL AND "cloud_agent_sessions"."error_expires_at" IS NULL) OR
        ("cloud_agent_sessions"."error_message_redacted" IS NOT NULL AND "cloud_agent_sessions"."error_expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_session_runs" ADD CONSTRAINT "cloud_agent_session_runs_cloud_agent_session_id_cloud_agent_sessions_cloud_agent_session_id_fk" FOREIGN KEY ("cloud_agent_session_id") REFERENCES "public"."cloud_agent_sessions"("cloud_agent_session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_session_runs_wrapper_run_id" ON "cloud_agent_session_runs" USING btree ("wrapper_run_id") WHERE "cloud_agent_session_runs"."wrapper_run_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_session_runs_session_queued" ON "cloud_agent_session_runs" USING btree ("cloud_agent_session_id","queued_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_session_runs_queued_at" ON "cloud_agent_session_runs" USING btree ("queued_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_session_runs_terminal_at" ON "cloud_agent_session_runs" USING btree ("terminal_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_session_runs_status_terminal" ON "cloud_agent_session_runs" USING btree ("status","terminal_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_session_runs_failure_terminal" ON "cloud_agent_session_runs" USING btree ("failure_stage","failure_code","terminal_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_session_runs_error_expires_at" ON "cloud_agent_session_runs" USING btree ("error_expires_at") WHERE "cloud_agent_session_runs"."error_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_sessions_kilo_session_id" ON "cloud_agent_sessions" USING btree ("kilo_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_sessions_initial_message_id" ON "cloud_agent_sessions" USING btree ("initial_message_id");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_sessions_sandbox_id" ON "cloud_agent_sessions" USING btree ("sandbox_id") WHERE "cloud_agent_sessions"."sandbox_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_sessions_created_at" ON "cloud_agent_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_sessions_failure_created" ON "cloud_agent_sessions" USING btree ("failure_stage","failure_code","created_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_sessions_failure_at" ON "cloud_agent_sessions" USING btree ("failure_at") WHERE "cloud_agent_sessions"."failure_at" is not null;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_sessions_failure_classification_at" ON "cloud_agent_sessions" USING btree ("failure_stage","failure_code","failure_at") WHERE "cloud_agent_sessions"."failure_at" is not null;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_sessions_error_expires_at" ON "cloud_agent_sessions" USING btree ("error_expires_at") WHERE "cloud_agent_sessions"."error_expires_at" is not null;