CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"agent_type" text NOT NULL,
	"platform" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_agent_configs_org_agent_platform" UNIQUE("owned_by_organization_id","agent_type","platform"),
	CONSTRAINT "UQ_agent_configs_user_agent_platform" UNIQUE("owned_by_user_id","agent_type","platform"),
	CONSTRAINT "agent_configs_owner_check" CHECK ((
        ("agent_configs"."owned_by_user_id" IS NOT NULL AND "agent_configs"."owned_by_organization_id" IS NULL) OR
        ("agent_configs"."owned_by_user_id" IS NULL AND "agent_configs"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "agent_configs_agent_type_check" CHECK ("agent_configs"."agent_type" IN ('code_review', 'auto_triage', 'auto_fix', 'security_scan'))
);
--> statement-breakpoint
CREATE TABLE "agent_environment_profile_commands" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"command" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_agent_env_profile_commands_profile_sequence" UNIQUE("profile_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "agent_environment_profile_vars" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_agent_env_profile_vars_profile_key" UNIQUE("profile_id","key")
);
--> statement-breakpoint
CREATE TABLE "agent_environment_profiles" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_env_profiles_owner_check" CHECK ((
        ("agent_environment_profiles"."owned_by_user_id" IS NOT NULL AND "agent_environment_profiles"."owned_by_organization_id" IS NULL) OR
        ("agent_environment_profiles"."owned_by_user_id" IS NULL AND "agent_environment_profiles"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "app_builder_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"sequence" serial NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_app_builder_messages_project_created_at" UNIQUE("project_id","created_at")
);
--> statement-breakpoint
CREATE TABLE "app_builder_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_user_id" text,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"session_id" text,
	"title" text NOT NULL,
	"model_id" text NOT NULL,
	"template" text,
	"deployment_id" uuid,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_builder_projects_owner_check" CHECK ((
        ("app_builder_projects"."owned_by_user_id" IS NOT NULL AND "app_builder_projects"."owned_by_organization_id" IS NULL) OR
        ("app_builder_projects"."owned_by_user_id" IS NULL AND "app_builder_projects"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "app_reported_messages" (
	"report_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"report_type" text NOT NULL,
	"signature" jsonb NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cli_session_id" uuid,
	"mode" text,
	"model" text
);
--> statement-breakpoint
CREATE TABLE "auto_fix_tickets" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform_integration_id" uuid,
	"triage_ticket_id" uuid,
	"platform" text DEFAULT 'github' NOT NULL,
	"repo_full_name" text NOT NULL,
	"issue_number" integer NOT NULL,
	"issue_url" text NOT NULL,
	"issue_title" text NOT NULL,
	"issue_body" text,
	"issue_author" text NOT NULL,
	"issue_labels" text[] DEFAULT '{}',
	"classification" text,
	"confidence" numeric(3, 2),
	"intent_summary" text,
	"related_files" text[],
	"session_id" text,
	"cli_session_id" uuid,
	"pr_number" integer,
	"pr_url" text,
	"pr_branch" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_fix_tickets_owner_check" CHECK ((
        ("auto_fix_tickets"."owned_by_user_id" IS NOT NULL AND "auto_fix_tickets"."owned_by_organization_id" IS NULL) OR
        ("auto_fix_tickets"."owned_by_user_id" IS NULL AND "auto_fix_tickets"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "auto_fix_tickets_status_check" CHECK ("auto_fix_tickets"."status" IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "auto_fix_tickets_classification_check" CHECK ("auto_fix_tickets"."classification" IN ('bug', 'feature', 'question', 'unclear')),
	CONSTRAINT "auto_fix_tickets_confidence_check" CHECK ("auto_fix_tickets"."confidence" >= 0 AND "auto_fix_tickets"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "auto_top_up_configs" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"created_by_user_id" text,
	"stripe_payment_method_id" text NOT NULL,
	"amount_cents" integer DEFAULT 5000 NOT NULL,
	"last_auto_top_up_at" timestamp with time zone,
	"attempt_started_at" timestamp with time zone,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_top_up_configs_exactly_one_owner" CHECK (("auto_top_up_configs"."owned_by_user_id" IS NOT NULL AND "auto_top_up_configs"."owned_by_organization_id" IS NULL) OR ("auto_top_up_configs"."owned_by_user_id" IS NULL AND "auto_top_up_configs"."owned_by_organization_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "auto_triage_tickets" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform_integration_id" uuid,
	"platform" text DEFAULT 'github' NOT NULL,
	"repo_full_name" text NOT NULL,
	"issue_number" integer NOT NULL,
	"issue_url" text NOT NULL,
	"issue_title" text NOT NULL,
	"issue_body" text,
	"issue_author" text NOT NULL,
	"issue_type" text NOT NULL,
	"issue_labels" text[] DEFAULT '{}',
	"classification" text,
	"confidence" numeric(3, 2),
	"intent_summary" text,
	"related_files" text[],
	"is_duplicate" boolean DEFAULT false,
	"duplicate_of_ticket_id" uuid,
	"similarity_score" numeric(3, 2),
	"qdrant_point_id" text,
	"session_id" text,
	"should_auto_fix" boolean DEFAULT false,
	"status" text DEFAULT 'pending' NOT NULL,
	"action_taken" text,
	"action_metadata" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_triage_tickets_owner_check" CHECK ((
        ("auto_triage_tickets"."owned_by_user_id" IS NOT NULL AND "auto_triage_tickets"."owned_by_organization_id" IS NULL) OR
        ("auto_triage_tickets"."owned_by_user_id" IS NULL AND "auto_triage_tickets"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "auto_triage_tickets_issue_type_check" CHECK ("auto_triage_tickets"."issue_type" IN ('issue', 'pull_request')),
	CONSTRAINT "auto_triage_tickets_classification_check" CHECK ("auto_triage_tickets"."classification" IN ('bug', 'feature', 'question', 'duplicate', 'unclear')),
	CONSTRAINT "auto_triage_tickets_confidence_check" CHECK ("auto_triage_tickets"."confidence" >= 0 AND "auto_triage_tickets"."confidence" <= 1),
	CONSTRAINT "auto_triage_tickets_similarity_score_check" CHECK ("auto_triage_tickets"."similarity_score" >= 0 AND "auto_triage_tickets"."similarity_score" <= 1),
	CONSTRAINT "auto_triage_tickets_status_check" CHECK ("auto_triage_tickets"."status" IN ('pending', 'analyzing', 'actioned', 'failed', 'skipped')),
	CONSTRAINT "auto_triage_tickets_action_taken_check" CHECK ("auto_triage_tickets"."action_taken" IN ('pr_created', 'comment_posted', 'closed_duplicate', 'needs_clarification'))
);
--> statement-breakpoint
CREATE TABLE "byok_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"kilo_user_id" text,
	"provider_id" text NOT NULL,
	"encrypted_api_key" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "UQ_byok_api_keys_org_provider" UNIQUE("organization_id","provider_id"),
	CONSTRAINT "UQ_byok_api_keys_user_provider" UNIQUE("kilo_user_id","provider_id"),
	CONSTRAINT "byok_api_keys_owner_check" CHECK ((
        ("byok_api_keys"."kilo_user_id" IS NOT NULL AND "byok_api_keys"."organization_id" IS NULL) OR
        ("byok_api_keys"."kilo_user_id" IS NULL AND "byok_api_keys"."organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "cli_sessions" (
	"session_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"title" text NOT NULL,
	"created_on_platform" text DEFAULT 'unknown' NOT NULL,
	"api_conversation_history_blob_url" text,
	"task_metadata_blob_url" text,
	"ui_messages_blob_url" text,
	"git_state_blob_url" text,
	"git_url" text,
	"forked_from" uuid,
	"parent_session_id" uuid,
	"cloud_agent_session_id" text,
	"organization_id" uuid,
	"last_mode" text,
	"last_model" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_sessions_cloud_agent_session_id_unique" UNIQUE("cloud_agent_session_id")
);
--> statement-breakpoint
CREATE TABLE "cli_sessions_v2" (
	"session_id" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"title" text,
	"public_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_sessions_v2_session_id_kilo_user_id_pk" PRIMARY KEY("session_id","kilo_user_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_agent_code_reviews" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform_integration_id" uuid,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"pr_title" text NOT NULL,
	"pr_author" text NOT NULL,
	"pr_author_github_id" text,
	"base_ref" text NOT NULL,
	"head_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"session_id" text,
	"cli_session_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_code_reviews_owner_check" CHECK ((
        ("cloud_agent_code_reviews"."owned_by_user_id" IS NOT NULL AND "cloud_agent_code_reviews"."owned_by_organization_id" IS NULL) OR
        ("cloud_agent_code_reviews"."owned_by_user_id" IS NULL AND "cloud_agent_code_reviews"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "cloud_agent_webhook_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" text NOT NULL,
	"user_id" text,
	"organization_id" uuid,
	"github_repo" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "CHK_cloud_agent_webhook_triggers_owner" CHECK ((
        ("cloud_agent_webhook_triggers"."user_id" IS NOT NULL AND "cloud_agent_webhook_triggers"."organization_id" IS NULL) OR
        ("cloud_agent_webhook_triggers"."user_id" IS NULL AND "cloud_agent_webhook_triggers"."organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "code_indexing_manifest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text,
	"project_id" text NOT NULL,
	"git_branch" text NOT NULL,
	"file_hash" text NOT NULL,
	"file_path" text NOT NULL,
	"chunk_count" integer NOT NULL,
	"total_lines" integer,
	"total_ai_lines" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_code_indexing_manifest_org_user_project_hash_branch" UNIQUE NULLS NOT DISTINCT("organization_id","kilo_user_id","project_id","file_path","git_branch")
);
--> statement-breakpoint
CREATE TABLE "code_indexing_search" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"query" text NOT NULL,
	"project_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"amount_microdollars" bigint NOT NULL,
	"expiration_baseline_microdollars_used" bigint,
	"original_baseline_microdollars_used" bigint,
	"is_free" boolean NOT NULL,
	"description" text,
	"original_transaction_id" uuid,
	"stripe_payment_id" text,
	"coinbase_credit_block_id" text,
	"credit_category" text,
	"expiry_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"check_category_uniqueness" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_env_vars" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_deployment_env_vars_deployment_key" UNIQUE("deployment_id","key")
);
--> statement-breakpoint
CREATE TABLE "deployment_events" (
	"build_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"event_type" text DEFAULT 'log' NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "deployment_events_build_id_event_id_pk" PRIMARY KEY("build_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "deployment_threat_detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"build_id" uuid,
	"threat_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"created_by_user_id" text,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"deployment_slug" text NOT NULL,
	"repository_source" text NOT NULL,
	"branch" text NOT NULL,
	"deployment_url" text NOT NULL,
	"platform_integration_id" uuid,
	"source_type" text DEFAULT 'github' NOT NULL,
	"git_auth_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_deployed_at" timestamp with time zone,
	"last_build_id" uuid NOT NULL,
	"threat_status" text,
	CONSTRAINT "UQ_deployments_deployment_slug" UNIQUE("deployment_slug"),
	CONSTRAINT "deployments_owner_check" CHECK ((
        ("deployments"."owned_by_user_id" IS NOT NULL AND "deployments"."owned_by_organization_id" IS NULL) OR
        ("deployments"."owned_by_user_id" IS NULL AND "deployments"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "deployments_source_type_check" CHECK ("deployments"."source_type" IN ('github', 'git', 'app-builder'))
);
--> statement-breakpoint
CREATE TABLE "device_auth_requests" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kilo_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "editor_name" (
	"editor_name_id" serial PRIMARY KEY NOT NULL,
	"editor_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_data" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"github_enrichment_data" jsonb,
	"linkedin_enrichment_data" jsonb,
	"clay_enrichment_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_enrichment_data_user_id" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "finish_reason" (
	"finish_reason_id" serial PRIMARY KEY NOT NULL,
	"finish_reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "free_model_usage" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"ip_address" text NOT NULL,
	"model" text NOT NULL,
	"kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "http_ip" (
	"http_ip_id" serial PRIMARY KEY NOT NULL,
	"http_ip" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "http_user_agent" (
	"http_user_agent_id" serial PRIMARY KEY NOT NULL,
	"http_user_agent" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ja4_digest" (
	"ja4_digest_id" serial PRIMARY KEY NOT NULL,
	"ja4_digest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kilo_user_id" text,
	"kilo_pass_subscription_id" uuid,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"idempotency_key" text,
	"stripe_event_id" text,
	"stripe_invoice_id" text,
	"stripe_subscription_id" text,
	"related_credit_transaction_id" uuid,
	"related_monthly_issuance_id" uuid,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "kilo_pass_audit_log_action_check" CHECK ("kilo_pass_audit_log"."action" IN ('stripe_webhook_received', 'kilo_pass_invoice_paid_handled', 'base_credits_issued', 'bonus_credits_issued', 'bonus_credits_skipped_idempotent', 'first_month_50pct_promo_issued', 'yearly_monthly_base_cron_started', 'yearly_monthly_base_cron_completed', 'issue_yearly_remaining_credits', 'yearly_monthly_bonus_cron_started', 'yearly_monthly_bonus_cron_completed')),
	CONSTRAINT "kilo_pass_audit_log_result_check" CHECK ("kilo_pass_audit_log"."result" IN ('success', 'skipped_idempotent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_issuance_items" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_pass_issuance_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"credit_transaction_id" uuid NOT NULL,
	"amount_usd" numeric(12, 2) NOT NULL,
	"bonus_percent_applied" numeric(6, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilo_pass_issuance_items_credit_transaction_id_unique" UNIQUE("credit_transaction_id"),
	CONSTRAINT "UQ_kilo_pass_issuance_items_issuance_kind" UNIQUE("kilo_pass_issuance_id","kind"),
	CONSTRAINT "kilo_pass_issuance_items_bonus_percent_applied_range_check" CHECK ("kilo_pass_issuance_items"."bonus_percent_applied" IS NULL OR ("kilo_pass_issuance_items"."bonus_percent_applied" >= 0 AND "kilo_pass_issuance_items"."bonus_percent_applied" <= 1)),
	CONSTRAINT "kilo_pass_issuance_items_amount_usd_non_negative_check" CHECK ("kilo_pass_issuance_items"."amount_usd" >= 0),
	CONSTRAINT "kilo_pass_issuance_items_kind_check" CHECK ("kilo_pass_issuance_items"."kind" IN ('base', 'bonus', 'promo_first_month_50pct'))
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_issuances" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_pass_subscription_id" uuid NOT NULL,
	"issue_month" date NOT NULL,
	"source" text NOT NULL,
	"stripe_invoice_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_issuances_subscription_issue_month" UNIQUE("kilo_pass_subscription_id","issue_month"),
	CONSTRAINT "kilo_pass_issuances_issue_month_day_one_check" CHECK (EXTRACT(DAY FROM "kilo_pass_issuances"."issue_month") = 1),
	CONSTRAINT "kilo_pass_issuances_source_check" CHECK ("kilo_pass_issuances"."source" IN ('stripe_invoice', 'cron'))
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_scheduled_changes" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"from_tier" text NOT NULL,
	"from_cadence" text NOT NULL,
	"to_tier" text NOT NULL,
	"to_cadence" text NOT NULL,
	"stripe_schedule_id" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilo_pass_scheduled_changes_from_tier_check" CHECK ("kilo_pass_scheduled_changes"."from_tier" IN ('tier_19', 'tier_49', 'tier_199')),
	CONSTRAINT "kilo_pass_scheduled_changes_from_cadence_check" CHECK ("kilo_pass_scheduled_changes"."from_cadence" IN ('monthly', 'yearly')),
	CONSTRAINT "kilo_pass_scheduled_changes_to_tier_check" CHECK ("kilo_pass_scheduled_changes"."to_tier" IN ('tier_19', 'tier_49', 'tier_199')),
	CONSTRAINT "kilo_pass_scheduled_changes_to_cadence_check" CHECK ("kilo_pass_scheduled_changes"."to_cadence" IN ('monthly', 'yearly')),
	CONSTRAINT "kilo_pass_scheduled_changes_status_check" CHECK ("kilo_pass_scheduled_changes"."status" IN ('not_started', 'active', 'completed', 'released', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"tier" text NOT NULL,
	"cadence" text NOT NULL,
	"status" text NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"current_streak_months" integer DEFAULT 0 NOT NULL,
	"next_yearly_issue_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilo_pass_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "kilo_pass_subscriptions_current_streak_months_non_negative_check" CHECK ("kilo_pass_subscriptions"."current_streak_months" >= 0),
	CONSTRAINT "kilo_pass_subscriptions_tier_check" CHECK ("kilo_pass_subscriptions"."tier" IN ('tier_19', 'tier_49', 'tier_199')),
	CONSTRAINT "kilo_pass_subscriptions_cadence_check" CHECK ("kilo_pass_subscriptions"."cadence" IN ('monthly', 'yearly'))
);
--> statement-breakpoint
CREATE TABLE "kilocode_users" (
	"id" text PRIMARY KEY NOT NULL,
	"google_user_email" text NOT NULL,
	"google_user_name" text NOT NULL,
	"google_user_image_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hosted_domain" text,
	"microdollars_used" bigint DEFAULT '0' NOT NULL,
	"kilo_pass_threshold" bigint,
	"stripe_customer_id" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"total_microdollars_acquired" bigint DEFAULT '0' NOT NULL,
	"next_credit_expiration_at" timestamp with time zone,
	"has_validation_stytch" boolean,
	"has_validation_novel_card_with_hold" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"api_token_pepper" text,
	"auto_top_up_enabled" boolean DEFAULT false NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"default_model" text,
	"cohorts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "UQ_b1afacbcf43f2c7c4cb9f7e7faa" UNIQUE("google_user_email"),
	CONSTRAINT "blocked_reason_not_empty" CHECK (length(blocked_reason) > 0)
);
--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_expires_at_future" CHECK ("magic_link_tokens"."expires_at" > "magic_link_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "microdollar_usage" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"cost" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cache_hit_tokens" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text,
	"model" text,
	"requested_model" text,
	"cache_discount" bigint,
	"has_error" boolean DEFAULT false NOT NULL,
	"abuse_classification" smallint DEFAULT 0 NOT NULL,
	"organization_id" uuid,
	"inference_provider" text,
	"project_id" text
);
--> statement-breakpoint
CREATE TABLE "microdollar_usage_metadata" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone,
	"message_id" text NOT NULL,
	"http_user_agent_id" integer,
	"http_ip_id" integer,
	"vercel_ip_city_id" integer,
	"vercel_ip_country_id" integer,
	"vercel_ip_latitude" real,
	"vercel_ip_longitude" real,
	"ja4_digest_id" integer,
	"user_prompt_prefix" text,
	"system_prompt_prefix_id" integer,
	"system_prompt_length" integer,
	"max_tokens" bigint,
	"has_middle_out_transform" boolean,
	"status_code" smallint,
	"upstream_id" text,
	"finish_reason_id" integer,
	"latency" real,
	"moderation_latency" real,
	"generation_time" real,
	"is_byok" boolean,
	"is_user_byok" boolean,
	"streamed" boolean,
	"cancelled" boolean,
	"editor_name_id" integer,
	"has_tools" boolean
);
--> statement-breakpoint
CREATE TABLE "model_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_active" boolean DEFAULT true,
	"is_featured" boolean DEFAULT false NOT NULL,
	"is_stealth" boolean DEFAULT false NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"openrouter_id" text NOT NULL,
	"slug" text,
	"aa_slug" text,
	"name" text NOT NULL,
	"description" text,
	"model_creator" text,
	"creator_slug" text,
	"release_date" date,
	"price_input" numeric(10, 6),
	"price_output" numeric(10, 6),
	"coding_index" numeric(5, 2),
	"speed_tokens_per_sec" numeric(8, 2),
	"context_length" integer,
	"max_output_tokens" integer,
	"input_modalities" text[],
	"openrouter_data" jsonb NOT NULL,
	"benchmarks" jsonb,
	"chart_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_stats_openrouter_id_unique" UNIQUE("openrouter_id"),
	CONSTRAINT "model_stats_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "models_by_provider" (
	"id" serial PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"actor_name" text,
	"organization_id" uuid NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_memberships_org_user" UNIQUE("organization_id","kilo_user_id")
);
--> statement-breakpoint
CREATE TABLE "organization_seats_purchases" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_stripe_id" text NOT NULL,
	"seat_count" integer NOT NULL,
	"amount_usd" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscription_status" text DEFAULT 'active' NOT NULL,
	"idempotency_key" text DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"billing_cycle" text DEFAULT 'monthly' NOT NULL,
	CONSTRAINT "UQ_organization_seats_idempotency_key" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "organization_user_limits" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"limit_type" text NOT NULL,
	"microdollar_limit" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_user_limits_org_user" UNIQUE("organization_id","kilo_user_id","limit_type")
);
--> statement-breakpoint
CREATE TABLE "organization_user_usage" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"usage_date" date NOT NULL,
	"limit_type" text NOT NULL,
	"microdollar_usage" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_user_daily_usage_org_user_date" UNIQUE("organization_id","kilo_user_id","limit_type","usage_date")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"microdollars_balance" bigint DEFAULT '0' NOT NULL,
	"microdollars_used" bigint DEFAULT '0' NOT NULL,
	"stripe_customer_id" text,
	"auto_top_up_enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seat_count" integer DEFAULT 0 NOT NULL,
	"require_seats" boolean DEFAULT false NOT NULL,
	"created_by_kilo_user_id" text,
	"deleted_at" timestamp with time zone,
	"sso_domain" text,
	"plan" text DEFAULT 'teams' NOT NULL,
	"free_trial_end_at" timestamp with time zone,
	CONSTRAINT "organizations_name_not_empty_check" CHECK (length(trim("organizations"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "organization_modes" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "UQ_organization_modes_org_id_slug" UNIQUE("organization_id","slug")
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"stripe_fingerprint" text,
	"user_id" text NOT NULL,
	"stripe_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last4" text,
	"brand" text,
	"address_line1" text,
	"address_line2" text,
	"address_city" text,
	"address_state" text,
	"address_zip" text,
	"address_country" text,
	"name" text,
	"three_d_secure_supported" boolean,
	"funding" text,
	"regulated_status" text,
	"address_line1_check_status" text,
	"postal_code_check_status" text,
	"http_x_forwarded_for" text,
	"http_x_vercel_ip_city" text,
	"http_x_vercel_ip_country" text,
	"http_x_vercel_ip_latitude" real,
	"http_x_vercel_ip_longitude" real,
	"http_x_vercel_ja4_digest" text,
	"eligible_for_free_credits" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"stripe_data" jsonb,
	"type" text,
	"organization_id" uuid,
	CONSTRAINT "UQ_29df1b0403df5792c96bbbfdbe6" UNIQUE("user_id","stripe_id")
);
--> statement-breakpoint
CREATE TABLE "platform_integrations" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"created_by_user_id" text,
	"platform" text NOT NULL,
	"integration_type" text NOT NULL,
	"platform_installation_id" text,
	"platform_account_id" text,
	"platform_account_login" text,
	"permissions" jsonb,
	"scopes" text[],
	"repository_access" text,
	"repositories" jsonb,
	"repositories_synced_at" timestamp with time zone,
	"metadata" jsonb,
	"kilo_requester_user_id" text,
	"platform_requester_account_id" text,
	"integration_status" text,
	"suspended_at" timestamp with time zone,
	"suspended_by" text,
	"github_app_type" text DEFAULT 'standard',
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_integrations_owner_check" CHECK ((
        ("platform_integrations"."owned_by_user_id" IS NOT NULL AND "platform_integrations"."owned_by_organization_id" IS NULL) OR
        ("platform_integrations"."owned_by_user_id" IS NULL AND "platform_integrations"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "referral_code_usages" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"referring_kilo_user_id" text NOT NULL,
	"redeeming_kilo_user_id" text NOT NULL,
	"code" text NOT NULL,
	"amount_usd" bigint,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_referral_code_usages_redeeming_user_id_code" UNIQUE("redeeming_kilo_user_id","referring_kilo_user_id")
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"code" text NOT NULL,
	"max_redemptions" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_findings" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform_integration_id" uuid,
	"repo_full_name" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"severity" text NOT NULL,
	"ghsa_id" text,
	"cve_id" text,
	"package_name" text NOT NULL,
	"package_ecosystem" text NOT NULL,
	"vulnerable_version_range" text,
	"patched_version" text,
	"manifest_path" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"ignored_reason" text,
	"ignored_by" text,
	"fixed_at" timestamp with time zone,
	"sla_due_at" timestamp with time zone,
	"dependabot_html_url" text,
	"cwe_ids" text[],
	"cvss_score" numeric(3, 1),
	"dependency_scope" text,
	"session_id" text,
	"cli_session_id" uuid,
	"analysis_status" text,
	"analysis_started_at" timestamp with time zone,
	"analysis_completed_at" timestamp with time zone,
	"analysis_error" text,
	"analysis" jsonb,
	"raw_data" jsonb,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_security_findings_source" UNIQUE("repo_full_name","source","source_id"),
	CONSTRAINT "security_findings_owner_check" CHECK ((
        ("security_findings"."owned_by_user_id" IS NOT NULL AND "security_findings"."owned_by_organization_id" IS NULL) OR
        ("security_findings"."owned_by_user_id" IS NULL AND "security_findings"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "shared_cli_sessions" (
	"share_id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"kilo_user_id" text NOT NULL,
	"shared_state" text DEFAULT 'public' NOT NULL,
	"api_conversation_history_blob_url" text,
	"task_metadata_blob_url" text,
	"ui_messages_blob_url" text,
	"git_state_blob_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_cli_sessions_shared_state_check" CHECK ("shared_cli_sessions"."shared_state" IN ('public', 'organization'))
);
--> statement-breakpoint
CREATE TABLE "slack_bot_requests" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform_integration_id" uuid,
	"slack_team_id" text NOT NULL,
	"slack_team_name" text,
	"slack_channel_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_thread_ts" text,
	"event_type" text NOT NULL,
	"user_message" text NOT NULL,
	"user_message_truncated" text,
	"status" text NOT NULL,
	"error_message" text,
	"response_time_ms" integer,
	"model_used" text,
	"tool_calls_made" text[],
	"cloud_agent_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_bot_requests_owner_check" CHECK ((
        ("slack_bot_requests"."owned_by_user_id" IS NOT NULL AND "slack_bot_requests"."owned_by_organization_id" IS NULL) OR
        ("slack_bot_requests"."owned_by_user_id" IS NULL AND "slack_bot_requests"."owned_by_organization_id" IS NOT NULL) OR
        ("slack_bot_requests"."owned_by_user_id" IS NULL AND "slack_bot_requests"."owned_by_organization_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "source_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"file_path" text NOT NULL,
	"file_hash" text,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"git_branch" text DEFAULT 'main' NOT NULL,
	"is_base_branch" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_source_embeddings_org_project_branch_file_lines" UNIQUE("organization_id","project_id","git_branch","file_path","start_line","end_line")
);
--> statement-breakpoint
CREATE TABLE "stytch_fingerprints" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"visitor_fingerprint" text NOT NULL,
	"browser_fingerprint" text NOT NULL,
	"browser_id" text,
	"hardware_fingerprint" text NOT NULL,
	"network_fingerprint" text NOT NULL,
	"visitor_id" text,
	"verdict_action" text NOT NULL,
	"detected_device_type" text NOT NULL,
	"is_authentic_device" boolean NOT NULL,
	"reasons" text[] DEFAULT '{""}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_code" integer NOT NULL,
	"fingerprint_data" jsonb NOT NULL,
	"kilo_free_tier_allowed" boolean DEFAULT false NOT NULL,
	"http_x_forwarded_for" text,
	"http_x_vercel_ip_city" text,
	"http_x_vercel_ip_country" text,
	"http_x_vercel_ip_latitude" real,
	"http_x_vercel_ip_longitude" real,
	"http_x_vercel_ja4_digest" text,
	"http_user_agent" text
);
--> statement-breakpoint
CREATE TABLE "system_prompt_prefix" (
	"system_prompt_prefix_id" serial PRIMARY KEY NOT NULL,
	"system_prompt_prefix" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_admin_notes" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"note_content" text NOT NULL,
	"admin_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_auth_provider" (
	"kilo_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text NOT NULL,
	"avatar_url" text NOT NULL,
	"hosted_domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_auth_provider_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "user_feedback" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text,
	"feedback_text" text NOT NULL,
	"feedback_for" text DEFAULT 'unknown' NOT NULL,
	"feedback_batch" text,
	"source" text DEFAULT 'unknown' NOT NULL,
	"context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_period_cache" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"cache_type" text NOT NULL,
	"period_type" text NOT NULL,
	"period_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"shared_url_token" text,
	"shared_at" timestamp with time zone,
	CONSTRAINT "user_period_cache_period_type_check" CHECK ("user_period_cache"."period_type" IN ('year', 'quarter', 'month', 'week', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "vercel_ip_city" (
	"vercel_ip_city_id" serial PRIMARY KEY NOT NULL,
	"vercel_ip_city" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vercel_ip_country" (
	"vercel_ip_country_id" serial PRIMARY KEY NOT NULL,
	"vercel_ip_country" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform" text NOT NULL,
	"event_type" text NOT NULL,
	"event_action" text,
	"payload" jsonb NOT NULL,
	"headers" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"handlers_triggered" text[] DEFAULT '{}' NOT NULL,
	"errors" jsonb,
	"event_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_webhook_events_signature" UNIQUE("event_signature"),
	CONSTRAINT "webhook_events_owner_check" CHECK ((
        ("webhook_events"."owned_by_user_id" IS NOT NULL AND "webhook_events"."owned_by_organization_id" IS NULL) OR
        ("webhook_events"."owned_by_user_id" IS NULL AND "webhook_events"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environment_profile_commands" ADD CONSTRAINT "agent_environment_profile_commands_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environment_profile_vars" ADD CONSTRAINT "agent_environment_profile_vars_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environment_profiles" ADD CONSTRAINT "agent_environment_profiles_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environment_profiles" ADD CONSTRAINT "agent_environment_profiles_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_messages" ADD CONSTRAINT "app_builder_messages_project_id_app_builder_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."app_builder_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_projects" ADD CONSTRAINT "app_builder_projects_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_projects" ADD CONSTRAINT "app_builder_projects_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_projects" ADD CONSTRAINT "app_builder_projects_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_reported_messages" ADD CONSTRAINT "app_reported_messages_cli_session_id_cli_sessions_session_id_fk" FOREIGN KEY ("cli_session_id") REFERENCES "public"."cli_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD CONSTRAINT "auto_fix_tickets_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD CONSTRAINT "auto_fix_tickets_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD CONSTRAINT "auto_fix_tickets_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD CONSTRAINT "auto_fix_tickets_triage_ticket_id_auto_triage_tickets_id_fk" FOREIGN KEY ("triage_ticket_id") REFERENCES "public"."auto_triage_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD CONSTRAINT "auto_fix_tickets_cli_session_id_cli_sessions_session_id_fk" FOREIGN KEY ("cli_session_id") REFERENCES "public"."cli_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_top_up_configs" ADD CONSTRAINT "auto_top_up_configs_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "auto_top_up_configs" ADD CONSTRAINT "auto_top_up_configs_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "auto_triage_tickets" ADD CONSTRAINT "auto_triage_tickets_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_triage_tickets" ADD CONSTRAINT "auto_triage_tickets_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_triage_tickets" ADD CONSTRAINT "auto_triage_tickets_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_triage_tickets" ADD CONSTRAINT "auto_triage_tickets_duplicate_of_ticket_id_auto_triage_tickets_id_fk" FOREIGN KEY ("duplicate_of_ticket_id") REFERENCES "public"."auto_triage_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "byok_api_keys" ADD CONSTRAINT "byok_api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "byok_api_keys" ADD CONSTRAINT "byok_api_keys_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_forked_from_cli_sessions_session_id_fk" FOREIGN KEY ("forked_from") REFERENCES "public"."cli_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_parent_session_id_cli_sessions_session_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."cli_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD CONSTRAINT "cli_sessions_v2_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD CONSTRAINT "cloud_agent_code_reviews_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD CONSTRAINT "cloud_agent_code_reviews_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD CONSTRAINT "cloud_agent_code_reviews_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD CONSTRAINT "cloud_agent_code_reviews_cli_session_id_cli_sessions_session_id_fk" FOREIGN KEY ("cli_session_id") REFERENCES "public"."cli_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD CONSTRAINT "cloud_agent_webhook_triggers_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD CONSTRAINT "cloud_agent_webhook_triggers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_webhook_triggers" ADD CONSTRAINT "cloud_agent_webhook_triggers_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_indexing_manifest" ADD CONSTRAINT "code_indexing_manifest_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_indexing_search" ADD CONSTRAINT "code_indexing_search_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_builds" ADD CONSTRAINT "deployment_builds_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_env_vars" ADD CONSTRAINT "deployment_env_vars_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_build_id_deployment_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."deployment_builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_threat_detections" ADD CONSTRAINT "deployment_threat_detections_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_threat_detections" ADD CONSTRAINT "deployment_threat_detections_build_id_deployment_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."deployment_builds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_data" ADD CONSTRAINT "enrichment_data_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kilo_pass_audit_log" ADD CONSTRAINT "kilo_pass_audit_log_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_audit_log" ADD CONSTRAINT "kilo_pass_audit_log_kilo_pass_subscription_id_kilo_pass_subscriptions_id_fk" FOREIGN KEY ("kilo_pass_subscription_id") REFERENCES "public"."kilo_pass_subscriptions"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_audit_log" ADD CONSTRAINT "kilo_pass_audit_log_related_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("related_credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_audit_log" ADD CONSTRAINT "kilo_pass_audit_log_related_monthly_issuance_id_kilo_pass_issuances_id_fk" FOREIGN KEY ("related_monthly_issuance_id") REFERENCES "public"."kilo_pass_issuances"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_issuance_items" ADD CONSTRAINT "kilo_pass_issuance_items_kilo_pass_issuance_id_kilo_pass_issuances_id_fk" FOREIGN KEY ("kilo_pass_issuance_id") REFERENCES "public"."kilo_pass_issuances"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_issuance_items" ADD CONSTRAINT "kilo_pass_issuance_items_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD CONSTRAINT "kilo_pass_issuances_kilo_pass_subscription_id_kilo_pass_subscriptions_id_fk" FOREIGN KEY ("kilo_pass_subscription_id") REFERENCES "public"."kilo_pass_subscriptions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_scheduled_changes" ADD CONSTRAINT "kilo_pass_scheduled_changes_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_scheduled_changes" ADD CONSTRAINT "kilo_pass_scheduled_changes_stripe_subscription_id_kilo_pass_subscriptions_stripe_subscription_id_fk" FOREIGN KEY ("stripe_subscription_id") REFERENCES "public"."kilo_pass_subscriptions"("stripe_subscription_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_subscriptions" ADD CONSTRAINT "kilo_pass_subscriptions_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "microdollar_usage_metadata" ADD CONSTRAINT "microdollar_usage_metadata_http_user_agent_id_http_user_agent_http_user_agent_id_fk" FOREIGN KEY ("http_user_agent_id") REFERENCES "public"."http_user_agent"("http_user_agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microdollar_usage_metadata" ADD CONSTRAINT "microdollar_usage_metadata_http_ip_id_http_ip_http_ip_id_fk" FOREIGN KEY ("http_ip_id") REFERENCES "public"."http_ip"("http_ip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microdollar_usage_metadata" ADD CONSTRAINT "microdollar_usage_metadata_vercel_ip_city_id_vercel_ip_city_vercel_ip_city_id_fk" FOREIGN KEY ("vercel_ip_city_id") REFERENCES "public"."vercel_ip_city"("vercel_ip_city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microdollar_usage_metadata" ADD CONSTRAINT "microdollar_usage_metadata_vercel_ip_country_id_vercel_ip_country_vercel_ip_country_id_fk" FOREIGN KEY ("vercel_ip_country_id") REFERENCES "public"."vercel_ip_country"("vercel_ip_country_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microdollar_usage_metadata" ADD CONSTRAINT "microdollar_usage_metadata_ja4_digest_id_ja4_digest_ja4_digest_id_fk" FOREIGN KEY ("ja4_digest_id") REFERENCES "public"."ja4_digest"("ja4_digest_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microdollar_usage_metadata" ADD CONSTRAINT "microdollar_usage_metadata_system_prompt_prefix_id_system_prompt_prefix_system_prompt_prefix_id_fk" FOREIGN KEY ("system_prompt_prefix_id") REFERENCES "public"."system_prompt_prefix"("system_prompt_prefix_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_cli_session_id_cli_sessions_session_id_fk" FOREIGN KEY ("cli_session_id") REFERENCES "public"."cli_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_cli_sessions" ADD CONSTRAINT "shared_cli_sessions_session_id_cli_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cli_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_cli_sessions" ADD CONSTRAINT "shared_cli_sessions_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_bot_requests" ADD CONSTRAINT "slack_bot_requests_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_bot_requests" ADD CONSTRAINT "slack_bot_requests_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_bot_requests" ADD CONSTRAINT "slack_bot_requests_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_embeddings" ADD CONSTRAINT "source_embeddings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_embeddings" ADD CONSTRAINT "source_embeddings_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_period_cache" ADD CONSTRAINT "user_period_cache_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_agent_configs_org_id" ON "agent_configs" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_configs_owned_by_user_id" ON "agent_configs" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_configs_agent_type" ON "agent_configs" USING btree ("agent_type");--> statement-breakpoint
CREATE INDEX "IDX_agent_configs_platform" ON "agent_configs" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "IDX_agent_env_profile_commands_profile_id" ON "agent_environment_profile_commands" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_env_profile_vars_profile_id" ON "agent_environment_profile_vars" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_agent_env_profiles_org_name" ON "agent_environment_profiles" USING btree ("owned_by_organization_id","name") WHERE "agent_environment_profiles"."owned_by_organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_agent_env_profiles_user_name" ON "agent_environment_profiles" USING btree ("owned_by_user_id","name") WHERE "agent_environment_profiles"."owned_by_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_agent_env_profiles_org_default" ON "agent_environment_profiles" USING btree ("owned_by_organization_id") WHERE "agent_environment_profiles"."is_default" = true AND "agent_environment_profiles"."owned_by_organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_agent_env_profiles_user_default" ON "agent_environment_profiles" USING btree ("owned_by_user_id") WHERE "agent_environment_profiles"."is_default" = true AND "agent_environment_profiles"."owned_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_agent_env_profiles_org_id" ON "agent_environment_profiles" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_env_profiles_user_id" ON "agent_environment_profiles" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_app_builder_messages_project_id" ON "app_builder_messages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "IDX_app_builder_messages_sequence" ON "app_builder_messages" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "IDX_app_builder_projects_created_by_user_id" ON "app_builder_projects" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_app_builder_projects_owned_by_user_id" ON "app_builder_projects" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_app_builder_projects_owned_by_organization_id" ON "app_builder_projects" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_app_builder_projects_created_at" ON "app_builder_projects" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_app_builder_projects_last_message_at" ON "app_builder_projects" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_auto_fix_tickets_repo_issue" ON "auto_fix_tickets" USING btree ("repo_full_name","issue_number");--> statement-breakpoint
CREATE INDEX "IDX_auto_fix_tickets_owned_by_org" ON "auto_fix_tickets" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_auto_fix_tickets_owned_by_user" ON "auto_fix_tickets" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_auto_fix_tickets_status" ON "auto_fix_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_auto_fix_tickets_created_at" ON "auto_fix_tickets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_auto_fix_tickets_triage_ticket_id" ON "auto_fix_tickets" USING btree ("triage_ticket_id");--> statement-breakpoint
CREATE INDEX "IDX_auto_fix_tickets_session_id" ON "auto_fix_tickets" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_auto_top_up_configs_owned_by_user_id" ON "auto_top_up_configs" USING btree ("owned_by_user_id") WHERE "auto_top_up_configs"."owned_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_auto_top_up_configs_owned_by_organization_id" ON "auto_top_up_configs" USING btree ("owned_by_organization_id") WHERE "auto_top_up_configs"."owned_by_organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_auto_triage_tickets_repo_issue" ON "auto_triage_tickets" USING btree ("repo_full_name","issue_number");--> statement-breakpoint
CREATE INDEX "IDX_auto_triage_tickets_owned_by_org" ON "auto_triage_tickets" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_auto_triage_tickets_owned_by_user" ON "auto_triage_tickets" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_auto_triage_tickets_status" ON "auto_triage_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_auto_triage_tickets_created_at" ON "auto_triage_tickets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_auto_triage_tickets_qdrant_point_id" ON "auto_triage_tickets" USING btree ("qdrant_point_id");--> statement-breakpoint
CREATE INDEX "IDX_auto_triage_tickets_owner_status_created" ON "auto_triage_tickets" USING btree ("owned_by_organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "IDX_auto_triage_tickets_user_status_created" ON "auto_triage_tickets" USING btree ("owned_by_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "IDX_auto_triage_tickets_repo_classification" ON "auto_triage_tickets" USING btree ("repo_full_name","classification","created_at");--> statement-breakpoint
CREATE INDEX "IDX_byok_api_keys_organization_id" ON "byok_api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_byok_api_keys_kilo_user_id" ON "byok_api_keys" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_byok_api_keys_provider_id" ON "byok_api_keys" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "IDX_cli_sessions_kilo_user_id" ON "cli_sessions" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_cli_sessions_created_at" ON "cli_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_cli_sessions_updated_at" ON "cli_sessions" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "IDX_cli_sessions_organization_id" ON "cli_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_cli_sessions_user_updated" ON "cli_sessions" USING btree ("kilo_user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cli_sessions_v2_public_id" ON "cli_sessions_v2" USING btree ("public_id") WHERE "cli_sessions_v2"."public_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_cli_sessions_v2_kilo_user_id" ON "cli_sessions_v2" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_cli_sessions_v2_created_at" ON "cli_sessions_v2" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_code_reviews_repo_pr_sha" ON "cloud_agent_code_reviews" USING btree ("repo_full_name","pr_number","head_sha");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_reviews_owned_by_org_id" ON "cloud_agent_code_reviews" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_reviews_owned_by_user_id" ON "cloud_agent_code_reviews" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_reviews_session_id" ON "cloud_agent_code_reviews" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_reviews_cli_session_id" ON "cloud_agent_code_reviews" USING btree ("cli_session_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_reviews_status" ON "cloud_agent_code_reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_reviews_repo" ON "cloud_agent_code_reviews" USING btree ("repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_reviews_pr_number" ON "cloud_agent_code_reviews" USING btree ("repo_full_name","pr_number");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_reviews_created_at" ON "cloud_agent_code_reviews" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_reviews_pr_author_github_id" ON "cloud_agent_code_reviews" USING btree ("pr_author_github_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_webhook_triggers_user_trigger" ON "cloud_agent_webhook_triggers" USING btree ("user_id","trigger_id") WHERE "cloud_agent_webhook_triggers"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_webhook_triggers_org_trigger" ON "cloud_agent_webhook_triggers" USING btree ("organization_id","trigger_id") WHERE "cloud_agent_webhook_triggers"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_webhook_triggers_user" ON "cloud_agent_webhook_triggers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_webhook_triggers_org" ON "cloud_agent_webhook_triggers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_webhook_triggers_active" ON "cloud_agent_webhook_triggers" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_webhook_triggers_profile" ON "cloud_agent_webhook_triggers" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_manifest_organization_id" ON "code_indexing_manifest" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_manifest_kilo_user_id" ON "code_indexing_manifest" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_manifest_project_id" ON "code_indexing_manifest" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_manifest_file_hash" ON "code_indexing_manifest" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_manifest_git_branch" ON "code_indexing_manifest" USING btree ("git_branch");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_manifest_created_at" ON "code_indexing_manifest" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_search_organization_id" ON "code_indexing_search" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_search_kilo_user_id" ON "code_indexing_search" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_search_project_id" ON "code_indexing_search" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "IDX_code_indexing_search_created_at" ON "code_indexing_search" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_credit_transactions_created_at" ON "credit_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_credit_transactions_is_free" ON "credit_transactions" USING btree ("is_free");--> statement-breakpoint
CREATE INDEX "IDX_credit_transactions_kilo_user_id" ON "credit_transactions" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_credit_transactions_credit_category" ON "credit_transactions" USING btree ("credit_category");--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_credit_transactions_stripe_payment_id" ON "credit_transactions" USING btree ("stripe_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_credit_transactions_original_transaction_id" ON "credit_transactions" USING btree ("original_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_credit_transactions_coinbase_credit_block_id" ON "credit_transactions" USING btree ("coinbase_credit_block_id");--> statement-breakpoint
CREATE INDEX "IDX_credit_transactions_organization_id" ON "credit_transactions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_credit_transactions_unique_category" ON "credit_transactions" USING btree ("kilo_user_id","credit_category") WHERE "credit_transactions"."check_category_uniqueness" = TRUE;--> statement-breakpoint
CREATE INDEX "idx_deployment_builds_deployment_id" ON "deployment_builds" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "idx_deployment_builds_status" ON "deployment_builds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_deployment_env_vars_deployment_id" ON "deployment_env_vars" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "idx_deployment_events_build_id" ON "deployment_events" USING btree ("build_id");--> statement-breakpoint
CREATE INDEX "idx_deployment_events_timestamp" ON "deployment_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_deployment_events_type" ON "deployment_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_deployment_threat_detections_deployment_id" ON "deployment_threat_detections" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "idx_deployment_threat_detections_created_at" ON "deployment_threat_detections" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_deployments_owned_by_user_id" ON "deployments" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_deployments_owned_by_organization_id" ON "deployments" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_deployments_platform_integration_id" ON "deployments" USING btree ("platform_integration_id");--> statement-breakpoint
CREATE INDEX "idx_deployments_repository_source_branch" ON "deployments" USING btree ("repository_source","branch");--> statement-breakpoint
CREATE INDEX "idx_deployments_threat_status_pending" ON "deployments" USING btree ("threat_status") WHERE "deployments"."threat_status" = 'pending_scan';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_device_auth_requests_code" ON "device_auth_requests" USING btree ("code");--> statement-breakpoint
CREATE INDEX "IDX_device_auth_requests_status" ON "device_auth_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_device_auth_requests_expires_at" ON "device_auth_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_device_auth_requests_kilo_user_id" ON "device_auth_requests" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_editor_name" ON "editor_name" USING btree ("editor_name");--> statement-breakpoint
CREATE INDEX "IDX_enrichment_data_user_id" ON "enrichment_data" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_finish_reason" ON "finish_reason" USING btree ("finish_reason");--> statement-breakpoint
CREATE INDEX "idx_free_model_usage_ip_created_at" ON "free_model_usage" USING btree ("ip_address","created_at");--> statement-breakpoint
CREATE INDEX "idx_free_model_usage_created_at" ON "free_model_usage" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_http_ip" ON "http_ip" USING btree ("http_ip");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_http_user_agent" ON "http_user_agent" USING btree ("http_user_agent");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_ja4_digest" ON "ja4_digest" USING btree ("ja4_digest");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_created_at" ON "kilo_pass_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_kilo_user_id" ON "kilo_pass_audit_log" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_kilo_pass_subscription_id" ON "kilo_pass_audit_log" USING btree ("kilo_pass_subscription_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_action" ON "kilo_pass_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_result" ON "kilo_pass_audit_log" USING btree ("result");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_idempotency_key" ON "kilo_pass_audit_log" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_stripe_event_id" ON "kilo_pass_audit_log" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_stripe_invoice_id" ON "kilo_pass_audit_log" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_stripe_subscription_id" ON "kilo_pass_audit_log" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_related_credit_transaction_id" ON "kilo_pass_audit_log" USING btree ("related_credit_transaction_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_audit_log_related_monthly_issuance_id" ON "kilo_pass_audit_log" USING btree ("related_monthly_issuance_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_issuance_items_issuance_id" ON "kilo_pass_issuance_items" USING btree ("kilo_pass_issuance_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_issuance_items_credit_transaction_id" ON "kilo_pass_issuance_items" USING btree ("credit_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_issuances_stripe_invoice_id" ON "kilo_pass_issuances" USING btree ("stripe_invoice_id") WHERE "kilo_pass_issuances"."stripe_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_issuances_subscription_id" ON "kilo_pass_issuances" USING btree ("kilo_pass_subscription_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_issuances_issue_month" ON "kilo_pass_issuances" USING btree ("issue_month");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_scheduled_changes_kilo_user_id" ON "kilo_pass_scheduled_changes" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_scheduled_changes_status" ON "kilo_pass_scheduled_changes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_scheduled_changes_stripe_subscription_id" ON "kilo_pass_scheduled_changes" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_scheduled_changes_active_stripe_subscription_id" ON "kilo_pass_scheduled_changes" USING btree ("stripe_subscription_id") WHERE "kilo_pass_scheduled_changes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_scheduled_changes_effective_at" ON "kilo_pass_scheduled_changes" USING btree ("effective_at");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_scheduled_changes_deleted_at" ON "kilo_pass_scheduled_changes" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_subscriptions_kilo_user_id" ON "kilo_pass_subscriptions" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_subscriptions_status" ON "kilo_pass_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_subscriptions_cadence" ON "kilo_pass_subscriptions" USING btree ("cadence");--> statement-breakpoint
CREATE INDEX "idx_magic_link_tokens_email" ON "magic_link_tokens" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_magic_link_tokens_expires_at" ON "magic_link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_created_at" ON "microdollar_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_abuse_classification" ON "microdollar_usage" USING btree ("abuse_classification");--> statement-breakpoint
CREATE INDEX "idx_kilo_user_id_created_at2" ON "microdollar_usage" USING btree ("kilo_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_microdollar_usage_organization_id" ON "microdollar_usage" USING btree ("organization_id") WHERE "microdollar_usage"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_microdollar_usage_metadata_created_at" ON "microdollar_usage_metadata" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_model_stats_openrouter_id" ON "model_stats" USING btree ("openrouter_id");--> statement-breakpoint
CREATE INDEX "IDX_model_stats_slug" ON "model_stats" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "IDX_model_stats_is_active" ON "model_stats" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "IDX_model_stats_creator_slug" ON "model_stats" USING btree ("creator_slug");--> statement-breakpoint
CREATE INDEX "IDX_model_stats_price_input" ON "model_stats" USING btree ("price_input");--> statement-breakpoint
CREATE INDEX "IDX_model_stats_coding_index" ON "model_stats" USING btree ("coding_index");--> statement-breakpoint
CREATE INDEX "IDX_model_stats_context_length" ON "model_stats" USING btree ("context_length");--> statement-breakpoint
CREATE INDEX "IDX_organization_audit_logs_organization_id" ON "organization_audit_logs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_organization_audit_logs_action" ON "organization_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "IDX_organization_audit_logs_actor_id" ON "organization_audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "IDX_organization_audit_logs_created_at" ON "organization_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_organization_invitations_token" ON "organization_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "IDX_organization_invitations_org_id" ON "organization_invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_organization_invitations_email" ON "organization_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "IDX_organization_invitations_expires_at" ON "organization_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_organization_memberships_org_id" ON "organization_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_organization_memberships_user_id" ON "organization_memberships" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_organization_seats_org_id" ON "organization_seats_purchases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_organization_seats_expires_at" ON "organization_seats_purchases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_organization_seats_created_at" ON "organization_seats_purchases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_organization_seats_updated_at" ON "organization_seats_purchases" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "IDX_organization_seats_starts_at" ON "organization_seats_purchases" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "IDX_organization_user_limits_org_id" ON "organization_user_limits" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_organization_user_limits_user_id" ON "organization_user_limits" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_organization_user_daily_usage_org_id" ON "organization_user_usage" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_organization_user_daily_usage_user_id" ON "organization_user_usage" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_organizations_sso_domain" ON "organizations" USING btree ("sso_domain");--> statement-breakpoint
CREATE INDEX "IDX_organization_modes_organization_id" ON "organization_modes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_d7d7fb15569674aaadcfbc0428" ON "payment_methods" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_e1feb919d0ab8a36381d5d5138" ON "payment_methods" USING btree ("stripe_fingerprint");--> statement-breakpoint
CREATE INDEX "IDX_payment_methods_organization_id" ON "payment_methods" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_owned_by_org_platform_inst" ON "platform_integrations" USING btree ("owned_by_organization_id","platform","platform_installation_id") WHERE "platform_integrations"."owned_by_organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_owned_by_user_platform_inst" ON "platform_integrations" USING btree ("owned_by_user_id","platform","platform_installation_id") WHERE "platform_integrations"."owned_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_platform_integrations_owned_by_org_id" ON "platform_integrations" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_platform_integrations_owned_by_user_id" ON "platform_integrations" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_platform_integrations_platform_inst_id" ON "platform_integrations" USING btree ("platform_installation_id");--> statement-breakpoint
CREATE INDEX "IDX_platform_integrations_platform" ON "platform_integrations" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "IDX_platform_integrations_owned_by_org_platform" ON "platform_integrations" USING btree ("owned_by_organization_id","platform");--> statement-breakpoint
CREATE INDEX "IDX_platform_integrations_owned_by_user_platform" ON "platform_integrations" USING btree ("owned_by_user_id","platform");--> statement-breakpoint
CREATE INDEX "IDX_platform_integrations_integration_status" ON "platform_integrations" USING btree ("integration_status");--> statement-breakpoint
CREATE INDEX "IDX_platform_integrations_kilo_requester" ON "platform_integrations" USING btree ("platform","kilo_requester_user_id","integration_status");--> statement-breakpoint
CREATE INDEX "IDX_platform_integrations_platform_requester" ON "platform_integrations" USING btree ("platform","platform_requester_account_id","integration_status");--> statement-breakpoint
CREATE INDEX "IDX_referral_code_usages_redeeming_kilo_user_id" ON "referral_code_usages" USING btree ("redeeming_kilo_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_referral_codes_kilo_user_id" ON "referral_codes" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_referral_codes_code" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_security_findings_org_id" ON "security_findings" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_security_findings_user_id" ON "security_findings" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_security_findings_repo" ON "security_findings" USING btree ("repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_security_findings_severity" ON "security_findings" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_security_findings_status" ON "security_findings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_security_findings_package" ON "security_findings" USING btree ("package_name");--> statement-breakpoint
CREATE INDEX "idx_security_findings_sla_due_at" ON "security_findings" USING btree ("sla_due_at");--> statement-breakpoint
CREATE INDEX "idx_security_findings_session_id" ON "security_findings" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_security_findings_cli_session_id" ON "security_findings" USING btree ("cli_session_id");--> statement-breakpoint
CREATE INDEX "idx_security_findings_analysis_status" ON "security_findings" USING btree ("analysis_status");--> statement-breakpoint
CREATE INDEX "IDX_shared_cli_sessions_session_id" ON "shared_cli_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "IDX_shared_cli_sessions_created_at" ON "shared_cli_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_slack_bot_requests_created_at" ON "slack_bot_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_slack_bot_requests_slack_team_id" ON "slack_bot_requests" USING btree ("slack_team_id");--> statement-breakpoint
CREATE INDEX "idx_slack_bot_requests_owned_by_org_id" ON "slack_bot_requests" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_slack_bot_requests_owned_by_user_id" ON "slack_bot_requests" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_slack_bot_requests_status" ON "slack_bot_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_slack_bot_requests_event_type" ON "slack_bot_requests" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_slack_bot_requests_team_created" ON "slack_bot_requests" USING btree ("slack_team_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_source_embeddings_organization_id" ON "source_embeddings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_source_embeddings_kilo_user_id" ON "source_embeddings" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_source_embeddings_project_id" ON "source_embeddings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "IDX_source_embeddings_created_at" ON "source_embeddings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_source_embeddings_updated_at" ON "source_embeddings" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "IDX_source_embeddings_file_path_lower" ON "source_embeddings" USING btree (LOWER("file_path"));--> statement-breakpoint
CREATE INDEX "IDX_source_embeddings_git_branch" ON "source_embeddings" USING btree ("git_branch");--> statement-breakpoint
CREATE INDEX "IDX_source_embeddings_org_project_branch" ON "source_embeddings" USING btree ("organization_id","project_id","git_branch");--> statement-breakpoint
CREATE INDEX "idx_fingerprint_data" ON "stytch_fingerprints" USING btree ("fingerprint_data");--> statement-breakpoint
CREATE INDEX "idx_hardware_fingerprint" ON "stytch_fingerprints" USING btree ("hardware_fingerprint");--> statement-breakpoint
CREATE INDEX "idx_kilo_user_id" ON "stytch_fingerprints" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "idx_reasons" ON "stytch_fingerprints" USING btree ("reasons");--> statement-breakpoint
CREATE INDEX "idx_verdict_action" ON "stytch_fingerprints" USING btree ("verdict_action");--> statement-breakpoint
CREATE INDEX "idx_visitor_fingerprint" ON "stytch_fingerprints" USING btree ("visitor_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_system_prompt_prefix" ON "system_prompt_prefix" USING btree ("system_prompt_prefix");--> statement-breakpoint
CREATE INDEX "IDX_34517df0b385234babc38fe81b" ON "user_admin_notes" USING btree ("admin_kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_ccbde98c4c14046daa5682ec4f" ON "user_admin_notes" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_d0270eb24ef6442d65a0b7853c" ON "user_admin_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_user_auth_provider_kilo_user_id" ON "user_auth_provider" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_user_auth_provider_hosted_domain" ON "user_auth_provider" USING btree ("hosted_domain");--> statement-breakpoint
CREATE INDEX "IDX_user_feedback_created_at" ON "user_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_user_feedback_kilo_user_id" ON "user_feedback" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_user_feedback_feedback_for" ON "user_feedback" USING btree ("feedback_for");--> statement-breakpoint
CREATE INDEX "IDX_user_feedback_feedback_batch" ON "user_feedback" USING btree ("feedback_batch");--> statement-breakpoint
CREATE INDEX "IDX_user_feedback_source" ON "user_feedback" USING btree ("source");--> statement-breakpoint
CREATE INDEX "IDX_user_period_cache_kilo_user_id" ON "user_period_cache" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_period_cache" ON "user_period_cache" USING btree ("kilo_user_id","cache_type","period_type","period_key");--> statement-breakpoint
CREATE INDEX "IDX_user_period_cache_lookup" ON "user_period_cache" USING btree ("cache_type","period_type","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_period_cache_share_token" ON "user_period_cache" USING btree ("shared_url_token") WHERE "user_period_cache"."shared_url_token" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_vercel_ip_city" ON "vercel_ip_city" USING btree ("vercel_ip_city");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_vercel_ip_country" ON "vercel_ip_country" USING btree ("vercel_ip_country");--> statement-breakpoint
CREATE INDEX "IDX_webhook_events_owned_by_org_id" ON "webhook_events" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_webhook_events_owned_by_user_id" ON "webhook_events" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_webhook_events_platform" ON "webhook_events" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "IDX_webhook_events_event_type" ON "webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "IDX_webhook_events_created_at" ON "webhook_events" USING btree ("created_at");--> statement-breakpoint
CREATE VIEW "public"."microdollar_usage_view" AS (
  SELECT
    mu.id,
    mu.kilo_user_id,
    meta.message_id,
    mu.cost,
    mu.input_tokens,
    mu.output_tokens,
    mu.cache_write_tokens,
    mu.cache_hit_tokens,
    mu.created_at,
    ip.http_ip AS http_x_forwarded_for,
    city.vercel_ip_city AS http_x_vercel_ip_city,
    country.vercel_ip_country AS http_x_vercel_ip_country,
    meta.vercel_ip_latitude AS http_x_vercel_ip_latitude,
    meta.vercel_ip_longitude AS http_x_vercel_ip_longitude,
    ja4.ja4_digest AS http_x_vercel_ja4_digest,
    mu.provider,
    mu.model,
    mu.requested_model,
    meta.user_prompt_prefix,
    spp.system_prompt_prefix,
    meta.system_prompt_length,
    ua.http_user_agent,
    mu.cache_discount,
    meta.max_tokens,
    meta.has_middle_out_transform,
    mu.has_error,
    mu.abuse_classification,
    mu.organization_id,
    mu.inference_provider,
    mu.project_id,
    meta.status_code,
    meta.upstream_id,
    frfr.finish_reason,
    meta.latency,
    meta.moderation_latency,
    meta.generation_time,
    meta.is_byok,
    meta.is_user_byok,
    meta.streamed,
    meta.cancelled,
    edit.editor_name,
    meta.has_tools
  FROM "microdollar_usage" mu
  LEFT JOIN "microdollar_usage_metadata" meta ON mu.id = meta.id
  LEFT JOIN "http_ip" ip ON meta.http_ip_id = ip.http_ip_id
  LEFT JOIN "vercel_ip_city" city ON meta.vercel_ip_city_id = city.vercel_ip_city_id
  LEFT JOIN "vercel_ip_country" country ON meta.vercel_ip_country_id = country.vercel_ip_country_id
  LEFT JOIN "ja4_digest" ja4 ON meta.ja4_digest_id = ja4.ja4_digest_id
  LEFT JOIN "system_prompt_prefix" spp ON meta.system_prompt_prefix_id = spp.system_prompt_prefix_id
  LEFT JOIN "http_user_agent" ua ON meta.http_user_agent_id = ua.http_user_agent_id
  LEFT JOIN "finish_reason" frfr ON meta.finish_reason_id = frfr.finish_reason_id
  LEFT JOIN "editor_name" edit ON meta.editor_name_id = edit.editor_name_id
);
