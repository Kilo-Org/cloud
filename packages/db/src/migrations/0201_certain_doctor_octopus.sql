CREATE TABLE "kilo_pass_org_agreements" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"parent_organization_id" uuid NOT NULL,
	"term_version_id" uuid NOT NULL,
	"state" text NOT NULL,
	"processing_condition" text DEFAULT 'ready' NOT NULL,
	"purchase_channel" text NOT NULL,
	"cadence" text NOT NULL,
	"purchased_pass_capacity" integer NOT NULL,
	"next_purchased_pass_capacity" integer,
	"next_capacity_effective_at" timestamp with time zone,
	"paid_from" timestamp with time zone,
	"paid_until" timestamp with time zone,
	"issuance_anchor_at" timestamp with time zone NOT NULL,
	"provider_subscription_id" text,
	"provider_seat_add_on_item_id" text,
	"activation_provider_event_id" text,
	"external_contract_id" text,
	"payment_review_required_at" timestamp with time zone,
	"cancellation_effective_at" timestamp with time zone,
	"manually_issued_through" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilo_pass_org_agreements_purchased_capacity_non_negative_check" CHECK ("kilo_pass_org_agreements"."purchased_pass_capacity" >= 0),
	CONSTRAINT "kilo_pass_org_agreements_next_capacity_check" CHECK (("kilo_pass_org_agreements"."next_purchased_pass_capacity" IS NULL AND "kilo_pass_org_agreements"."next_capacity_effective_at" IS NULL) OR ("kilo_pass_org_agreements"."next_purchased_pass_capacity" >= 0 AND "kilo_pass_org_agreements"."next_capacity_effective_at" IS NOT NULL)),
	CONSTRAINT "kilo_pass_org_agreements_paid_interval_check" CHECK (("kilo_pass_org_agreements"."paid_from" IS NULL AND "kilo_pass_org_agreements"."paid_until" IS NULL) OR ("kilo_pass_org_agreements"."paid_from" IS NOT NULL AND "kilo_pass_org_agreements"."paid_until" IS NOT NULL AND "kilo_pass_org_agreements"."paid_from" < "kilo_pass_org_agreements"."paid_until")),
	CONSTRAINT "kilo_pass_org_agreements_state_check" CHECK ("kilo_pass_org_agreements"."state" IN ('pending_payment', 'active', 'cancel_at_period_end', 'ended')),
	CONSTRAINT "kilo_pass_org_agreements_processing_condition_check" CHECK ("kilo_pass_org_agreements"."processing_condition" IN ('ready', 'manual', 'blocked', 'overallocated', 'failed', 'suspended_for_review')),
	CONSTRAINT "kilo_pass_org_agreements_purchase_channel_check" CHECK ("kilo_pass_org_agreements"."purchase_channel" IN ('self_serve', 'manual')),
	CONSTRAINT "kilo_pass_org_agreements_cadence_check" CHECK ("kilo_pass_org_agreements"."cadence" IN ('monthly', 'yearly'))
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_allocation_plan_rows" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"allocation_plan_id" uuid NOT NULL,
	"allocation_container_organization_id" uuid NOT NULL,
	"pass_capacity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_allocation_plan_rows_plan_container" UNIQUE("allocation_plan_id","allocation_container_organization_id"),
	CONSTRAINT "kilo_pass_org_allocation_plan_rows_capacity_non_negative_check" CHECK ("kilo_pass_org_allocation_plan_rows"."pass_capacity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_allocation_plans" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"effective_window_start" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"created_by_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_allocation_plans_agreement_window" UNIQUE("agreement_id","effective_window_start"),
	CONSTRAINT "UQ_kilo_pass_org_allocation_plans_agreement_version" UNIQUE("agreement_id","version"),
	CONSTRAINT "kilo_pass_org_allocation_plans_version_positive_check" CHECK ("kilo_pass_org_allocation_plans"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_audit_records" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"agreement_id" uuid,
	"actor_kilo_user_id" text,
	"action" text NOT NULL,
	"reason" text,
	"before_json" jsonb,
	"after_json" jsonb,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_issuance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"processing_run_id" uuid,
	"allocation_plan_id" uuid,
	"term_version_id" uuid NOT NULL,
	"allocation_container_organization_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"qualifying_spend_starts_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"tranche_key" text NOT NULL,
	"allocated_pass_capacity" integer NOT NULL,
	"base_credit_microdollars" bigint NOT NULL,
	"bonus_credit_microdollars" bigint NOT NULL,
	"unlock_spend_microdollars" bigint NOT NULL,
	"qualifying_spend_microdollars" bigint DEFAULT 0 NOT NULL,
	"bonus_mode" text NOT NULL,
	"bonus_unlocked_at" timestamp with time zone,
	"repair_completed_at" timestamp with time zone,
	"bonus_credit_transaction_id" uuid,
	"base_credit_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_issuance_snapshots_container_window_tranche" UNIQUE("agreement_id","allocation_container_organization_id","window_start","tranche_key"),
	CONSTRAINT "kilo_pass_org_issuance_snapshots_window_check" CHECK ("kilo_pass_org_issuance_snapshots"."window_start" < "kilo_pass_org_issuance_snapshots"."window_end"),
	CONSTRAINT "kilo_pass_org_issuance_snapshots_qualifying_spend_window_check" CHECK ("kilo_pass_org_issuance_snapshots"."window_start" <= "kilo_pass_org_issuance_snapshots"."qualifying_spend_starts_at" AND "kilo_pass_org_issuance_snapshots"."qualifying_spend_starts_at" < "kilo_pass_org_issuance_snapshots"."window_end"),
	CONSTRAINT "kilo_pass_org_issuance_snapshots_values_non_negative_check" CHECK ("kilo_pass_org_issuance_snapshots"."allocated_pass_capacity" >= 0 AND "kilo_pass_org_issuance_snapshots"."base_credit_microdollars" >= 0 AND "kilo_pass_org_issuance_snapshots"."bonus_credit_microdollars" >= 0 AND "kilo_pass_org_issuance_snapshots"."unlock_spend_microdollars" >= 0 AND "kilo_pass_org_issuance_snapshots"."qualifying_spend_microdollars" >= 0),
	CONSTRAINT "kilo_pass_org_issuance_snapshots_kind_check" CHECK ("kilo_pass_org_issuance_snapshots"."kind" IN ('regular', 'bridge', 'supplement')),
	CONSTRAINT "kilo_pass_org_issuance_snapshots_bonus_mode_check" CHECK ("kilo_pass_org_issuance_snapshots"."bonus_mode" IN ('after_base', 'upfront'))
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"processing_run_id" uuid NOT NULL,
	"recipient_kilo_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_notification_deliveries_run_recipient" UNIQUE("processing_run_id","recipient_kilo_user_id"),
	CONSTRAINT "kilo_pass_org_notification_deliveries_status_check" CHECK ("kilo_pass_org_notification_deliveries"."status" IN ('pending', 'sending', 'sent', 'failed')),
	CONSTRAINT "kilo_pass_org_notification_deliveries_attempt_count_check" CHECK ("kilo_pass_org_notification_deliveries"."attempt_count" >= 0),
	CONSTRAINT "kilo_pass_org_notification_deliveries_sent_check" CHECK (("kilo_pass_org_notification_deliveries"."status" = 'sent' AND "kilo_pass_org_notification_deliveries"."sent_at" IS NOT NULL AND "kilo_pass_org_notification_deliveries"."lease_expires_at" IS NULL) OR ("kilo_pass_org_notification_deliveries"."status" = 'sending' AND "kilo_pass_org_notification_deliveries"."sent_at" IS NULL AND "kilo_pass_org_notification_deliveries"."lease_expires_at" IS NOT NULL) OR ("kilo_pass_org_notification_deliveries"."status" IN ('pending', 'failed') AND "kilo_pass_org_notification_deliveries"."sent_at" IS NULL AND "kilo_pass_org_notification_deliveries"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_processing_runs" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_processing_runs_agreement_window" UNIQUE("agreement_id","window_start"),
	CONSTRAINT "UQ_kilo_pass_org_processing_runs_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "kilo_pass_org_processing_runs_window_check" CHECK ("kilo_pass_org_processing_runs"."window_start" < "kilo_pass_org_processing_runs"."window_end"),
	CONSTRAINT "kilo_pass_org_processing_runs_attempt_count_non_negative_check" CHECK ("kilo_pass_org_processing_runs"."attempt_count" >= 0),
	CONSTRAINT "kilo_pass_org_processing_runs_state_check" CHECK ("kilo_pass_org_processing_runs"."state" IN ('pending', 'running', 'succeeded', 'blocked', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_qualifying_spend_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"issuance_snapshot_id" uuid NOT NULL,
	"allocation_container_organization_id" uuid NOT NULL,
	"credit_transaction_id" uuid NOT NULL,
	"spent_microdollars" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_qualifying_spend_events_snapshot_credit_transaction" UNIQUE("issuance_snapshot_id","credit_transaction_id"),
	CONSTRAINT "kilo_pass_org_qualifying_spend_events_amount_positive_check" CHECK ("kilo_pass_org_qualifying_spend_events"."spent_microdollars" > 0)
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_supplements" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"issuance_snapshot_id" uuid NOT NULL,
	"provider_invoice_line_id" text NOT NULL,
	"remaining_service_numerator" bigint NOT NULL,
	"remaining_service_denominator" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_supplements_provider_invoice_line" UNIQUE("provider_invoice_line_id"),
	CONSTRAINT "kilo_pass_org_supplements_ratio_check" CHECK ("kilo_pass_org_supplements"."remaining_service_numerator" > 0 AND "kilo_pass_org_supplements"."remaining_service_denominator" > 0 AND "kilo_pass_org_supplements"."remaining_service_numerator" <= "kilo_pass_org_supplements"."remaining_service_denominator")
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_term_transitions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"from_term_version_id" uuid NOT NULL,
	"to_term_version_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_by_kilo_user_id" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_term_transitions_agreement_effective" UNIQUE("agreement_id","effective_at"),
	CONSTRAINT "kilo_pass_org_term_transitions_changes_version_check" CHECK ("kilo_pass_org_term_transitions"."from_term_version_id" <> "kilo_pass_org_term_transitions"."to_term_version_id")
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_org_term_versions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"version_key" text NOT NULL,
	"tier" text NOT NULL,
	"cadence" text NOT NULL,
	"billing_price_microdollars_per_pass" bigint NOT NULL,
	"base_credit_microdollars_per_pass" bigint NOT NULL,
	"bonus_credit_microdollars_per_pass" bigint NOT NULL,
	"unlock_spend_microdollars_per_pass" bigint NOT NULL,
	"bonus_mode" text NOT NULL,
	"created_by_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_term_versions_version_key" UNIQUE("version_key"),
	CONSTRAINT "kilo_pass_org_term_versions_amounts_non_negative_check" CHECK ("kilo_pass_org_term_versions"."billing_price_microdollars_per_pass" >= 0 AND "kilo_pass_org_term_versions"."base_credit_microdollars_per_pass" >= 0 AND "kilo_pass_org_term_versions"."bonus_credit_microdollars_per_pass" >= 0 AND "kilo_pass_org_term_versions"."unlock_spend_microdollars_per_pass" >= 0),
	CONSTRAINT "kilo_pass_org_term_versions_tier_check" CHECK ("kilo_pass_org_term_versions"."tier" IN ('tier_19', 'tier_49', 'tier_199')),
	CONSTRAINT "kilo_pass_org_term_versions_cadence_check" CHECK ("kilo_pass_org_term_versions"."cadence" IN ('monthly', 'yearly')),
	CONSTRAINT "kilo_pass_org_term_versions_bonus_mode_check" CHECK ("kilo_pass_org_term_versions"."bonus_mode" IN ('after_base', 'upfront'))
);
--> statement-breakpoint
ALTER TABLE "kilo_pass_org_agreements" ADD CONSTRAINT "kilo_pass_org_agreements_parent_organization_id_organizations_id_fk" FOREIGN KEY ("parent_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_agreements" ADD CONSTRAINT "kilo_pass_org_agreements_term_version_id_kilo_pass_org_term_versions_id_fk" FOREIGN KEY ("term_version_id") REFERENCES "public"."kilo_pass_org_term_versions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_allocation_plan_rows" ADD CONSTRAINT "kilo_pass_org_allocation_plan_rows_allocation_plan_id_kilo_pass_org_allocation_plans_id_fk" FOREIGN KEY ("allocation_plan_id") REFERENCES "public"."kilo_pass_org_allocation_plans"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_allocation_plan_rows" ADD CONSTRAINT "kilo_pass_org_allocation_plan_rows_allocation_container_organization_id_organizations_id_fk" FOREIGN KEY ("allocation_container_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_allocation_plans" ADD CONSTRAINT "kilo_pass_org_allocation_plans_agreement_id_kilo_pass_org_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."kilo_pass_org_agreements"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_allocation_plans" ADD CONSTRAINT "kilo_pass_org_allocation_plans_created_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("created_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_audit_records" ADD CONSTRAINT "kilo_pass_org_audit_records_agreement_id_kilo_pass_org_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."kilo_pass_org_agreements"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_audit_records" ADD CONSTRAINT "kilo_pass_org_audit_records_actor_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("actor_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_issuance_snapshots" ADD CONSTRAINT "kilo_pass_org_issuance_snapshots_agreement_id_kilo_pass_org_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."kilo_pass_org_agreements"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_issuance_snapshots" ADD CONSTRAINT "kilo_pass_org_issuance_snapshots_processing_run_id_kilo_pass_org_processing_runs_id_fk" FOREIGN KEY ("processing_run_id") REFERENCES "public"."kilo_pass_org_processing_runs"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_issuance_snapshots" ADD CONSTRAINT "kilo_pass_org_issuance_snapshots_allocation_plan_id_kilo_pass_org_allocation_plans_id_fk" FOREIGN KEY ("allocation_plan_id") REFERENCES "public"."kilo_pass_org_allocation_plans"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_issuance_snapshots" ADD CONSTRAINT "kilo_pass_org_issuance_snapshots_term_version_id_kilo_pass_org_term_versions_id_fk" FOREIGN KEY ("term_version_id") REFERENCES "public"."kilo_pass_org_term_versions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_issuance_snapshots" ADD CONSTRAINT "kilo_pass_org_issuance_snapshots_allocation_container_organization_id_organizations_id_fk" FOREIGN KEY ("allocation_container_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_issuance_snapshots" ADD CONSTRAINT "kilo_pass_org_issuance_snapshots_bonus_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("bonus_credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_issuance_snapshots" ADD CONSTRAINT "kilo_pass_org_issuance_snapshots_base_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("base_credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_notification_deliveries" ADD CONSTRAINT "kilo_pass_org_notification_deliveries_processing_run_id_kilo_pass_org_processing_runs_id_fk" FOREIGN KEY ("processing_run_id") REFERENCES "public"."kilo_pass_org_processing_runs"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_notification_deliveries" ADD CONSTRAINT "kilo_pass_org_notification_deliveries_recipient_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("recipient_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_processing_runs" ADD CONSTRAINT "kilo_pass_org_processing_runs_agreement_id_kilo_pass_org_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."kilo_pass_org_agreements"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_qualifying_spend_events" ADD CONSTRAINT "kilo_pass_org_qualifying_spend_events_issuance_snapshot_id_kilo_pass_org_issuance_snapshots_id_fk" FOREIGN KEY ("issuance_snapshot_id") REFERENCES "public"."kilo_pass_org_issuance_snapshots"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_qualifying_spend_events" ADD CONSTRAINT "kilo_pass_org_qualifying_spend_events_allocation_container_organization_id_organizations_id_fk" FOREIGN KEY ("allocation_container_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_qualifying_spend_events" ADD CONSTRAINT "kilo_pass_org_qualifying_spend_events_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_supplements" ADD CONSTRAINT "kilo_pass_org_supplements_issuance_snapshot_id_kilo_pass_org_issuance_snapshots_id_fk" FOREIGN KEY ("issuance_snapshot_id") REFERENCES "public"."kilo_pass_org_issuance_snapshots"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_term_transitions" ADD CONSTRAINT "kilo_pass_org_term_transitions_agreement_id_kilo_pass_org_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."kilo_pass_org_agreements"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_term_transitions" ADD CONSTRAINT "kilo_pass_org_term_transitions_from_term_version_id_kilo_pass_org_term_versions_id_fk" FOREIGN KEY ("from_term_version_id") REFERENCES "public"."kilo_pass_org_term_versions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_term_transitions" ADD CONSTRAINT "kilo_pass_org_term_transitions_to_term_version_id_kilo_pass_org_term_versions_id_fk" FOREIGN KEY ("to_term_version_id") REFERENCES "public"."kilo_pass_org_term_versions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_term_transitions" ADD CONSTRAINT "kilo_pass_org_term_transitions_created_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("created_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_term_versions" ADD CONSTRAINT "kilo_pass_org_term_versions_created_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("created_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_org_agreements_one_non_ended_parent" ON "kilo_pass_org_agreements" USING btree ("parent_organization_id") WHERE "kilo_pass_org_agreements"."state" <> 'ended';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_org_agreements_provider_subscription" ON "kilo_pass_org_agreements" USING btree ("provider_subscription_id") WHERE "kilo_pass_org_agreements"."provider_subscription_id" IS NOT NULL AND "kilo_pass_org_agreements"."state" <> 'ended';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_org_agreements_provider_seat_add_on_item" ON "kilo_pass_org_agreements" USING btree ("provider_seat_add_on_item_id") WHERE "kilo_pass_org_agreements"."provider_seat_add_on_item_id" IS NOT NULL AND "kilo_pass_org_agreements"."state" <> 'ended';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_org_agreements_external_contract" ON "kilo_pass_org_agreements" USING btree ("external_contract_id") WHERE "kilo_pass_org_agreements"."external_contract_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_org_agreements_activation_provider_event" ON "kilo_pass_org_agreements" USING btree ("activation_provider_event_id") WHERE "kilo_pass_org_agreements"."activation_provider_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_org_agreements_processing" ON "kilo_pass_org_agreements" USING btree ("processing_condition");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_org_audit_records_idempotency" ON "kilo_pass_org_audit_records" USING btree ("idempotency_key") WHERE "kilo_pass_org_audit_records"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_org_audit_records_agreement_created" ON "kilo_pass_org_audit_records" USING btree ("agreement_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_org_issuance_snapshots_base_credit_transaction" ON "kilo_pass_org_issuance_snapshots" USING btree ("base_credit_transaction_id") WHERE "kilo_pass_org_issuance_snapshots"."base_credit_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_org_issuance_snapshots_bonus_credit_transaction" ON "kilo_pass_org_issuance_snapshots" USING btree ("bonus_credit_transaction_id") WHERE "kilo_pass_org_issuance_snapshots"."bonus_credit_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_org_issuance_snapshots_window" ON "kilo_pass_org_issuance_snapshots" USING btree ("agreement_id","window_start");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_org_notification_deliveries_status" ON "kilo_pass_org_notification_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_org_processing_runs_state_lease" ON "kilo_pass_org_processing_runs" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_org_qualifying_spend_events_snapshot_occurred" ON "kilo_pass_org_qualifying_spend_events" USING btree ("issuance_snapshot_id","occurred_at");