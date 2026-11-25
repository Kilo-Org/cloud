CREATE TABLE "auth_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"user_id" text,
	"method" text,
	"failure_reason" text,
	"subject_email_hash" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_action_audit_logs" ADD COLUMN "outcome" text DEFAULT 'success' NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_auth_audit_logs_created_at" ON "auth_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_auth_audit_logs_user_id_created_at" ON "auth_audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_auth_audit_logs_action_created_at" ON "auth_audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "IDX_auth_audit_logs_subject_email_hash_created_at" ON "auth_audit_logs" USING btree ("subject_email_hash","created_at") WHERE "auth_audit_logs"."subject_email_hash" IS NOT NULL;