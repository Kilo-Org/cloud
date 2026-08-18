CREATE TABLE "user_deletion_activity" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"step_key" text,
	"event_type" text NOT NULL,
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_deletion_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"event_type" text NOT NULL,
	"actor_kilo_user_id" text,
	"target_email_hmac" text NOT NULL,
	"subject_key" text NOT NULL,
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_deletion_audit_events_event_type_check" CHECK ("user_deletion_audit_events"."event_type" IN ('request_created', 'intake_refused', 'access_disabled', 'access_absent', 'preflight_disposition', 'task_disposition', 'manual_retry', 'manual_action', 'anonymized', 'deletion_ready_for_customer_reply', 'cancelled', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "user_deletion_provider_credentials" (
	"provider_scope" text PRIMARY KEY NOT NULL,
	"encrypted_material" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_kilo_user_id" text,
	CONSTRAINT "user_deletion_provider_credentials_scope_check" CHECK ("user_deletion_provider_credentials"."provider_scope" IN ('kiloclaw', 'customerio', 'cloud_storage', 'session_ingest', 'posthog', 'substack', 'pylon'))
);
--> statement-breakpoint
CREATE TABLE "user_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"catalog_version" integer DEFAULT 1 NOT NULL,
	"requested_by_kilo_user_id" text,
	"target_email" text,
	"target_email_hmac" text NOT NULL,
	"pylon_ticket_ref" text,
	"cloud_subject_resolution" text NOT NULL,
	"cloud_subject_proof_ref" text,
	"preflight_attention_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_progress_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anonymized_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "user_deletion_requests_status_check" CHECK ("user_deletion_requests"."status" IN ('pending', 'in_progress', 'finalizing', 'completed', 'cancelled')),
	CONSTRAINT "user_deletion_requests_cloud_subject_resolution_check" CHECK ("user_deletion_requests"."cloud_subject_resolution" IN ('current_user', 'authoritative_absence', 'prior_queue_cleanup', 'legacy_identity_unresolved')),
	CONSTRAINT "user_deletion_requests_catalog_version_positive" CHECK ("user_deletion_requests"."catalog_version" >= 1),
	CONSTRAINT "user_deletion_requests_completed_at_check" CHECK (("user_deletion_requests"."status" = 'completed') = ("user_deletion_requests"."completed_at" IS NOT NULL)),
	CONSTRAINT "user_deletion_requests_cancelled_at_check" CHECK (("user_deletion_requests"."status" = 'cancelled') = ("user_deletion_requests"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "user_deletion_requests_active_email_check" CHECK (("user_deletion_requests"."status" IN ('pending', 'in_progress', 'finalizing')) = ("user_deletion_requests"."target_email" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "user_deletion_steps" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"claimed_until" timestamp with time zone,
	"window_attempt_count" integer DEFAULT 0 NOT NULL,
	"lifetime_attempt_count" integer DEFAULT 0 NOT NULL,
	"progress_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error_code" text,
	"rate_limited_since" timestamp with time zone,
	"manual_evidence_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_user_deletion_steps_request_step" UNIQUE("request_id","step_key"),
	CONSTRAINT "user_deletion_steps_step_key_check" CHECK ("user_deletion_steps"."step_key" IN ('kiloclaw_destroy', 'customerio', 'cli_v1_blobs', 'cli_v2_sessions', 'usage_prompt_prefixes', 'posthog', 'substack', 'anonymize', 'pylon_reply', 'pylon_contact')),
	CONSTRAINT "user_deletion_steps_status_check" CHECK ("user_deletion_steps"."status" IN ('pending', 'running', 'retry_wait', 'needs_attention', 'manual_action_required', 'succeeded', 'not_applicable', 'manually_verified')),
	CONSTRAINT "user_deletion_steps_window_attempt_count_nonnegative" CHECK ("user_deletion_steps"."window_attempt_count" >= 0),
	CONSTRAINT "user_deletion_steps_lifetime_attempt_count_nonnegative" CHECK ("user_deletion_steps"."lifetime_attempt_count" >= 0),
	CONSTRAINT "user_deletion_steps_claim_fields_check" CHECK (("user_deletion_steps"."claim_token" IS NULL) = ("user_deletion_steps"."claimed_until" IS NULL)),
	CONSTRAINT "user_deletion_steps_manual_evidence_check" CHECK (("user_deletion_steps"."status" = 'manually_verified') = ("user_deletion_steps"."manual_evidence_json" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "user_deletion_activity" ADD CONSTRAINT "user_deletion_activity_request_id_user_deletion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."user_deletion_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_deletion_audit_events" ADD CONSTRAINT "user_deletion_audit_events_request_id_user_deletion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."user_deletion_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_deletion_provider_credentials" ADD CONSTRAINT "user_deletion_provider_credentials_updated_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("updated_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_deletion_requests" ADD CONSTRAINT "user_deletion_requests_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_deletion_requests" ADD CONSTRAINT "user_deletion_requests_requested_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("requested_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_deletion_steps" ADD CONSTRAINT "user_deletion_steps_request_id_user_deletion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."user_deletion_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_user_deletion_activity_request_created" ON "user_deletion_activity" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_deletion_audit_events_idempotent" ON "user_deletion_audit_events" USING btree ("request_id","event_type","subject_key") WHERE "user_deletion_audit_events"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_user_deletion_audit_events_request_id" ON "user_deletion_audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "IDX_user_deletion_audit_events_hmac" ON "user_deletion_audit_events" USING btree ("target_email_hmac");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_deletion_requests_active_email_hmac" ON "user_deletion_requests" USING btree ("target_email_hmac") WHERE "user_deletion_requests"."status" IN ('pending', 'in_progress', 'finalizing');--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_deletion_requests_active_user_id" ON "user_deletion_requests" USING btree ("user_id") WHERE "user_deletion_requests"."user_id" IS NOT NULL AND "user_deletion_requests"."status" IN ('pending', 'in_progress', 'finalizing');--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_deletion_requests_active_pylon_ticket" ON "user_deletion_requests" USING btree (regexp_replace("pylon_ticket_ref", '^#', '')) WHERE "user_deletion_requests"."pylon_ticket_ref" IS NOT NULL AND "user_deletion_requests"."status" IN ('pending', 'in_progress', 'finalizing');--> statement-breakpoint
CREATE INDEX "IDX_user_deletion_requests_fairness" ON "user_deletion_requests" USING btree ("last_progress_at","created_at","id") WHERE "user_deletion_requests"."status" IN ('pending', 'in_progress', 'finalizing');--> statement-breakpoint
CREATE INDEX "IDX_user_deletion_requests_email_hmac" ON "user_deletion_requests" USING btree ("target_email_hmac");--> statement-breakpoint
CREATE INDEX "IDX_user_deletion_requests_user_id" ON "user_deletion_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_user_deletion_steps_due" ON "user_deletion_steps" USING btree ("status","available_at","id") WHERE "user_deletion_steps"."status" IN ('pending', 'retry_wait', 'running');--> statement-breakpoint
CREATE INDEX "IDX_user_deletion_steps_request_id" ON "user_deletion_steps" USING btree ("request_id");