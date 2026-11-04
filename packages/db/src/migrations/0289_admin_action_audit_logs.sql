CREATE TABLE "admin_action_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_email" text,
	"actor_name" text,
	"target_type" text,
	"target_id" text,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_admin_action_audit_logs_created_at" ON "admin_action_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_admin_action_audit_logs_action_created_at" ON "admin_action_audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "IDX_admin_action_audit_logs_actor_id_created_at" ON "admin_action_audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_admin_action_audit_logs_target_created_at" ON "admin_action_audit_logs" USING btree ("target_type","target_id","created_at");