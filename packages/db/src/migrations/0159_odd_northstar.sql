CREATE TABLE "code_review_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer,
	"kilo_comment_id" text NOT NULL,
	"reply_excerpt" text NOT NULL,
	"kilo_comment_excerpt" text,
	"dedupe_hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_code_review_feedback_events_dedupe_hash" UNIQUE("dedupe_hash"),
	CONSTRAINT "code_review_feedback_events_owner_check" CHECK ((
        ("code_review_feedback_events"."owned_by_user_id" IS NOT NULL AND "code_review_feedback_events"."owned_by_organization_id" IS NULL) OR
        ("code_review_feedback_events"."owned_by_user_id" IS NULL AND "code_review_feedback_events"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "code_review_memory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"proposed_markdown" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"positive_count" integer DEFAULT 0 NOT NULL,
	"negative_count" integer DEFAULT 0 NOT NULL,
	"neutral_count" integer DEFAULT 0 NOT NULL,
	"change_request_url" text,
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
ALTER TABLE "code_review_memory_proposals" ADD CONSTRAINT "code_review_memory_proposals_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_memory_proposals" ADD CONSTRAINT "code_review_memory_proposals_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_owned_by_org_id" ON "code_review_feedback_events" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_owned_by_user_id" ON "code_review_feedback_events" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_platform_repo" ON "code_review_feedback_events" USING btree ("platform","repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_code_review_feedback_events_created_at" ON "code_review_feedback_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposals_owned_by_org_id" ON "code_review_memory_proposals" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposals_owned_by_user_id" ON "code_review_memory_proposals" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposals_platform_repo_status" ON "code_review_memory_proposals" USING btree ("platform","repo_full_name","status");--> statement-breakpoint
CREATE INDEX "idx_code_review_memory_proposals_updated_at" ON "code_review_memory_proposals" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_memory_proposals_org_active_scope" ON "code_review_memory_proposals" USING btree ("owned_by_organization_id","platform","repo_full_name") WHERE "code_review_memory_proposals"."owned_by_organization_id" IS NOT NULL AND "code_review_memory_proposals"."status" IN ('open', 'edited', 'opening_change_request');--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_memory_proposals_user_active_scope" ON "code_review_memory_proposals" USING btree ("owned_by_user_id","platform","repo_full_name") WHERE "code_review_memory_proposals"."owned_by_user_id" IS NOT NULL AND "code_review_memory_proposals"."status" IN ('open', 'edited', 'opening_change_request');