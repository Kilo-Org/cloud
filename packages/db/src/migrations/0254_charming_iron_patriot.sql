CREATE TABLE "spend_alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"scope_key" text NOT NULL,
	"rule_id" uuid,
	"kind" text,
	"channel" text,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipients" jsonb,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_redacted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_spend_alert_deliveries_dedupe_key" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "spend_alert_hourly" (
	"scope_key" text NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"cost_microdollars" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_alert_rule_state" (
	"rule_id" uuid PRIMARY KEY NOT NULL,
	"firing" boolean DEFAULT false NOT NULL,
	"condition_started_at" timestamp with time zone,
	"last_value_microdollars" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"settings_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold_microdollars" bigint,
	"window_hours" integer,
	"multiplier_basis_points" integer,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"push_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_alert_settings" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"scope_key" text NOT NULL,
	"kilo_user_id" text,
	"organization_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_alert_settings_scope_check" CHECK (("spend_alert_settings"."kilo_user_id" IS NOT NULL) <> ("spend_alert_settings"."organization_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD COLUMN "spend_alerts_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "spend_alert_deliveries" ADD CONSTRAINT "spend_alert_deliveries_rule_id_spend_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."spend_alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_alert_rule_state" ADD CONSTRAINT "spend_alert_rule_state_rule_id_spend_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."spend_alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_alert_rules" ADD CONSTRAINT "spend_alert_rules_settings_id_spend_alert_settings_id_fk" FOREIGN KEY ("settings_id") REFERENCES "public"."spend_alert_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_alert_settings" ADD CONSTRAINT "spend_alert_settings_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_alert_settings" ADD CONSTRAINT "spend_alert_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_spend_alert_deliveries_pending" ON "spend_alert_deliveries" USING btree ("status","next_attempt_at","attempt_count","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spend_alert_hourly_scope_hour" ON "spend_alert_hourly" USING btree ("scope_key","hour_start");--> statement-breakpoint
CREATE INDEX "IDX_spend_alert_hourly_hour_start" ON "spend_alert_hourly" USING btree ("hour_start");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spend_alert_rules_kind" ON "spend_alert_rules" USING btree ("settings_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spend_alert_settings_scope" ON "spend_alert_settings" USING btree ("scope_key");