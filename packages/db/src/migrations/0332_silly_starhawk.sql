CREATE TABLE "organization_permission_events_daily" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kilo_user_id" text NOT NULL,
	"client" text NOT NULL,
	"permission" text NOT NULL,
	"command_key" text NOT NULL,
	"decision" text NOT NULL,
	"count" integer NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_rule_id" uuid,
	"last_tier" text,
	"last_policy_revision" integer,
	CONSTRAINT "UQ_org_permission_events_daily_key" UNIQUE("organization_id","day","kilo_user_id","client","permission","command_key","decision"),
	CONSTRAINT "organization_permission_events_daily_decision_check" CHECK ("organization_permission_events_daily"."decision" IN ('allowed', 'asked', 'denied')),
	CONSTRAINT "organization_permission_events_daily_count_check" CHECK ("organization_permission_events_daily"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "organization_permission_rules" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"pattern" text NOT NULL,
	"tier" text NOT NULL,
	"description" text,
	"source" jsonb NOT NULL,
	"created_by_kilo_user_id" text,
	"updated_by_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_permission_rules_org_permission_pattern_tier" UNIQUE("organization_id","permission","pattern","tier"),
	CONSTRAINT "organization_permission_rules_tier_check" CHECK ("organization_permission_rules"."tier" IN ('broad_allow', 'specific_deny', 'narrow_allow', 'final_deny')),
	CONSTRAINT "organization_permission_rules_permission_check" CHECK (char_length("organization_permission_rules"."permission") BETWEEN 1 AND 100),
	CONSTRAINT "organization_permission_rules_pattern_check" CHECK (char_length("organization_permission_rules"."pattern") BETWEEN 1 AND 500),
	CONSTRAINT "organization_permission_rules_description_check" CHECK ("organization_permission_rules"."description" IS NULL OR char_length("organization_permission_rules"."description") <= 500),
	CONSTRAINT "organization_permission_rules_tool_level_pattern_check" CHECK ("organization_permission_rules"."permission" NOT IN ('read', 'edit', 'glob', 'grep', 'list', 'todowrite', 'todoread', 'webfetch', 'websearch', 'codesearch') OR "organization_permission_rules"."pattern" = '*')
);
--> statement-breakpoint
ALTER TABLE "organization_permission_events_daily" ADD CONSTRAINT "organization_permission_events_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_permission_rules" ADD CONSTRAINT "organization_permission_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_org_permission_events_daily_org_day" ON "organization_permission_events_daily" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX "IDX_org_permission_events_daily_org_permission_key" ON "organization_permission_events_daily" USING btree ("organization_id","permission","command_key");--> statement-breakpoint
CREATE INDEX "IDX_org_permission_events_daily_day" ON "organization_permission_events_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "IDX_organization_permission_rules_organization_id" ON "organization_permission_rules" USING btree ("organization_id");