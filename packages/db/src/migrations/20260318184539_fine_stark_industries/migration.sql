CREATE TABLE "kiloclaw_admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"actor_name" text,
	"target_user_id" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_admin_audit_logs_target_user_id" ON "kiloclaw_admin_audit_logs" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_admin_audit_logs_action" ON "kiloclaw_admin_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_admin_audit_logs_created_at" ON "kiloclaw_admin_audit_logs" USING btree ("created_at");