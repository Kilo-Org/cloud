CREATE TABLE "code_review_analytics_findings" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"analytics_result_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"security_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_code_review_analytics_findings_result_ordinal" UNIQUE("analytics_result_id","ordinal"),
	CONSTRAINT "code_review_analytics_findings_severity_check" CHECK ("code_review_analytics_findings"."severity" IN ('critical', 'warning', 'suggestion')),
	CONSTRAINT "code_review_analytics_findings_category_check" CHECK ("code_review_analytics_findings"."category" IN ('security', 'correctness', 'reliability', 'data_integrity', 'performance', 'compatibility', 'maintainability', 'test_quality', 'documentation', 'accessibility', 'other')),
	CONSTRAINT "code_review_analytics_findings_security_class_check" CHECK ("code_review_analytics_findings"."security_class" IN ('auth_access', 'injection', 'data_protection', 'request_resource_boundary', 'deserialization_object_integrity', 'dependency_supply_chain', 'memory_safety', 'availability', 'concurrency', 'security_configuration', 'other')),
	CONSTRAINT "code_review_analytics_findings_ordinal_check" CHECK ("code_review_analytics_findings"."ordinal" >= 0),
	CONSTRAINT "code_review_analytics_findings_security_class_presence_check" CHECK ((
        ("code_review_analytics_findings"."category" = 'security' AND "code_review_analytics_findings"."security_class" IS NOT NULL) OR
        ("code_review_analytics_findings"."category" <> 'security' AND "code_review_analytics_findings"."security_class" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "code_review_analytics_results" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"code_review_id" uuid NOT NULL,
	"source_attempt_id" uuid NOT NULL,
	"capture_status" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"taxonomy_version" integer DEFAULT 1 NOT NULL,
	"change_type" text,
	"impact_level" text,
	"complexity_level" text,
	"classification_confidence" text,
	"finalized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_code_review_analytics_results_code_review_id" UNIQUE("code_review_id"),
	CONSTRAINT "code_review_analytics_results_capture_status_check" CHECK ("code_review_analytics_results"."capture_status" IN ('captured', 'missing', 'invalid', 'omitted')),
	CONSTRAINT "code_review_analytics_results_change_type_check" CHECK ("code_review_analytics_results"."change_type" IN ('bug_fix', 'feature', 'refactor', 'maintenance', 'dependency', 'test', 'documentation', 'mixed', 'other')),
	CONSTRAINT "code_review_analytics_results_impact_level_check" CHECK ("code_review_analytics_results"."impact_level" IN ('low', 'medium', 'high')),
	CONSTRAINT "code_review_analytics_results_complexity_level_check" CHECK ("code_review_analytics_results"."complexity_level" IN ('low', 'medium', 'high')),
	CONSTRAINT "code_review_analytics_results_classification_confidence_check" CHECK ("code_review_analytics_results"."classification_confidence" IN ('low', 'medium', 'high')),
	CONSTRAINT "code_review_analytics_results_classification_presence_check" CHECK ((
        (
          "code_review_analytics_results"."capture_status" = 'captured'
          AND "code_review_analytics_results"."change_type" IS NOT NULL
          AND "code_review_analytics_results"."impact_level" IS NOT NULL
          AND "code_review_analytics_results"."complexity_level" IS NOT NULL
          AND "code_review_analytics_results"."classification_confidence" IS NOT NULL
        ) OR (
          "code_review_analytics_results"."capture_status" <> 'captured'
          AND "code_review_analytics_results"."change_type" IS NULL
          AND "code_review_analytics_results"."impact_level" IS NULL
          AND "code_review_analytics_results"."complexity_level" IS NULL
          AND "code_review_analytics_results"."classification_confidence" IS NULL
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD COLUMN "analytics_enabled_at_dispatch" boolean;--> statement-breakpoint
ALTER TABLE "code_review_analytics_findings" ADD CONSTRAINT "code_review_analytics_findings_analytics_result_id_code_review_analytics_results_id_fk" FOREIGN KEY ("analytics_result_id") REFERENCES "public"."code_review_analytics_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_analytics_results" ADD CONSTRAINT "code_review_analytics_results_code_review_id_cloud_agent_code_reviews_id_fk" FOREIGN KEY ("code_review_id") REFERENCES "public"."cloud_agent_code_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_analytics_results" ADD CONSTRAINT "code_review_analytics_results_source_attempt_id_cloud_agent_code_review_attempts_id_fk" FOREIGN KEY ("source_attempt_id") REFERENCES "public"."cloud_agent_code_review_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_code_review_analytics_results_source_attempt_id" ON "code_review_analytics_results" USING btree ("source_attempt_id");--> statement-breakpoint
CREATE INDEX "idx_code_review_analytics_results_finalized_at" ON "code_review_analytics_results" USING btree ("finalized_at");