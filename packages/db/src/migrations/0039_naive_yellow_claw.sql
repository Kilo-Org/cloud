CREATE TABLE "security_analysis_owner_state" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"auto_analysis_enabled_at" timestamp with time zone,
	"blocked_until" timestamp with time zone,
	"block_reason" text,
	"consecutive_actor_resolution_failures" integer DEFAULT 0 NOT NULL,
	"last_actor_resolution_failure_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_analysis_owner_state_owner_check" CHECK ((
        ("security_analysis_owner_state"."owned_by_user_id" IS NOT NULL AND "security_analysis_owner_state"."owned_by_organization_id" IS NULL) OR
        ("security_analysis_owner_state"."owned_by_user_id" IS NULL AND "security_analysis_owner_state"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "security_analysis_owner_state_block_reason_check" CHECK ("security_analysis_owner_state"."block_reason" IS NULL OR "security_analysis_owner_state"."block_reason" IN ('INSUFFICIENT_CREDITS', 'ACTOR_RESOLUTION_FAILED', 'OPERATOR_PAUSE'))
);
--> statement-breakpoint
CREATE TABLE "security_analysis_queue" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"queue_status" text NOT NULL,
	"severity_rank" smallint NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by_job_id" text,
	"claim_token" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"reopen_requeue_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"failure_code" text,
	"last_error_redacted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_analysis_queue_owner_check" CHECK ((
        ("security_analysis_queue"."owned_by_user_id" IS NOT NULL AND "security_analysis_queue"."owned_by_organization_id" IS NULL) OR
        ("security_analysis_queue"."owned_by_user_id" IS NULL AND "security_analysis_queue"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "security_analysis_queue_status_check" CHECK ("security_analysis_queue"."queue_status" IN ('queued', 'pending', 'running', 'failed', 'completed')),
	CONSTRAINT "security_analysis_queue_claim_token_required_check" CHECK ("security_analysis_queue"."queue_status" NOT IN ('pending', 'running') OR "security_analysis_queue"."claim_token" IS NOT NULL),
	CONSTRAINT "security_analysis_queue_attempt_count_non_negative_check" CHECK ("security_analysis_queue"."attempt_count" >= 0),
	CONSTRAINT "security_analysis_queue_reopen_requeue_count_non_negative_check" CHECK ("security_analysis_queue"."reopen_requeue_count" >= 0),
	CONSTRAINT "security_analysis_queue_severity_rank_check" CHECK ("security_analysis_queue"."severity_rank" IN (0, 1, 2, 3)),
	CONSTRAINT "security_analysis_queue_failure_code_check" CHECK ("security_analysis_queue"."failure_code" IS NULL OR "security_analysis_queue"."failure_code" IN (
        'NETWORK_TIMEOUT',
        'UPSTREAM_5XX',
        'TEMP_TOKEN_FAILURE',
        'START_CALL_AMBIGUOUS',
        'REQUEUE_TEMPORARY_PRECONDITION',
        'ACTOR_RESOLUTION_FAILED',
        'GITHUB_TOKEN_UNAVAILABLE',
        'INVALID_CONFIG',
        'MISSING_OWNERSHIP',
        'PERMISSION_DENIED_PERMANENT',
        'UNSUPPORTED_SEVERITY',
        'INSUFFICIENT_CREDITS',
        'STATE_GUARD_REJECTED',
        'SKIPPED_ALREADY_IN_PROGRESS',
        'SKIPPED_NO_LONGER_ELIGIBLE',
        'REOPEN_LOOP_GUARD',
        'RUN_LOST'
      ))
);
--> statement-breakpoint
ALTER TABLE "security_analysis_owner_state" ADD CONSTRAINT "security_analysis_owner_state_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_analysis_owner_state" ADD CONSTRAINT "security_analysis_owner_state_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_analysis_queue" ADD CONSTRAINT "security_analysis_queue_finding_id_security_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."security_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_analysis_queue" ADD CONSTRAINT "security_analysis_queue_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_analysis_queue" ADD CONSTRAINT "security_analysis_queue_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_analysis_owner_state_org_owner" ON "security_analysis_owner_state" USING btree ("owned_by_organization_id") WHERE "security_analysis_owner_state"."owned_by_organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_analysis_owner_state_user_owner" ON "security_analysis_owner_state" USING btree ("owned_by_user_id") WHERE "security_analysis_owner_state"."owned_by_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_analysis_queue_finding_id" ON "security_analysis_queue" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "idx_security_analysis_queue_claim_path_org" ON "security_analysis_queue" USING btree ("owned_by_organization_id",coalesce("next_retry_at", '-infinity'::timestamptz),"severity_rank","queued_at","id") WHERE "security_analysis_queue"."queue_status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_security_analysis_queue_claim_path_user" ON "security_analysis_queue" USING btree ("owned_by_user_id",coalesce("next_retry_at", '-infinity'::timestamptz),"severity_rank","queued_at","id") WHERE "security_analysis_queue"."queue_status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_security_analysis_queue_in_flight_org" ON "security_analysis_queue" USING btree ("owned_by_organization_id","queue_status","claimed_at","id") WHERE "security_analysis_queue"."queue_status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_security_analysis_queue_in_flight_user" ON "security_analysis_queue" USING btree ("owned_by_user_id","queue_status","claimed_at","id") WHERE "security_analysis_queue"."queue_status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_security_analysis_queue_lag_dashboards" ON "security_analysis_queue" USING btree ("queued_at") WHERE "security_analysis_queue"."queue_status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_security_analysis_queue_pending_reconciliation" ON "security_analysis_queue" USING btree ("claimed_at","id") WHERE "security_analysis_queue"."queue_status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_security_analysis_queue_running_reconciliation" ON "security_analysis_queue" USING btree ("updated_at","id") WHERE "security_analysis_queue"."queue_status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_security_analysis_queue_failure_trend" ON "security_analysis_queue" USING btree ("failure_code","updated_at") WHERE "security_analysis_queue"."failure_code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_security_findings_org_analysis_in_flight" ON "security_findings" USING btree ("owned_by_organization_id","analysis_status") WHERE "security_findings"."analysis_status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_security_findings_user_analysis_in_flight" ON "security_findings" USING btree ("owned_by_user_id","analysis_status") WHERE "security_findings"."analysis_status" IN ('pending', 'running');