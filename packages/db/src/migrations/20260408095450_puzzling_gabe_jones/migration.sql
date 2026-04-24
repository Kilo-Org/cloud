ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "auto_resume_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "auto_resume_retry_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "auto_resume_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscriptions_auto_resume_retry_after" ON "kiloclaw_subscriptions" USING btree ("auto_resume_retry_after");