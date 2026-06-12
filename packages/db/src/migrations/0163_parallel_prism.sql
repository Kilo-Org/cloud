CREATE TABLE "security_finding_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"recipient_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_finding_notifications_kind_check" CHECK ("security_finding_notifications"."kind" IN ('new_finding', 'sla_warning', 'sla_breach')),
	CONSTRAINT "security_finding_notifications_status_check" CHECK ("security_finding_notifications"."status" IN ('staged', 'pending', 'sending', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "security_finding_notifications_attempt_count_check" CHECK ("security_finding_notifications"."attempt_count" >= 0),
	CONSTRAINT "security_finding_notifications_claimed_at_check" CHECK ((
        ("security_finding_notifications"."status" = 'sending' AND "security_finding_notifications"."claimed_at" IS NOT NULL) OR
        ("security_finding_notifications"."status" <> 'sending' AND "security_finding_notifications"."claimed_at" IS NULL)
      )),
	CONSTRAINT "security_finding_notifications_sent_at_check" CHECK ((
        ("security_finding_notifications"."status" = 'sent' AND "security_finding_notifications"."sent_at" IS NOT NULL) OR
        ("security_finding_notifications"."status" <> 'sent' AND "security_finding_notifications"."sent_at" IS NULL)
      )),
	CONSTRAINT "security_finding_notifications_error_message_length_check" CHECK ("security_finding_notifications"."error_message" IS NULL OR length("security_finding_notifications"."error_message") <= 500)
);
--> statement-breakpoint
ALTER TABLE "security_finding_notifications" ADD CONSTRAINT "security_finding_notifications_finding_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."security_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_finding_notifications" ADD CONSTRAINT "security_finding_notifications_recipient_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_security_finding_notifications_finding_recipient_kind" ON "security_finding_notifications" USING btree ("finding_id","recipient_user_id","kind");--> statement-breakpoint
CREATE INDEX "idx_security_finding_notifications_pending" ON "security_finding_notifications" USING btree ("next_attempt_at","created_at","id") WHERE "security_finding_notifications"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_security_finding_notifications_staged" ON "security_finding_notifications" USING btree ("created_at","id") WHERE "security_finding_notifications"."status" = 'staged';--> statement-breakpoint
CREATE INDEX "idx_security_finding_notifications_finding_id" ON "security_finding_notifications" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "idx_security_finding_notifications_recipient_user_id" ON "security_finding_notifications" USING btree ("recipient_user_id");--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "uq_security_findings_user_source" ON "security_findings" USING btree ("owned_by_user_id","repo_full_name","source","source_id") WHERE "security_findings"."owned_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "uq_security_findings_org_source" ON "security_findings" USING btree ("owned_by_organization_id","repo_full_name","source","source_id") WHERE "security_findings"."owned_by_organization_id" IS NOT NULL;--> statement-breakpoint
BEGIN;--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "uq_security_findings_source";