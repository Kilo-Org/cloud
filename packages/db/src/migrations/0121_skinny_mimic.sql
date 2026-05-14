CREATE TABLE "github_branch_pull_requests" (
	"git_url" text NOT NULL,
	"git_branch" text NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"pr_url" text,
	"pr_number" integer,
	"pr_state" text,
	"pr_title" text,
	"pr_head_sha" text,
	"pr_review_decision" text,
	"review_decision_pending" boolean DEFAULT false NOT NULL,
	"review_decision_fetching_at" timestamp with time zone,
	"pr_last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_branch_pull_requests_owner_check" CHECK ((
        ("github_branch_pull_requests"."owned_by_organization_id" IS NOT NULL AND "github_branch_pull_requests"."owned_by_user_id" IS NULL) OR
        ("github_branch_pull_requests"."owned_by_organization_id" IS NULL AND "github_branch_pull_requests"."owned_by_user_id" IS NOT NULL)
      )),
	CONSTRAINT "github_branch_pull_requests_review_decision_check" CHECK ("github_branch_pull_requests"."pr_review_decision" IS NULL OR "github_branch_pull_requests"."pr_review_decision" IN ('approved', 'changes_requested', 'review_required'))
);
--> statement-breakpoint
ALTER TABLE "github_branch_pull_requests" ADD CONSTRAINT "github_branch_pull_requests_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_branch_pull_requests" ADD CONSTRAINT "github_branch_pull_requests_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_github_branch_prs_org" ON "github_branch_pull_requests" USING btree ("git_url","git_branch","owned_by_organization_id") WHERE "github_branch_pull_requests"."owned_by_organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_github_branch_prs_user" ON "github_branch_pull_requests" USING btree ("git_url","git_branch","owned_by_user_id") WHERE "github_branch_pull_requests"."owned_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "cli_sessions_v2_git_url_branch_idx" ON "cli_sessions_v2" USING btree ("git_url","git_branch");