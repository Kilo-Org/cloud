CREATE TABLE "code_review_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform" text NOT NULL,
	"platform_integration_id" uuid,
	"subject_id" uuid,
	"code_review_id" uuid,
	"repo_full_name" text NOT NULL,
	"platform_project_id" integer,
	"pr_number" integer,
	"pr_url" text,
	"event_source" text NOT NULL,
	"signal_kind" text NOT NULL,
	"sentiment" text NOT NULL,
	"strength" smallint DEFAULT 1 NOT NULL,
	"external_event_id" text,
	"dedupe_hash" text NOT NULL,
	"external_url" text,
	"evidence_excerpt" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aggregation_state" text DEFAULT 'fresh' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_feedback_events_owner_check" CHECK ((
        ("code_review_feedback_events"."owned_by_user_id" IS NOT NULL AND "code_review_feedback_events"."owned_by_organization_id" IS NULL) OR
        ("code_review_feedback_events"."owned_by_user_id" IS NULL AND "code_review_feedback_events"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "code_review_feedback_events_strength_check" CHECK ("code_review_feedback_events"."strength" > 0)
);
--> statement-breakpoint
CREATE TABLE "code_review_feedback_subjects" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform" text NOT NULL,
	"platform_integration_id" uuid,
	"code_review_id" uuid,
	"subject_type" text NOT NULL,
	"external_id" text NOT NULL,
	"external_thread_id" text,
	"external_url" text,
	"repo_full_name" text NOT NULL,
	"platform_project_id" integer,
	"pr_number" integer,
	"pr_url" text,
	"head_sha" text,
	"file_path" text,
	"line_number" integer,
	"diff_hunk" text,
	"body_excerpt" text,
	"severity" text,
	"finding_title" text,
	"finding_fingerprint" text,
	"state" text DEFAULT 'unknown' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_feedback_subjects_owner_check" CHECK ((
        ("code_review_feedback_subjects"."owned_by_user_id" IS NOT NULL AND "code_review_feedback_subjects"."owned_by_organization_id" IS NULL) OR
        ("code_review_feedback_subjects"."owned_by_user_id" IS NULL AND "code_review_feedback_subjects"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "code_review_memory_aggregation_runs" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"platform_project_id" integer,
	"model_slug" text NOT NULL,
	"trigger" text NOT NULL,
	"input_event_count" integer DEFAULT 0 NOT NULL,
	"input_subject_count" integer DEFAULT 0 NOT NULL,
	"input_cluster_count" integer DEFAULT 0 NOT NULL,
	"fresh_event_cutoff_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"skip_reason" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"total_cost_musd" integer,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_memory_aggregation_runs_owner_check" CHECK ((
        ("code_review_memory_aggregation_runs"."owned_by_user_id" IS NOT NULL AND "code_review_memory_aggregation_runs"."owned_by_organization_id" IS NULL) OR
        ("code_review_memory_aggregation_runs"."owned_by_user_id" IS NULL AND "code_review_memory_aggregation_runs"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "code_review_memory_aggregation_state" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"platform_project_id" integer,
	"last_successful_run_at" timestamp with time zone,
	"last_attempted_run_at" timestamp with time zone,
	"last_included_event_created_at" timestamp with time zone,
	"fresh_event_count" integer DEFAULT 0 NOT NULL,
	"fresh_weight" integer DEFAULT 0 NOT NULL,
	"fresh_distinct_subject_count" integer DEFAULT 0 NOT NULL,
	"fresh_distinct_pr_count" integer DEFAULT 0 NOT NULL,
	"next_eligible_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"last_model_slug" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_memory_aggregation_state_owner_check" CHECK ((
        ("code_review_memory_aggregation_state"."owned_by_user_id" IS NOT NULL AND "code_review_memory_aggregation_state"."owned_by_organization_id" IS NULL) OR
        ("code_review_memory_aggregation_state"."owned_by_user_id" IS NULL AND "code_review_memory_aggregation_state"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "code_review_memory_proposal_evidence" (
	"proposal_id" uuid NOT NULL,
	"feedback_event_id" uuid NOT NULL,
	"evidence_role" text DEFAULT 'supporting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_memory_proposal_evidence_proposal_id_feedback_event_id_pk" PRIMARY KEY("proposal_id","feedback_event_id")
);
--> statement-breakpoint
CREATE TABLE "code_review_memory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform" text NOT NULL,
	"platform_integration_id" uuid,
	"repo_full_name" text NOT NULL,
	"platform_project_id" integer,
	"aggregation_run_id" uuid,
	"target_file_path" text DEFAULT 'REVIEW.md' NOT NULL,
	"scope_kind" text DEFAULT 'repository' NOT NULL,
	"scope_value" text,
	"proposal_type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"proposed_markdown" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"llm_confidence" real,
	"positive_count" integer DEFAULT 0 NOT NULL,
	"negative_count" integer DEFAULT 0 NOT NULL,
	"neutral_count" integer DEFAULT 0 NOT NULL,
	"distinct_pr_count" integer DEFAULT 0 NOT NULL,
	"distinct_subject_count" integer DEFAULT 0 NOT NULL,
	"contradictory_count" integer DEFAULT 0 NOT NULL,
	"edited_by_user_id" text,
	"approved_by_user_id" text,
	"rejected_by_user_id" text,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"change_request_type" text,
	"branch_name" text,
	"change_request_number" integer,
	"change_request_url" text,
	"change_request_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_memory_proposals_owner_check" CHECK ((
        ("code_review_memory_proposals"."owned_by_user_id" IS NOT NULL AND "code_review_memory_proposals"."owned_by_organization_id" IS NULL) OR
        ("code_review_memory_proposals"."owned_by_user_id" IS NULL AND "code_review_memory_proposals"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "code_review_feedback_events" ADD CONSTRAINT "code_review_feedback_events_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_feedback_events" ADD CONSTRAINT "code_review_feedback_events_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_feedback_events" ADD CONSTRAINT "code_review_feedback_events_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_feedback_events" ADD CONSTRAINT "code_review_feedback_events_subject_id_code_review_feedback_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."code_review_feedback_subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_feedback_events" ADD CONSTRAINT "code_review_feedback_events_code_review_id_cloud_agent_code_reviews_id_fk" FOREIGN KEY ("code_review_id") REFERENCES "public"."cloud_agent_code_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_feedback_subjects" ADD CONSTRAINT "code_review_feedback_subjects_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_feedback_subjects" ADD CONSTRAINT "code_review_feedback_subjects_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_feedback_subjects" ADD CONSTRAINT "code_review_feedback_subjects_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_feedback_subjects" ADD CONSTRAINT "code_review_feedback_subjects_code_review_id_cloud_agent_code_reviews_id_fk" FOREIGN KEY ("code_review_id") REFERENCES "public"."cloud_agent_code_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_aggregation_runs" ADD CONSTRAINT "code_review_memory_aggregation_runs_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_aggregation_runs" ADD CONSTRAINT "code_review_memory_aggregation_runs_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_aggregation_state" ADD CONSTRAINT "code_review_memory_aggregation_state_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_aggregation_state" ADD CONSTRAINT "code_review_memory_aggregation_state_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposal_evidence" ADD CONSTRAINT "code_review_memory_proposal_evidence_proposal_id_code_review_memory_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."code_review_memory_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposal_evidence" ADD CONSTRAINT "code_review_memory_proposal_evidence_feedback_event_id_code_review_feedback_events_id_fk" FOREIGN KEY ("feedback_event_id") REFERENCES "public"."code_review_feedback_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposals" ADD CONSTRAINT "code_review_memory_proposals_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposals" ADD CONSTRAINT "code_review_memory_proposals_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposals" ADD CONSTRAINT "code_review_memory_proposals_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposals" ADD CONSTRAINT "code_review_memory_proposals_aggregation_run_id_code_review_memory_aggregation_runs_id_fk" FOREIGN KEY ("aggregation_run_id") REFERENCES "public"."code_review_memory_aggregation_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposals" ADD CONSTRAINT "code_review_memory_proposals_edited_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposals" ADD CONSTRAINT "code_review_memory_proposals_approved_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposals" ADD CONSTRAINT "code_review_memory_proposals_rejected_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_feedback_events_external_event_id" ON "code_review_feedback_events" USING btree ("external_event_id") WHERE "code_review_feedback_events"."external_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_feedback_events_dedupe_hash" ON "code_review_feedback_events" USING btree ("dedupe_hash");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_owned_by_org_id" ON "code_review_feedback_events" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_owned_by_user_id" ON "code_review_feedback_events" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_platform_repo" ON "code_review_feedback_events" USING btree ("platform","repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_subject_id" ON "code_review_feedback_events" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_code_review_id" ON "code_review_feedback_events" USING btree ("code_review_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_sentiment" ON "code_review_feedback_events" USING btree ("sentiment");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_signal_kind" ON "code_review_feedback_events" USING btree ("signal_kind");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_aggregation_state" ON "code_review_feedback_events" USING btree ("aggregation_state");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_created_at" ON "code_review_feedback_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_feedback_subjects_platform_external" ON "code_review_feedback_subjects" USING btree ("platform","repo_full_name","subject_type","external_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_subjects_owned_by_org_id" ON "code_review_feedback_subjects" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_subjects_owned_by_user_id" ON "code_review_feedback_subjects" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_subjects_platform_repo" ON "code_review_feedback_subjects" USING btree ("platform","repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_subjects_pr" ON "code_review_feedback_subjects" USING btree ("repo_full_name","pr_number");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_subjects_code_review_id" ON "code_review_feedback_subjects" USING btree ("code_review_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_subjects_fingerprint" ON "code_review_feedback_subjects" USING btree ("finding_fingerprint");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_subjects_state" ON "code_review_feedback_subjects" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_subjects_thread" ON "code_review_feedback_subjects" USING btree ("external_thread_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_subjects_last_seen_at" ON "code_review_feedback_subjects" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_aggregation_runs_owned_by_org_id" ON "code_review_memory_aggregation_runs" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_aggregation_runs_owned_by_user_id" ON "code_review_memory_aggregation_runs" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_aggregation_runs_scope" ON "code_review_memory_aggregation_runs" USING btree ("platform","repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_aggregation_runs_status" ON "code_review_memory_aggregation_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_aggregation_runs_created_at" ON "code_review_memory_aggregation_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_memory_aggregation_state_org_scope" ON "code_review_memory_aggregation_state" USING btree ("owned_by_organization_id","platform","repo_full_name") WHERE "code_review_memory_aggregation_state"."owned_by_organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_memory_aggregation_state_user_scope" ON "code_review_memory_aggregation_state" USING btree ("owned_by_user_id","platform","repo_full_name") WHERE "code_review_memory_aggregation_state"."owned_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_aggregation_state_status" ON "code_review_memory_aggregation_state" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_aggregation_state_next_eligible_at" ON "code_review_memory_aggregation_state" USING btree ("next_eligible_at");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_aggregation_state_fresh_counts" ON "code_review_memory_aggregation_state" USING btree ("fresh_event_count","fresh_weight");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposal_evidence_feedback_event_id" ON "code_review_memory_proposal_evidence" USING btree ("feedback_event_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposal_evidence_role" ON "code_review_memory_proposal_evidence" USING btree ("evidence_role");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposals_owned_by_org_id" ON "code_review_memory_proposals" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposals_owned_by_user_id" ON "code_review_memory_proposals" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposals_platform_repo_status" ON "code_review_memory_proposals" USING btree ("platform","repo_full_name","status");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposals_proposal_type" ON "code_review_memory_proposals" USING btree ("proposal_type");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposals_created_at" ON "code_review_memory_proposals" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_memory_proposals_org_active_dedupe" ON "code_review_memory_proposals" USING btree ("owned_by_organization_id","platform","repo_full_name","dedupe_key") WHERE "code_review_memory_proposals"."owned_by_organization_id" IS NOT NULL AND "code_review_memory_proposals"."status" IN ('open', 'edited', 'approved', 'opening_change_request', 'change_request_opened');--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_memory_proposals_user_active_dedupe" ON "code_review_memory_proposals" USING btree ("owned_by_user_id","platform","repo_full_name","dedupe_key") WHERE "code_review_memory_proposals"."owned_by_user_id" IS NOT NULL AND "code_review_memory_proposals"."status" IN ('open', 'edited', 'approved', 'opening_change_request', 'change_request_opened');