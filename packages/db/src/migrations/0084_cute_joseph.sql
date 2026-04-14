CREATE TABLE "contributor_champion_contributors" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"github_login" text NOT NULL,
	"github_profile_url" text NOT NULL,
	"github_user_id" bigint,
	"first_contribution_at" timestamp with time zone,
	"last_contribution_at" timestamp with time zone,
	"all_time_contributions" integer DEFAULT 0 NOT NULL,
	"manual_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_contributor_champion_contributors_github_login" UNIQUE("github_login")
);
--> statement-breakpoint
CREATE TABLE "contributor_champion_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"contributor_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"github_pr_number" integer NOT NULL,
	"github_pr_url" text NOT NULL,
	"github_pr_title" text NOT NULL,
	"github_author_login" text NOT NULL,
	"github_author_email" text,
	"merged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_contributor_champion_events_repo_pr" UNIQUE("repo_full_name","github_pr_number")
);
--> statement-breakpoint
CREATE TABLE "contributor_champion_memberships" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"contributor_id" uuid NOT NULL,
	"selected_tier" text,
	"enrolled_tier" text,
	"enrolled_at" timestamp with time zone,
	"credit_amount_microdollars" bigint DEFAULT 0 NOT NULL,
	"credits_last_granted_at" timestamp with time zone,
	"linked_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_contributor_champion_memberships_contributor_id" UNIQUE("contributor_id"),
	CONSTRAINT "contributor_champion_memberships_selected_tier_check" CHECK ("contributor_champion_memberships"."selected_tier" IS NULL OR "contributor_champion_memberships"."selected_tier" IN ('contributor', 'ambassador', 'champion')),
	CONSTRAINT "contributor_champion_memberships_enrolled_tier_check" CHECK ("contributor_champion_memberships"."enrolled_tier" IS NULL OR "contributor_champion_memberships"."enrolled_tier" IN ('contributor', 'ambassador', 'champion'))
);
--> statement-breakpoint
CREATE TABLE "contributor_champion_sync_state" (
	"repo_full_name" text PRIMARY KEY NOT NULL,
	"last_merged_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contributor_champion_events" ADD CONSTRAINT "contributor_champion_events_contributor_id_contributor_champion_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributor_champion_contributors"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "contributor_champion_memberships" ADD CONSTRAINT "contributor_champion_memberships_contributor_id_contributor_champion_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributor_champion_contributors"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "contributor_champion_memberships" ADD CONSTRAINT "contributor_champion_memberships_linked_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("linked_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_contributor_champion_contributors_last_contribution_at" ON "contributor_champion_contributors" USING btree ("last_contribution_at");--> statement-breakpoint
CREATE INDEX "IDX_contributor_champion_contributors_manual_email" ON "contributor_champion_contributors" USING btree ("manual_email");--> statement-breakpoint
CREATE INDEX "IDX_contributor_champion_events_contributor_id" ON "contributor_champion_events" USING btree ("contributor_id");--> statement-breakpoint
CREATE INDEX "IDX_contributor_champion_events_merged_at" ON "contributor_champion_events" USING btree ("merged_at");--> statement-breakpoint
CREATE INDEX "IDX_contributor_champion_events_author_email" ON "contributor_champion_events" USING btree ("github_author_email");--> statement-breakpoint
CREATE INDEX "IDX_contributor_champion_memberships_credits_due" ON "contributor_champion_memberships" USING btree ("credits_last_granted_at") WHERE "contributor_champion_memberships"."enrolled_tier" IS NOT NULL AND "contributor_champion_memberships"."credit_amount_microdollars" > 0;--> statement-breakpoint
CREATE INDEX "IDX_contributor_champion_memberships_linked_kilo_user_id" ON "contributor_champion_memberships" USING btree ("linked_kilo_user_id");