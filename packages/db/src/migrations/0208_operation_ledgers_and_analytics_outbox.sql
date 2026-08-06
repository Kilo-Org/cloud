CREATE TABLE "analytics_event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"event_uuid" uuid NOT NULL,
	"event_name" text NOT NULL,
	"distinct_id" text NOT NULL,
	"properties" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "operation_ledgers" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"operation_key" text NOT NULL,
	"domain" text NOT NULL,
	"intent" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" text,
	"resource_key" text,
	"provider_ref" text,
	"taxonomy" text NOT NULL,
	"status" text DEFAULT 'admitted' NOT NULL,
	"outcome_code" text,
	"canonical_result" jsonb,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_analytics_event_outbox_event_uuid" ON "analytics_event_outbox" USING btree ("event_uuid");--> statement-breakpoint
CREATE INDEX "IDX_analytics_event_outbox_status_next_attempt_at" ON "analytics_event_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_operation_ledgers_kilo_user_id_domain_operation_key" ON "operation_ledgers" USING btree ("kilo_user_id","domain","operation_key");--> statement-breakpoint
CREATE INDEX "IDX_operation_ledgers_status_expires_at" ON "operation_ledgers" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "IDX_operation_ledgers_provider_ref" ON "operation_ledgers" USING btree ("provider_ref");