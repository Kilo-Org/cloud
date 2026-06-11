CREATE TABLE "security_remediation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"remediation_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"repo_full_name" text NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_number" integer NOT NULL,
	"retry_of_attempt_id" uuid,
	"requested_by_user_id" text,
	"analysis_fingerprint" text NOT NULL,
	"analysis_completed_at" timestamp with time zone NOT NULL,
	"remediation_model_slug" text NOT NULL,
	"branch_name" text NOT NULL,
	"cloud_agent_session_id" text,
	"kilo_session_id" text,
	"execution_id" text,
	"priority" smallint DEFAULT 50 NOT NULL,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"claimed_by_job_id" text,
	"launch_attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"callback_attempt_token_hash" text,
	"failure_code" text,
	"blocked_reason" text,
	"last_error_redacted" text,
	"structured_result" jsonb,
	"final_assistant_message" text,
	"validation_evidence" jsonb,
	"risk_notes" text,
	"draft_reason" text,
	"pr_url" text,
	"pr_number" integer,
	"pr_draft" boolean,
	"pr_head_branch" text,
	"pr_base_branch" text,
	"cancellation_requested_at" timestamp with time zone,
	"cancellation_requested_by_user_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"launched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_remediation_attempts_owner_check" CHECK ((
        ("security_remediation_attempts"."owned_by_user_id" IS NOT NULL AND "security_remediation_attempts"."owned_by_organization_id" IS NULL) OR
        ("security_remediation_attempts"."owned_by_user_id" IS NULL AND "security_remediation_attempts"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "security_remediation_attempts_status_check" CHECK ("security_remediation_attempts"."status" IN ('queued', 'launching', 'running', 'pr_opened', 'failed', 'blocked', 'no_changes_needed', 'cancelled')),
	CONSTRAINT "security_remediation_attempts_origin_check" CHECK ("security_remediation_attempts"."origin" IN ('auto_policy', 'bulk_existing', 'manual')),
	CONSTRAINT "security_remediation_attempts_attempt_number_check" CHECK ("security_remediation_attempts"."attempt_number" >= 1),
	CONSTRAINT "security_remediation_attempts_launch_attempt_count_check" CHECK ("security_remediation_attempts"."launch_attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "security_remediations" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"finding_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"latest_attempt_id" uuid,
	"latest_analysis_fingerprint" text,
	"latest_analysis_completed_at" timestamp with time zone,
	"pr_url" text,
	"pr_number" integer,
	"pr_draft" boolean,
	"pr_head_branch" text,
	"pr_base_branch" text,
	"failure_code" text,
	"blocked_reason" text,
	"outcome_summary" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_remediations_owner_check" CHECK ((
        ("security_remediations"."owned_by_user_id" IS NOT NULL AND "security_remediations"."owned_by_organization_id" IS NULL) OR
        ("security_remediations"."owned_by_user_id" IS NULL AND "security_remediations"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "security_remediations_status_check" CHECK ("security_remediations"."status" IN ('queued', 'running', 'pr_opened', 'failed', 'blocked', 'no_changes_needed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "security_agent_commands" DROP CONSTRAINT "security_agent_commands_type_check";--> statement-breakpoint
ALTER TABLE "security_agent_commands" DROP CONSTRAINT "security_agent_commands_origin_check";--> statement-breakpoint
ALTER TABLE "security_audit_log" DROP CONSTRAINT "security_audit_log_action_check";--> statement-breakpoint
ALTER TABLE "security_agent_commands" ADD COLUMN "result_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "security_remediation_attempts" ADD CONSTRAINT "security_remediation_attempts_remediation_id_security_remediations_id_fk" FOREIGN KEY ("remediation_id") REFERENCES "public"."security_remediations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_remediation_attempts" ADD CONSTRAINT "security_remediation_attempts_finding_id_security_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."security_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_remediation_attempts" ADD CONSTRAINT "security_remediation_attempts_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_remediation_attempts" ADD CONSTRAINT "security_remediation_attempts_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_remediation_attempts" ADD CONSTRAINT "security_remediation_attempts_requested_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_remediation_attempts" ADD CONSTRAINT "security_remediation_attempts_cancellation_requested_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("cancellation_requested_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_remediations" ADD CONSTRAINT "security_remediations_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_remediations" ADD CONSTRAINT "security_remediations_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_remediations" ADD CONSTRAINT "security_remediations_finding_id_security_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."security_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_remediation_attempts_number" ON "security_remediation_attempts" USING btree ("remediation_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_remediation_attempts_active_finding" ON "security_remediation_attempts" USING btree ("finding_id") WHERE "security_remediation_attempts"."status" IN ('queued', 'launching', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_remediation_attempts_active_remediation" ON "security_remediation_attempts" USING btree ("remediation_id") WHERE "security_remediation_attempts"."status" IN ('queued', 'launching', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_remediation_attempts_finding_fingerprint_terminal" ON "security_remediation_attempts" USING btree ("finding_id","analysis_fingerprint") WHERE "security_remediation_attempts"."status" IN ('queued', 'launching', 'running', 'pr_opened');--> statement-breakpoint
CREATE INDEX "idx_security_remediation_attempts_org_claim" ON "security_remediation_attempts" USING btree ("owned_by_organization_id",coalesce("next_retry_at", '-infinity'::timestamptz),"priority","queued_at","id") WHERE "security_remediation_attempts"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_security_remediation_attempts_user_claim" ON "security_remediation_attempts" USING btree ("owned_by_user_id",coalesce("next_retry_at", '-infinity'::timestamptz),"priority","queued_at","id") WHERE "security_remediation_attempts"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_security_remediation_attempts_repo_claim" ON "security_remediation_attempts" USING btree ("repo_full_name",coalesce("next_retry_at", '-infinity'::timestamptz),"priority","queued_at","id") WHERE "security_remediation_attempts"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_security_remediation_attempts_org_inflight" ON "security_remediation_attempts" USING btree ("owned_by_organization_id","status","claimed_at","id") WHERE "security_remediation_attempts"."status" IN ('launching', 'running');--> statement-breakpoint
CREATE INDEX "idx_security_remediation_attempts_user_inflight" ON "security_remediation_attempts" USING btree ("owned_by_user_id","status","claimed_at","id") WHERE "security_remediation_attempts"."status" IN ('launching', 'running');--> statement-breakpoint
CREATE INDEX "idx_security_remediation_attempts_repo_inflight" ON "security_remediation_attempts" USING btree ("repo_full_name","status","claimed_at","id") WHERE "security_remediation_attempts"."status" IN ('launching', 'running');--> statement-breakpoint
CREATE INDEX "idx_security_remediation_attempts_cloud_agent_session" ON "security_remediation_attempts" USING btree ("cloud_agent_session_id");--> statement-breakpoint
CREATE INDEX "idx_security_remediation_attempts_finding_fingerprint" ON "security_remediation_attempts" USING btree ("finding_id","analysis_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_security_remediations_finding_id" ON "security_remediations" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "idx_security_remediations_org_status" ON "security_remediations" USING btree ("owned_by_organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_security_remediations_user_status" ON "security_remediations" USING btree ("owned_by_user_id","status");--> statement-breakpoint
CREATE INDEX "idx_security_remediations_repo_status" ON "security_remediations" USING btree ("repo_full_name","status");--> statement-breakpoint
CREATE INDEX "idx_security_remediations_latest_attempt" ON "security_remediations" USING btree ("latest_attempt_id");--> statement-breakpoint
ALTER TABLE "security_agent_commands" ADD CONSTRAINT "security_agent_commands_type_check" CHECK ("security_agent_commands"."command_type" IN ('sync', 'dismiss_finding', 'start_analysis', 'apply_auto_remediation'));--> statement-breakpoint
ALTER TABLE "security_agent_commands" ADD CONSTRAINT "security_agent_commands_origin_check" CHECK ("security_agent_commands"."origin" IN ('manual', 'dashboard_refresh', 'enable_initial_sync', 'settings_include_existing'));--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD CONSTRAINT "security_audit_log_action_check" CHECK ("security_audit_log"."action" IN ('security.finding.created', 'security.finding.status_change', 'security.finding.dismissed', 'security.finding.auto_dismissed', 'security.finding.analysis_started', 'security.finding.analysis_completed', 'security.remediation.queued', 'security.remediation.started', 'security.remediation.pr_opened', 'security.remediation.failed', 'security.remediation.blocked', 'security.remediation.no_changes_needed', 'security.remediation.cancelled', 'security.remediation.retried', 'security.finding.deleted', 'security.config.enabled', 'security.config.disabled', 'security.config.updated', 'security.sync.triggered', 'security.sync.completed', 'security.audit_log.exported'));