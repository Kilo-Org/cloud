CREATE TABLE "stripe_dispute_actions" (
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
	CONSTRAINT "UQ_stripe_dispute_actions_case_type_target" UNIQUE("case_id","action_type","target_key"),
	CONSTRAINT "stripe_dispute_actions_action_type_check" CHECK ("stripe_dispute_actions"."action_type" IN ('stripe_acceptance', 'user_block', 'auto_top_up_disable', 'credit_balance_reset', 'subscription_cancellation', 'access_termination', 'kiloclaw_suspension')),
	CONSTRAINT "stripe_dispute_actions_status_check" CHECK ("stripe_dispute_actions"."status" IN ('queued', 'processing', 'completed', 'failed', 'skipped')),
	CONSTRAINT "stripe_dispute_actions_attempt_count_non_negative_check" CHECK ("stripe_dispute_actions"."attempt_count" >= 0),
	CONSTRAINT "stripe_dispute_actions_target_key_not_empty_check" CHECK (length("stripe_dispute_actions"."target_key") > 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_dispute_cases" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"stripe_dispute_id" text NOT NULL,
	"stripe_event_id" text,
	"stripe_event_created_at" timestamp with time zone,
	"stripe_charge_id" text,
	"stripe_payment_intent_id" text,
	"stripe_customer_id" text,
	"amount_minor_units" integer,
	"currency" text,
	"dispute_reason" text,
	"stripe_status" text,
	"owner_classification" text NOT NULL,
	"kilo_user_id" text,
	"organization_id" uuid,
	"status" text DEFAULT 'needs_action' NOT NULL,
	"status_reason" text,
	"failure_context" text,
	"stripe_created_at" timestamp with time zone,
	"evidence_due_by" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"accepted_by_kilo_user_id" text,
	"acceptance_started_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"enforcement_completed_at" timestamp with time zone,
	"review_required_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_stripe_dispute_cases_dispute_id" UNIQUE("stripe_dispute_id"),
	CONSTRAINT "stripe_dispute_cases_owner_classification_check" CHECK ("stripe_dispute_cases"."owner_classification" IN ('personal', 'organization', 'ambiguous', 'unmatched')),
	CONSTRAINT "stripe_dispute_cases_status_check" CHECK ("stripe_dispute_cases"."status" IN ('needs_action', 'processing', 'accepted', 'acceptance_failed', 'enforcement_failed', 'review_required', 'closed')),
	CONSTRAINT "stripe_dispute_cases_amount_minor_units_non_negative_check" CHECK ("stripe_dispute_cases"."amount_minor_units" IS NULL OR "stripe_dispute_cases"."amount_minor_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "stripe_dispute_actions" ADD CONSTRAINT "stripe_dispute_actions_case_id_stripe_dispute_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."stripe_dispute_cases"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stripe_dispute_cases" ADD CONSTRAINT "stripe_dispute_cases_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stripe_dispute_cases" ADD CONSTRAINT "stripe_dispute_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stripe_dispute_cases" ADD CONSTRAINT "stripe_dispute_cases_accepted_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("accepted_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "IDX_stripe_dispute_actions_case_id" ON "stripe_dispute_actions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_dispute_actions_claim_path" ON "stripe_dispute_actions" USING btree ("status",coalesce("next_retry_at", '-infinity'::timestamptz),"created_at","id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_dispute_cases_event_id" ON "stripe_dispute_cases" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_dispute_cases_charge_id" ON "stripe_dispute_cases" USING btree ("stripe_charge_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_dispute_cases_payment_intent_id" ON "stripe_dispute_cases" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_dispute_cases_customer_id" ON "stripe_dispute_cases" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_dispute_cases_kilo_user_id" ON "stripe_dispute_cases" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_dispute_cases_organization_id" ON "stripe_dispute_cases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_stripe_dispute_cases_status_due_by" ON "stripe_dispute_cases" USING btree ("status","evidence_due_by","stripe_created_at");