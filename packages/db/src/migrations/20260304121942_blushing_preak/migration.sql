DROP INDEX "UQ_auto_fix_tickets_repo_issue";--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD COLUMN "trigger_source" text DEFAULT 'label' NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD COLUMN "review_comment_id" bigint;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD COLUMN "review_comment_body" text;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD COLUMN "file_path" text;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD COLUMN "line_number" integer;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD COLUMN "diff_hunk" text;--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD COLUMN "pr_head_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_auto_fix_tickets_repo_review_comment" ON "auto_fix_tickets" USING btree ("repo_full_name","review_comment_id") WHERE "auto_fix_tickets"."review_comment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_auto_fix_tickets_repo_issue" ON "auto_fix_tickets" USING btree ("repo_full_name","issue_number") WHERE "auto_fix_tickets"."trigger_source" = 'label';--> statement-breakpoint
ALTER TABLE "auto_fix_tickets" ADD CONSTRAINT "auto_fix_tickets_trigger_source_check" CHECK ("auto_fix_tickets"."trigger_source" IN ('label', 'review_comment'));