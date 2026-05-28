CREATE TABLE "stripe_early_fraud_warning_actions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"target_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"result_code" text,
	"result_reference_id" text,
	"failure_context" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_stripe_early_fraud_warning_actions_case_type_target" UNIQUE("case_id","action_type","target_key"),
	CONSTRAINT "stripe_early_fraud_warning_actions_action_type_check" CHECK ("stripe_early_fraud_warning_actions"."action_type" IN ('containment', 'refund', 'payment_value_clawback', 'subscription_termination', 'access_termination', 'kiloclaw_suspension', 'affiliate_payout_reversal', 'referral_reward_reversal', 'user_notice')),
	CONSTRAINT "stripe_early_fraud_warning_actions_status_check" CHECK ("stripe_early_fraud_warning_actions"."status" IN ('queued', 'processing', 'completed', 'failed', 'review_required', 'dismissed')),
	CONSTRAINT "stripe_early_fraud_warning_actions_attempt_count_non_negative_check" CHECK ("stripe_early_fraud_warning_actions"."attempt_count" >= 0),
	CONSTRAINT "stripe_early_fraud_warning_actions_target_key_not_empty_check" CHECK (length("stripe_early_fraud_warning_actions"."target_key") > 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_early_fraud_warning_cases" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"stripe_early_fraud_warning_id" text NOT NULL,
	"stripe_event_id" text NOT NULL,
	"stripe_charge_id" text,
	"stripe_payment_intent_id" text,
	"stripe_customer_id" text,
	"amount_minor_units" integer,
	"currency" text,
	"owner_classification" text NOT NULL,
	"kilo_user_id" text,
	"organization_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"failure_context" text,
	"warning_created_at" timestamp with time zone,
	"contained_at" timestamp with time zone,
	"processing_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"review_required_at" timestamp with time zone,
	"remediated_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_stripe_early_fraud_warning_cases_warning_id" UNIQUE("stripe_early_fraud_warning_id"),
	CONSTRAINT "stripe_early_fraud_warning_cases_owner_classification_check" CHECK ("stripe_early_fraud_warning_cases"."owner_classification" IN ('personal', 'organization', 'ambiguous', 'unmatched')),
	CONSTRAINT "stripe_early_fraud_warning_cases_status_check" CHECK ("stripe_early_fraud_warning_cases"."status" IN ('queued', 'contained', 'processing', 'completed', 'review_required', 'failed', 'remediated', 'dismissed')),
	CONSTRAINT "stripe_early_fraud_warning_cases_amount_minor_units_non_negative_check" CHECK ("stripe_early_fraud_warning_cases"."amount_minor_units" IS NULL OR "stripe_early_fraud_warning_cases"."amount_minor_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "stripe_early_fraud_warning_actions" ADD CONSTRAINT "stripe_early_fraud_warning_actions_case_id_stripe_early_fraud_warning_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."stripe_early_fraud_warning_cases"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stripe_early_fraud_warning_cases" ADD CONSTRAINT "stripe_early_fraud_warning_cases_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stripe_early_fraud_warning_cases" ADD CONSTRAINT "stripe_early_fraud_warning_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "IDX_stripe_early_fraud_warning_actions_case_id" ON "stripe_early_fraud_warning_actions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_early_fraud_warning_actions_claim_path" ON "stripe_early_fraud_warning_actions" USING btree ("status",coalesce("next_retry_at", '-infinity'::timestamptz),"created_at","id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_early_fraud_warning_cases_event_id" ON "stripe_early_fraud_warning_cases" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_early_fraud_warning_cases_charge_id" ON "stripe_early_fraud_warning_cases" USING btree ("stripe_charge_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_early_fraud_warning_cases_payment_intent_id" ON "stripe_early_fraud_warning_cases" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_early_fraud_warning_cases_customer_id" ON "stripe_early_fraud_warning_cases" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_early_fraud_warning_cases_kilo_user_id" ON "stripe_early_fraud_warning_cases" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_early_fraud_warning_cases_organization_id" ON "stripe_early_fraud_warning_cases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_early_fraud_warning_cases_status_created_at" ON "stripe_early_fraud_warning_cases" USING btree ("status","created_at");