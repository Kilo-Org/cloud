CREATE TABLE "security_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"actor_id" text,
	"actor_email" text,
	"actor_name" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_audit_log_owner_check" CHECK (("security_audit_log"."owned_by_user_id" IS NOT NULL AND "security_audit_log"."owned_by_organization_id" IS NULL) OR ("security_audit_log"."owned_by_user_id" IS NULL AND "security_audit_log"."owned_by_organization_id" IS NOT NULL)),
	CONSTRAINT "security_audit_log_action_check" CHECK ("security_audit_log"."action" IN ('security.finding.created', 'security.finding.status_change', 'security.finding.dismissed', 'security.finding.auto_dismissed', 'security.finding.analysis_started', 'security.finding.analysis_completed', 'security.finding.deleted', 'security.config.enabled', 'security.config.disabled', 'security.config.updated', 'security.sync.triggered', 'security.sync.completed', 'security.audit_log.exported'))
);
--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD CONSTRAINT "security_audit_log_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD CONSTRAINT "security_audit_log_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_security_audit_log_org_created" ON "security_audit_log" USING btree ("owned_by_organization_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_security_audit_log_user_created" ON "security_audit_log" USING btree ("owned_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_security_audit_log_resource" ON "security_audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "IDX_security_audit_log_actor" ON "security_audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_security_audit_log_action" ON "security_audit_log" USING btree ("action","created_at");