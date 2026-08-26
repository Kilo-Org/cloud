CREATE TABLE "organization_alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"period_occurrence_id" text NOT NULL,
	"recipient_identity_hmac" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_configuration_version" integer NOT NULL,
	"claim_version" integer DEFAULT 1 NOT NULL,
	"threshold_microdollars" bigint NOT NULL,
	"measured_spend_microdollars" bigint NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"submitting_at" timestamp with time zone,
	"provider_message_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_alert_deliveries_identity" UNIQUE("alert_id","period_occurrence_id","recipient_identity_hmac","channel"),
	CONSTRAINT "organization_alert_deliveries_identity_fields_check" CHECK (length("organization_alert_deliveries"."period_occurrence_id") > 0 AND length("organization_alert_deliveries"."recipient_identity_hmac") > 0),
	CONSTRAINT "organization_alert_deliveries_channel_check" CHECK ("organization_alert_deliveries"."channel" = 'email'),
	CONSTRAINT "organization_alert_deliveries_status_check" CHECK ("organization_alert_deliveries"."status" IN ('pending', 'submitting', 'accepted', 'ambiguous', 'canceled')),
	CONSTRAINT "organization_alert_deliveries_counters_check" CHECK ("organization_alert_deliveries"."claimed_configuration_version" > 0 AND "organization_alert_deliveries"."claim_version" > 0 AND "organization_alert_deliveries"."attempt_count" >= 0),
	CONSTRAINT "organization_alert_deliveries_spend_check" CHECK ("organization_alert_deliveries"."threshold_microdollars" > 0 AND "organization_alert_deliveries"."measured_spend_microdollars" >= "organization_alert_deliveries"."threshold_microdollars"),
	CONSTRAINT "organization_alert_deliveries_submission_check" CHECK (("organization_alert_deliveries"."status" = 'submitting') = ("organization_alert_deliveries"."lease_expires_at" IS NOT NULL) AND ("organization_alert_deliveries"."status" NOT IN ('submitting', 'accepted', 'ambiguous') OR "organization_alert_deliveries"."submitting_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "organization_alerts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"configuration_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "organization_alerts_type_check" CHECK ("organization_alerts"."type" IN ('monthly_spending')),
	CONSTRAINT "organization_alerts_status_check" CHECK ("organization_alerts"."status" IN ('enabled', 'disabled', 'archived')),
	CONSTRAINT "organization_alerts_configuration_version_check" CHECK ("organization_alerts"."configuration_version" > 0),
	CONSTRAINT "organization_alerts_archive_check" CHECK (("organization_alerts"."status" = 'archived') = ("organization_alerts"."archived_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "organization_alert_deliveries" ADD CONSTRAINT "organization_alert_deliveries_alert_id_organization_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."organization_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_alerts" ADD CONSTRAINT "organization_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_organization_alert_deliveries_dispatch" ON "organization_alert_deliveries" USING btree ("status","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "IDX_organization_alerts_organization_status_created_id" ON "organization_alerts" USING btree ("organization_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "IDX_organization_alerts_enabled_organization_id" ON "organization_alerts" USING btree ("organization_id","id") WHERE "organization_alerts"."status" = 'enabled';