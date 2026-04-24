CREATE TABLE "security_advisor_scans" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" text,
	"source_platform" text NOT NULL,
	"source_method" text NOT NULL,
	"plugin_version" text,
	"openclaw_version" text,
	"public_ip" text,
	"findings_critical" integer DEFAULT 0 NOT NULL,
	"findings_warn" integer DEFAULT 0 NOT NULL,
	"findings_info" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_security_advisor_scans_user_created_at" ON "security_advisor_scans" USING btree ("kilo_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_security_advisor_scans_created_at" ON "security_advisor_scans" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_security_advisor_scans_platform" ON "security_advisor_scans" USING btree ("source_platform");