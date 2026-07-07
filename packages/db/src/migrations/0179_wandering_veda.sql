CREATE TABLE "cost_insight_active_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"suggestion_kind" text NOT NULL,
	"suggestion_key" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"cta_label" text NOT NULL,
	"cta_href" text NOT NULL,
	"evidence_window_start" timestamp with time zone NOT NULL,
	"evidence_window_end" timestamp with time zone NOT NULL,
	"observed_microdollars" bigint NOT NULL,
	"benefit_label" text NOT NULL,
	"benefit_detail" text NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismissed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_active_suggestions_owner_check" CHECK (("cost_insight_active_suggestions"."owned_by_user_id" IS NOT NULL AND "cost_insight_active_suggestions"."owned_by_organization_id" IS NULL) OR ("cost_insight_active_suggestions"."owned_by_user_id" IS NULL AND "cost_insight_active_suggestions"."owned_by_organization_id" IS NOT NULL)),
	CONSTRAINT "cost_insight_active_suggestions_kind_check" CHECK ("cost_insight_active_suggestions"."suggestion_kind" IN ('coding_plan', 'kilo_pass')),
	CONSTRAINT "cost_insight_active_suggestions_key_check" CHECK ("cost_insight_active_suggestions"."suggestion_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cost_insight_active_suggestions_window_check" CHECK ("cost_insight_active_suggestions"."evidence_window_end" > "cost_insight_active_suggestions"."evidence_window_start"),
	CONSTRAINT "cost_insight_active_suggestions_observed_positive_check" CHECK ("cost_insight_active_suggestions"."observed_microdollars" > 0),
	CONSTRAINT "cost_insight_active_suggestions_observed_safe_check" CHECK ("cost_insight_active_suggestions"."observed_microdollars" <= 9007199254740991),
	CONSTRAINT "cost_insight_active_suggestions_dismissed_by_check" CHECK ("cost_insight_active_suggestions"."dismissed_at" IS NOT NULL OR "cost_insight_active_suggestions"."dismissed_by_user_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "cost_insight_evaluation_dirty_owners" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"generation" bigint DEFAULT '1' NOT NULL,
	"dirty_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_redacted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_evaluation_dirty_owners_owner_check" CHECK (("cost_insight_evaluation_dirty_owners"."owned_by_user_id" IS NOT NULL AND "cost_insight_evaluation_dirty_owners"."owned_by_organization_id" IS NULL) OR ("cost_insight_evaluation_dirty_owners"."owned_by_user_id" IS NULL AND "cost_insight_evaluation_dirty_owners"."owned_by_organization_id" IS NOT NULL)),
	CONSTRAINT "cost_insight_evaluation_dirty_owners_generation_check" CHECK ("cost_insight_evaluation_dirty_owners"."generation" > 0 AND "cost_insight_evaluation_dirty_owners"."generation" <= 9007199254740991),
	CONSTRAINT "cost_insight_evaluation_dirty_owners_attempt_count_check" CHECK ("cost_insight_evaluation_dirty_owners"."attempt_count" >= 0),
	CONSTRAINT "cost_insight_evaluation_dirty_owners_claim_token_check" CHECK (("cost_insight_evaluation_dirty_owners"."claimed_at" IS NULL AND "cost_insight_evaluation_dirty_owners"."claim_token" IS NULL) OR ("cost_insight_evaluation_dirty_owners"."claimed_at" IS NOT NULL AND "cost_insight_evaluation_dirty_owners"."claim_token" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cost_insight_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"event_type" text NOT NULL,
	"alert_kind" text,
	"suggestion_kind" text,
	"active_suggestion_id" uuid,
	"actor_user_id" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_events_owner_check" CHECK (("cost_insight_events"."owned_by_user_id" IS NOT NULL AND "cost_insight_events"."owned_by_organization_id" IS NULL) OR ("cost_insight_events"."owned_by_user_id" IS NULL AND "cost_insight_events"."owned_by_organization_id" IS NOT NULL)),
	CONSTRAINT "cost_insight_events_type_check" CHECK ("cost_insight_events"."event_type" IN ('config_changed', 'anomaly_alert', 'threshold_crossed', 'alert_reviewed', 'suggestion_created', 'suggestion_dismissed', 'disabled')),
	CONSTRAINT "cost_insight_events_alert_kind_check" CHECK ("cost_insight_events"."alert_kind" IN ('anomaly', 'threshold', 'threshold_7d', 'threshold_30d')),
	CONSTRAINT "cost_insight_events_suggestion_kind_check" CHECK ("cost_insight_events"."suggestion_kind" IN ('coding_plan', 'kilo_pass')),
	CONSTRAINT "cost_insight_events_alert_kind_presence_check" CHECK (("cost_insight_events"."event_type" IN ('anomaly_alert', 'threshold_crossed', 'alert_reviewed') AND "cost_insight_events"."alert_kind" IS NOT NULL) OR ("cost_insight_events"."event_type" NOT IN ('anomaly_alert', 'threshold_crossed', 'alert_reviewed') AND "cost_insight_events"."alert_kind" IS NULL)),
	CONSTRAINT "cost_insight_events_suggestion_kind_presence_check" CHECK (("cost_insight_events"."event_type" IN ('suggestion_created', 'suggestion_dismissed') AND "cost_insight_events"."suggestion_kind" IS NOT NULL) OR ("cost_insight_events"."event_type" NOT IN ('suggestion_created', 'suggestion_dismissed') AND "cost_insight_events"."suggestion_kind" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "cost_insight_hourly_sweep_checkpoints" (
	"job_name" text PRIMARY KEY NOT NULL,
	"cycle_id" uuid,
	"cycle_as_of" timestamp with time zone,
	"cohort_created_before" timestamp with time zone,
	"cursor_owner_type" text,
	"cursor_owner_id" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_hourly_sweep_job_name_check" CHECK ("cost_insight_hourly_sweep_checkpoints"."job_name" <> ''),
	CONSTRAINT "cost_insight_hourly_sweep_cursor_owner_type_check" CHECK ("cost_insight_hourly_sweep_checkpoints"."cursor_owner_type" IS NULL OR "cost_insight_hourly_sweep_checkpoints"."cursor_owner_type" IN ('user', 'organization')),
	CONSTRAINT "cost_insight_hourly_sweep_cursor_check" CHECK (("cost_insight_hourly_sweep_checkpoints"."cursor_owner_type" IS NULL AND "cost_insight_hourly_sweep_checkpoints"."cursor_owner_id" IS NULL) OR ("cost_insight_hourly_sweep_checkpoints"."cursor_owner_type" IS NOT NULL AND "cost_insight_hourly_sweep_checkpoints"."cursor_owner_id" IS NOT NULL)),
	CONSTRAINT "cost_insight_hourly_sweep_lease_check" CHECK (("cost_insight_hourly_sweep_checkpoints"."lease_token" IS NULL AND "cost_insight_hourly_sweep_checkpoints"."lease_expires_at" IS NULL) OR ("cost_insight_hourly_sweep_checkpoints"."lease_token" IS NOT NULL AND "cost_insight_hourly_sweep_checkpoints"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "cost_insight_hourly_sweep_cycle_check" CHECK (("cost_insight_hourly_sweep_checkpoints"."cycle_id" IS NULL AND "cost_insight_hourly_sweep_checkpoints"."cycle_as_of" IS NULL AND "cost_insight_hourly_sweep_checkpoints"."cohort_created_before" IS NULL AND "cost_insight_hourly_sweep_checkpoints"."started_at" IS NULL) OR ("cost_insight_hourly_sweep_checkpoints"."cycle_id" IS NOT NULL AND "cost_insight_hourly_sweep_checkpoints"."cycle_as_of" IS NOT NULL AND "cost_insight_hourly_sweep_checkpoints"."cohort_created_before" IS NOT NULL AND "cost_insight_hourly_sweep_checkpoints"."started_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cost_insight_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"recipient_user_id" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_redacted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_notification_deliveries_channel_check" CHECK ("cost_insight_notification_deliveries"."channel" = 'email'),
	CONSTRAINT "cost_insight_notification_deliveries_status_check" CHECK ("cost_insight_notification_deliveries"."status" IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "cost_insight_notification_deliveries_attempt_count_check" CHECK ("cost_insight_notification_deliveries"."attempt_count" >= 0),
	CONSTRAINT "cost_insight_notification_deliveries_terminal_check" CHECK (("cost_insight_notification_deliveries"."status" = 'sent' AND "cost_insight_notification_deliveries"."sent_at" IS NOT NULL) OR ("cost_insight_notification_deliveries"."status" <> 'sent' AND "cost_insight_notification_deliveries"."sent_at" IS NULL)),
	CONSTRAINT "cost_insight_notification_deliveries_failure_check" CHECK (("cost_insight_notification_deliveries"."status" = 'failed' AND "cost_insight_notification_deliveries"."failed_at" IS NOT NULL) OR ("cost_insight_notification_deliveries"."status" <> 'failed' AND "cost_insight_notification_deliveries"."failed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "cost_insight_owner_configs" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"spend_alerts_enabled" boolean DEFAULT false NOT NULL,
	"anomaly_alerts_enabled" boolean DEFAULT true NOT NULL,
	"cost_suggestions_enabled" boolean DEFAULT true NOT NULL,
	"spend_threshold_microdollars" bigint,
	"spend_7_day_threshold_microdollars" bigint,
	"spend_30_day_threshold_microdollars" bigint,
	"spend_alerts_enabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_owner_configs_owner_check" CHECK (("cost_insight_owner_configs"."owned_by_user_id" IS NOT NULL AND "cost_insight_owner_configs"."owned_by_organization_id" IS NULL) OR ("cost_insight_owner_configs"."owned_by_user_id" IS NULL AND "cost_insight_owner_configs"."owned_by_organization_id" IS NOT NULL)),
	CONSTRAINT "cost_insight_owner_configs_threshold_positive_check" CHECK ("cost_insight_owner_configs"."spend_threshold_microdollars" IS NULL OR "cost_insight_owner_configs"."spend_threshold_microdollars" > 0),
	CONSTRAINT "cost_insight_owner_configs_threshold_safe_check" CHECK ("cost_insight_owner_configs"."spend_threshold_microdollars" IS NULL OR "cost_insight_owner_configs"."spend_threshold_microdollars" <= 9007199254740991),
	CONSTRAINT "cost_insight_owner_configs_7_day_threshold_positive_check" CHECK ("cost_insight_owner_configs"."spend_7_day_threshold_microdollars" IS NULL OR "cost_insight_owner_configs"."spend_7_day_threshold_microdollars" > 0),
	CONSTRAINT "cost_insight_owner_configs_7_day_threshold_safe_check" CHECK ("cost_insight_owner_configs"."spend_7_day_threshold_microdollars" IS NULL OR "cost_insight_owner_configs"."spend_7_day_threshold_microdollars" <= 9007199254740991),
	CONSTRAINT "cost_insight_owner_configs_30_day_threshold_positive_check" CHECK ("cost_insight_owner_configs"."spend_30_day_threshold_microdollars" IS NULL OR "cost_insight_owner_configs"."spend_30_day_threshold_microdollars" > 0),
	CONSTRAINT "cost_insight_owner_configs_30_day_threshold_safe_check" CHECK ("cost_insight_owner_configs"."spend_30_day_threshold_microdollars" IS NULL OR "cost_insight_owner_configs"."spend_30_day_threshold_microdollars" <= 9007199254740991),
	CONSTRAINT "cost_insight_owner_configs_enabled_at_check" CHECK ("cost_insight_owner_configs"."spend_alerts_enabled" = TRUE OR "cost_insight_owner_configs"."spend_alerts_enabled_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "cost_insight_owner_hour_driver_buckets" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"hour_start" timestamp with time zone NOT NULL,
	"spend_category" text NOT NULL,
	"driver_key" text NOT NULL,
	"source" text NOT NULL,
	"product_key" text NOT NULL,
	"feature_key" text NOT NULL,
	"model_or_plan_key" text NOT NULL,
	"provider_key" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"total_microdollars" bigint NOT NULL,
	"spend_record_count" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_driver_buckets_owner_check" CHECK (("cost_insight_owner_hour_driver_buckets"."owned_by_user_id" IS NOT NULL AND "cost_insight_owner_hour_driver_buckets"."owned_by_organization_id" IS NULL) OR ("cost_insight_owner_hour_driver_buckets"."owned_by_user_id" IS NULL AND "cost_insight_owner_hour_driver_buckets"."owned_by_organization_id" IS NOT NULL)),
	CONSTRAINT "cost_insight_driver_buckets_hour_check" CHECK ("cost_insight_owner_hour_driver_buckets"."hour_start" = date_trunc('hour', "cost_insight_owner_hour_driver_buckets"."hour_start", 'UTC')),
	CONSTRAINT "cost_insight_driver_buckets_category_check" CHECK ("cost_insight_owner_hour_driver_buckets"."spend_category" IN ('variable', 'scheduled')),
	CONSTRAINT "cost_insight_driver_buckets_source_check" CHECK ("cost_insight_owner_hour_driver_buckets"."source" IN ('ai_gateway', 'kiloclaw', 'coding_plan', 'other')),
	CONSTRAINT "cost_insight_driver_buckets_driver_key_check" CHECK ("cost_insight_owner_hour_driver_buckets"."driver_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cost_insight_driver_buckets_product_key_check" CHECK (char_length("cost_insight_owner_hour_driver_buckets"."product_key") BETWEEN 1 AND 128),
	CONSTRAINT "cost_insight_driver_buckets_feature_key_check" CHECK (char_length("cost_insight_owner_hour_driver_buckets"."feature_key") BETWEEN 1 AND 128),
	CONSTRAINT "cost_insight_driver_buckets_model_key_check" CHECK (char_length("cost_insight_owner_hour_driver_buckets"."model_or_plan_key") BETWEEN 1 AND 128),
	CONSTRAINT "cost_insight_driver_buckets_provider_key_check" CHECK (char_length("cost_insight_owner_hour_driver_buckets"."provider_key") BETWEEN 1 AND 128),
	CONSTRAINT "cost_insight_driver_buckets_amount_positive_check" CHECK ("cost_insight_owner_hour_driver_buckets"."total_microdollars" > 0),
	CONSTRAINT "cost_insight_driver_buckets_amount_safe_check" CHECK ("cost_insight_owner_hour_driver_buckets"."total_microdollars" <= 9007199254740991),
	CONSTRAINT "cost_insight_driver_buckets_count_positive_check" CHECK ("cost_insight_owner_hour_driver_buckets"."spend_record_count" > 0),
	CONSTRAINT "cost_insight_driver_buckets_count_safe_check" CHECK ("cost_insight_owner_hour_driver_buckets"."spend_record_count" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "cost_insight_owner_hour_totals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"hour_start" timestamp with time zone NOT NULL,
	"spend_category" text NOT NULL,
	"total_microdollars" bigint NOT NULL,
	"spend_record_count" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_owner_hour_totals_owner_check" CHECK (("cost_insight_owner_hour_totals"."owned_by_user_id" IS NOT NULL AND "cost_insight_owner_hour_totals"."owned_by_organization_id" IS NULL) OR ("cost_insight_owner_hour_totals"."owned_by_user_id" IS NULL AND "cost_insight_owner_hour_totals"."owned_by_organization_id" IS NOT NULL)),
	CONSTRAINT "cost_insight_owner_hour_totals_hour_check" CHECK ("cost_insight_owner_hour_totals"."hour_start" = date_trunc('hour', "cost_insight_owner_hour_totals"."hour_start", 'UTC')),
	CONSTRAINT "cost_insight_owner_hour_totals_category_check" CHECK ("cost_insight_owner_hour_totals"."spend_category" IN ('variable', 'scheduled')),
	CONSTRAINT "cost_insight_owner_hour_totals_amount_positive_check" CHECK ("cost_insight_owner_hour_totals"."total_microdollars" > 0),
	CONSTRAINT "cost_insight_owner_hour_totals_amount_safe_check" CHECK ("cost_insight_owner_hour_totals"."total_microdollars" <= 9007199254740991),
	CONSTRAINT "cost_insight_owner_hour_totals_count_positive_check" CHECK ("cost_insight_owner_hour_totals"."spend_record_count" > 0),
	CONSTRAINT "cost_insight_owner_hour_totals_count_safe_check" CHECK ("cost_insight_owner_hour_totals"."spend_record_count" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "cost_insight_owner_states" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"last_evaluated_at" timestamp with time zone,
	"active_anomaly_event_id" uuid,
	"active_anomaly_episode_id" uuid,
	"active_anomaly_hour_start" timestamp with time zone,
	"active_anomaly_snapshot" jsonb,
	"active_anomaly_reviewed_at" timestamp with time zone,
	"threshold_crossing_active" boolean DEFAULT false NOT NULL,
	"active_threshold_event_id" uuid,
	"active_threshold_episode_id" uuid,
	"threshold_crossing_started_at" timestamp with time zone,
	"active_threshold_snapshot" jsonb,
	"threshold_reviewed_at" timestamp with time zone,
	"threshold_recovered_at" timestamp with time zone,
	"rolling_7_day_threshold_crossing_active" boolean DEFAULT false NOT NULL,
	"active_rolling_7_day_threshold_event_id" uuid,
	"active_rolling_7_day_threshold_episode_id" uuid,
	"rolling_7_day_threshold_crossing_started_at" timestamp with time zone,
	"active_rolling_7_day_threshold_snapshot" jsonb,
	"rolling_7_day_threshold_reviewed_at" timestamp with time zone,
	"rolling_7_day_threshold_recovered_at" timestamp with time zone,
	"rolling_30_day_threshold_crossing_active" boolean DEFAULT false NOT NULL,
	"active_rolling_30_day_threshold_event_id" uuid,
	"active_rolling_30_day_threshold_episode_id" uuid,
	"rolling_30_day_threshold_crossing_started_at" timestamp with time zone,
	"active_rolling_30_day_threshold_snapshot" jsonb,
	"rolling_30_day_threshold_reviewed_at" timestamp with time zone,
	"rolling_30_day_threshold_recovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_owner_states_owner_check" CHECK (("cost_insight_owner_states"."owned_by_user_id" IS NOT NULL AND "cost_insight_owner_states"."owned_by_organization_id" IS NULL) OR ("cost_insight_owner_states"."owned_by_user_id" IS NULL AND "cost_insight_owner_states"."owned_by_organization_id" IS NOT NULL)),
	CONSTRAINT "cost_insight_owner_states_anomaly_hour_check" CHECK ("cost_insight_owner_states"."active_anomaly_hour_start" IS NULL OR "cost_insight_owner_states"."active_anomaly_hour_start" = date_trunc('hour', "cost_insight_owner_states"."active_anomaly_hour_start", 'UTC')),
	CONSTRAINT "cost_insight_owner_states_threshold_active_check" CHECK ("cost_insight_owner_states"."threshold_crossing_active" = TRUE OR ("cost_insight_owner_states"."active_threshold_event_id" IS NULL AND "cost_insight_owner_states"."active_threshold_episode_id" IS NULL AND "cost_insight_owner_states"."threshold_crossing_started_at" IS NULL AND "cost_insight_owner_states"."active_threshold_snapshot" IS NULL AND "cost_insight_owner_states"."threshold_reviewed_at" IS NULL)),
	CONSTRAINT "cost_insight_owner_states_7_day_threshold_active_check" CHECK ("cost_insight_owner_states"."rolling_7_day_threshold_crossing_active" = TRUE OR ("cost_insight_owner_states"."active_rolling_7_day_threshold_event_id" IS NULL AND "cost_insight_owner_states"."active_rolling_7_day_threshold_episode_id" IS NULL AND "cost_insight_owner_states"."rolling_7_day_threshold_crossing_started_at" IS NULL AND "cost_insight_owner_states"."active_rolling_7_day_threshold_snapshot" IS NULL AND "cost_insight_owner_states"."rolling_7_day_threshold_reviewed_at" IS NULL)),
	CONSTRAINT "cost_insight_owner_states_30_day_threshold_active_check" CHECK ("cost_insight_owner_states"."rolling_30_day_threshold_crossing_active" = TRUE OR ("cost_insight_owner_states"."active_rolling_30_day_threshold_event_id" IS NULL AND "cost_insight_owner_states"."active_rolling_30_day_threshold_episode_id" IS NULL AND "cost_insight_owner_states"."rolling_30_day_threshold_crossing_started_at" IS NULL AND "cost_insight_owner_states"."active_rolling_30_day_threshold_snapshot" IS NULL AND "cost_insight_owner_states"."rolling_30_day_threshold_reviewed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "cost_insight_rollup_coverage" (
	"rollup_version" smallint PRIMARY KEY NOT NULL,
	"live_capture_start_hour" timestamp with time zone,
	"coverage_start_hour" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_rollup_coverage_version_check" CHECK ("cost_insight_rollup_coverage"."rollup_version" > 0),
	CONSTRAINT "cost_insight_rollup_coverage_live_hour_check" CHECK ("cost_insight_rollup_coverage"."live_capture_start_hour" IS NULL OR "cost_insight_rollup_coverage"."live_capture_start_hour" = date_trunc('hour', "cost_insight_rollup_coverage"."live_capture_start_hour", 'UTC')),
	CONSTRAINT "cost_insight_rollup_coverage_start_hour_check" CHECK ("cost_insight_rollup_coverage"."coverage_start_hour" IS NULL OR "cost_insight_rollup_coverage"."coverage_start_hour" = date_trunc('hour', "cost_insight_rollup_coverage"."coverage_start_hour", 'UTC')),
	CONSTRAINT "cost_insight_rollup_coverage_range_check" CHECK ("cost_insight_rollup_coverage"."coverage_start_hour" IS NULL OR ("cost_insight_rollup_coverage"."live_capture_start_hour" IS NOT NULL AND "cost_insight_rollup_coverage"."coverage_start_hour" <= "cost_insight_rollup_coverage"."live_capture_start_hour"))
);
--> statement-breakpoint
CREATE TABLE "cost_insight_rollup_degraded_intervals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"start_hour" timestamp with time zone NOT NULL,
	"end_hour_exclusive" timestamp with time zone NOT NULL,
	"source" text,
	"reason" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_degraded_intervals_start_hour_check" CHECK ("cost_insight_rollup_degraded_intervals"."start_hour" = date_trunc('hour', "cost_insight_rollup_degraded_intervals"."start_hour", 'UTC')),
	CONSTRAINT "cost_insight_degraded_intervals_end_hour_check" CHECK ("cost_insight_rollup_degraded_intervals"."end_hour_exclusive" = date_trunc('hour', "cost_insight_rollup_degraded_intervals"."end_hour_exclusive", 'UTC')),
	CONSTRAINT "cost_insight_degraded_intervals_range_check" CHECK ("cost_insight_rollup_degraded_intervals"."end_hour_exclusive" > "cost_insight_rollup_degraded_intervals"."start_hour"),
	CONSTRAINT "cost_insight_degraded_intervals_resolution_check" CHECK ("cost_insight_rollup_degraded_intervals"."resolved_at" IS NULL OR "cost_insight_rollup_degraded_intervals"."resolved_at" >= "cost_insight_rollup_degraded_intervals"."detected_at"),
	CONSTRAINT "cost_insight_degraded_intervals_source_check" CHECK ("cost_insight_rollup_degraded_intervals"."source" IN ('ai_gateway', 'kiloclaw', 'coding_plan', 'other')),
	CONSTRAINT "cost_insight_degraded_intervals_reason_check" CHECK ("cost_insight_rollup_degraded_intervals"."reason" IN ('capture_bypass', 'reconciliation_mismatch', 'late_source_data'))
);
--> statement-breakpoint
ALTER TABLE "cost_insight_active_suggestions" ADD CONSTRAINT "cost_insight_active_suggestions_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_active_suggestions" ADD CONSTRAINT "cost_insight_active_suggestions_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_active_suggestions" ADD CONSTRAINT "cost_insight_active_suggestions_dismissed_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_insight_evaluation_dirty_owners" ADD CONSTRAINT "cost_insight_evaluation_dirty_owners_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_evaluation_dirty_owners" ADD CONSTRAINT "cost_insight_evaluation_dirty_owners_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_events" ADD CONSTRAINT "cost_insight_events_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_events" ADD CONSTRAINT "cost_insight_events_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_events" ADD CONSTRAINT "cost_insight_events_active_suggestion_id_cost_insight_active_suggestions_id_fk" FOREIGN KEY ("active_suggestion_id") REFERENCES "public"."cost_insight_active_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_insight_events" ADD CONSTRAINT "cost_insight_events_actor_user_id_kilocode_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_insight_notification_deliveries" ADD CONSTRAINT "cost_insight_notification_deliveries_event_id_cost_insight_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."cost_insight_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_insight_notification_deliveries" ADD CONSTRAINT "cost_insight_notification_deliveries_recipient_user_id_kilocode_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_configs" ADD CONSTRAINT "cost_insight_owner_configs_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_configs" ADD CONSTRAINT "cost_insight_owner_configs_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_hour_driver_buckets" ADD CONSTRAINT "cost_insight_owner_hour_driver_buckets_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_hour_driver_buckets" ADD CONSTRAINT "cost_insight_owner_hour_driver_buckets_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_hour_driver_buckets" ADD CONSTRAINT "cost_insight_owner_hour_driver_buckets_actor_user_id_kilocode_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_hour_totals" ADD CONSTRAINT "cost_insight_owner_hour_totals_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_hour_totals" ADD CONSTRAINT "cost_insight_owner_hour_totals_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_states" ADD CONSTRAINT "cost_insight_owner_states_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_states" ADD CONSTRAINT "cost_insight_owner_states_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_states" ADD CONSTRAINT "cost_insight_owner_states_active_anomaly_event_id_cost_insight_events_id_fk" FOREIGN KEY ("active_anomaly_event_id") REFERENCES "public"."cost_insight_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_states" ADD CONSTRAINT "cost_insight_owner_states_active_threshold_event_id_cost_insight_events_id_fk" FOREIGN KEY ("active_threshold_event_id") REFERENCES "public"."cost_insight_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_states" ADD CONSTRAINT "cost_insight_owner_states_active_rolling_7_day_threshold_event_id_cost_insight_events_id_fk" FOREIGN KEY ("active_rolling_7_day_threshold_event_id") REFERENCES "public"."cost_insight_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_insight_owner_states" ADD CONSTRAINT "cost_insight_owner_states_active_rolling_30_day_threshold_event_id_cost_insight_events_id_fk" FOREIGN KEY ("active_rolling_30_day_threshold_event_id") REFERENCES "public"."cost_insight_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_active_suggestions_user_key" ON "cost_insight_active_suggestions" USING btree ("owned_by_user_id","suggestion_key") WHERE "cost_insight_active_suggestions"."owned_by_organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_active_suggestions_org_key" ON "cost_insight_active_suggestions" USING btree ("owned_by_organization_id","suggestion_key") WHERE "cost_insight_active_suggestions"."owned_by_user_id" is null;--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_active_suggestions_user_active" ON "cost_insight_active_suggestions" USING btree ("owned_by_user_id","created_at" DESC NULLS LAST) WHERE "cost_insight_active_suggestions"."owned_by_user_id" IS NOT NULL AND "cost_insight_active_suggestions"."dismissed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_active_suggestions_org_active" ON "cost_insight_active_suggestions" USING btree ("owned_by_organization_id","created_at" DESC NULLS LAST) WHERE "cost_insight_active_suggestions"."owned_by_organization_id" IS NOT NULL AND "cost_insight_active_suggestions"."dismissed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_evaluation_dirty_owners_user" ON "cost_insight_evaluation_dirty_owners" USING btree ("owned_by_user_id") WHERE "cost_insight_evaluation_dirty_owners"."owned_by_organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_evaluation_dirty_owners_org" ON "cost_insight_evaluation_dirty_owners" USING btree ("owned_by_organization_id") WHERE "cost_insight_evaluation_dirty_owners"."owned_by_user_id" is null;--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_evaluation_dirty_owners_claim" ON "cost_insight_evaluation_dirty_owners" USING btree ("next_attempt_at","claimed_at","dirty_at","id");--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_events_user_occurred" ON "cost_insight_events" USING btree ("owned_by_user_id","occurred_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_events_org_occurred" ON "cost_insight_events" USING btree ("owned_by_organization_id","occurred_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_events_occurred" ON "cost_insight_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_events_user_dedupe" ON "cost_insight_events" USING btree ("owned_by_user_id","dedupe_key") WHERE "cost_insight_events"."owned_by_user_id" IS NOT NULL AND "cost_insight_events"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_events_org_dedupe" ON "cost_insight_events" USING btree ("owned_by_organization_id","dedupe_key") WHERE "cost_insight_events"."owned_by_organization_id" IS NOT NULL AND "cost_insight_events"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_notification_deliveries_event_recipient_channel" ON "cost_insight_notification_deliveries" USING btree ("event_id","recipient_user_id","channel");--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_notification_deliveries_claim" ON "cost_insight_notification_deliveries" USING btree ("status","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_notification_deliveries_event" ON "cost_insight_notification_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_owner_configs_user" ON "cost_insight_owner_configs" USING btree ("owned_by_user_id") WHERE "cost_insight_owner_configs"."owned_by_organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_owner_configs_org" ON "cost_insight_owner_configs" USING btree ("owned_by_organization_id") WHERE "cost_insight_owner_configs"."owned_by_user_id" is null;--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_owner_configs_evaluation" ON "cost_insight_owner_configs" USING btree ("updated_at","id") WHERE "cost_insight_owner_configs"."spend_alerts_enabled" = TRUE OR "cost_insight_owner_configs"."cost_suggestions_enabled" = TRUE;--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_owner_configs_user_active" ON "cost_insight_owner_configs" USING btree ("owned_by_user_id") WHERE "cost_insight_owner_configs"."owned_by_user_id" IS NOT NULL AND ("cost_insight_owner_configs"."spend_alerts_enabled" = TRUE OR "cost_insight_owner_configs"."cost_suggestions_enabled" = TRUE);--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_owner_configs_org_active" ON "cost_insight_owner_configs" USING btree ("owned_by_organization_id") WHERE "cost_insight_owner_configs"."owned_by_organization_id" IS NOT NULL AND ("cost_insight_owner_configs"."spend_alerts_enabled" = TRUE OR "cost_insight_owner_configs"."cost_suggestions_enabled" = TRUE);--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_driver_buckets_user" ON "cost_insight_owner_hour_driver_buckets" USING btree ("owned_by_user_id","hour_start","spend_category","driver_key") WHERE "cost_insight_owner_hour_driver_buckets"."owned_by_organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_driver_buckets_org" ON "cost_insight_owner_hour_driver_buckets" USING btree ("owned_by_organization_id","hour_start","spend_category","driver_key") WHERE "cost_insight_owner_hour_driver_buckets"."owned_by_user_id" is null;--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_driver_buckets_hour" ON "cost_insight_owner_hour_driver_buckets" USING btree ("hour_start");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_owner_hour_totals_user" ON "cost_insight_owner_hour_totals" USING btree ("owned_by_user_id","hour_start","spend_category") WHERE "cost_insight_owner_hour_totals"."owned_by_organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_owner_hour_totals_org" ON "cost_insight_owner_hour_totals" USING btree ("owned_by_organization_id","hour_start","spend_category") WHERE "cost_insight_owner_hour_totals"."owned_by_user_id" is null;--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_owner_hour_totals_hour" ON "cost_insight_owner_hour_totals" USING btree ("hour_start");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_owner_states_user" ON "cost_insight_owner_states" USING btree ("owned_by_user_id") WHERE "cost_insight_owner_states"."owned_by_organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cost_insight_owner_states_org" ON "cost_insight_owner_states" USING btree ("owned_by_organization_id") WHERE "cost_insight_owner_states"."owned_by_user_id" is null;--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_owner_states_unreviewed_user" ON "cost_insight_owner_states" USING btree ("owned_by_user_id","updated_at") WHERE "cost_insight_owner_states"."owned_by_user_id" IS NOT NULL AND (("cost_insight_owner_states"."active_anomaly_episode_id" IS NOT NULL AND "cost_insight_owner_states"."active_anomaly_reviewed_at" IS NULL) OR ("cost_insight_owner_states"."active_threshold_episode_id" IS NOT NULL AND "cost_insight_owner_states"."threshold_reviewed_at" IS NULL) OR ("cost_insight_owner_states"."active_rolling_7_day_threshold_episode_id" IS NOT NULL AND "cost_insight_owner_states"."rolling_7_day_threshold_reviewed_at" IS NULL) OR ("cost_insight_owner_states"."active_rolling_30_day_threshold_episode_id" IS NOT NULL AND "cost_insight_owner_states"."rolling_30_day_threshold_reviewed_at" IS NULL));--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_owner_states_unreviewed_org" ON "cost_insight_owner_states" USING btree ("owned_by_organization_id","updated_at") WHERE "cost_insight_owner_states"."owned_by_organization_id" IS NOT NULL AND (("cost_insight_owner_states"."active_anomaly_episode_id" IS NOT NULL AND "cost_insight_owner_states"."active_anomaly_reviewed_at" IS NULL) OR ("cost_insight_owner_states"."active_threshold_episode_id" IS NOT NULL AND "cost_insight_owner_states"."threshold_reviewed_at" IS NULL) OR ("cost_insight_owner_states"."active_rolling_7_day_threshold_episode_id" IS NOT NULL AND "cost_insight_owner_states"."rolling_7_day_threshold_reviewed_at" IS NULL) OR ("cost_insight_owner_states"."active_rolling_30_day_threshold_episode_id" IS NOT NULL AND "cost_insight_owner_states"."rolling_30_day_threshold_reviewed_at" IS NULL));--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_degraded_intervals_unresolved" ON "cost_insight_rollup_degraded_intervals" USING btree ("start_hour","end_hour_exclusive") WHERE "cost_insight_rollup_degraded_intervals"."resolved_at" is null;