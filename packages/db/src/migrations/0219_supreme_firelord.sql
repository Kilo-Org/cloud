CREATE TABLE "content_moderation_reports" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"surface" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"model_id" text,
	"session_id" text,
	"reason" text NOT NULL,
	"context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt_id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"triage_status" text DEFAULT 'received' NOT NULL,
	"appeal_status" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_moderation_reports_receipt_id_unique" UNIQUE("receipt_id")
);
--> statement-breakpoint
CREATE TABLE "user_moderation_blocks" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"blocker_user_id" text NOT NULL,
	"blocked_github_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_moderation_mutes" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"blocker_user_id" text NOT NULL,
	"muted_github_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_terms_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"terms_version" text NOT NULL,
	"age_posture" text DEFAULT '13_plus' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_content_moderation_reports_user_created" ON "content_moderation_reports" USING btree ("kilo_user_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_content_moderation_reports_target" ON "content_moderation_reports" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_moderation_blocks_blocker_login" ON "user_moderation_blocks" USING btree ("blocker_user_id","blocked_github_login");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_moderation_mutes_blocker_login" ON "user_moderation_mutes" USING btree ("blocker_user_id","muted_github_login");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_terms_acceptances_user_version" ON "user_terms_acceptances" USING btree ("kilo_user_id","terms_version");