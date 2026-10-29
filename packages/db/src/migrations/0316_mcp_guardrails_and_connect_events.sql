CREATE TABLE "organization_guardrails" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"identity_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'enabled' NOT NULL,
	"config" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"created_by_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_organization_guardrails_organization_id_type_identity_key" UNIQUE("organization_id","type","identity_key"),
	CONSTRAINT "organization_guardrails_type_check" CHECK ("organization_guardrails"."type" IN ('mcp')),
	CONSTRAINT "organization_guardrails_status_check" CHECK ("organization_guardrails"."status" IN ('enabled', 'disabled')),
	CONSTRAINT "organization_guardrails_name_check" CHECK (char_length(btrim("organization_guardrails"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "organization_guardrails_description_check" CHECK ("organization_guardrails"."description" IS NULL OR char_length("organization_guardrails"."description") <= 500)
);
--> statement-breakpoint
CREATE TABLE "organization_mcp_connect_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"client" text NOT NULL,
	"decision" text NOT NULL,
	"identity_key" text NOT NULL,
	"target" jsonb NOT NULL,
	"server_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_mcp_connect_events_decision_check" CHECK ("organization_mcp_connect_events"."decision" IN ('allowed', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "organization_guardrails" ADD CONSTRAINT "organization_guardrails_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_mcp_connect_events" ADD CONSTRAINT "organization_mcp_connect_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_org_mcp_connect_events_org_identity" ON "organization_mcp_connect_events" USING btree ("organization_id","identity_key","created_at");--> statement-breakpoint
CREATE INDEX "IDX_org_mcp_connect_events_org_created" ON "organization_mcp_connect_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_org_mcp_connect_events_created_at" ON "organization_mcp_connect_events" USING btree ("created_at");