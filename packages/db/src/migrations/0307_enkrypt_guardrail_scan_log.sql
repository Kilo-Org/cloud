CREATE TABLE "enkrypt_guardrail_scan_log" (
	"id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"usage_id" text,
	"api_kind" text NOT NULL,
	"model" text NOT NULL,
	"direction" text NOT NULL,
	"text_chars" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"flagged" boolean,
	"summary" jsonb,
	"http_status" integer,
	"error" text,
	"enkrypt_credits" integer,
	"enkrypt_credits_estimated" boolean DEFAULT false NOT NULL,
	"enkrypt_latency_ms" integer,
	"cost_microdollars" bigint NOT NULL,
	"charged_to_balance" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enkrypt_guardrail_scan_log_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "enkrypt_guardrail_scan_log_direction" CHECK ("enkrypt_guardrail_scan_log"."direction" IN ('input', 'output')),
	CONSTRAINT "enkrypt_guardrail_scan_log_cost_nonnegative" CHECK ("enkrypt_guardrail_scan_log"."cost_microdollars" >= 0)
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "enkrypt_guardrail_scan_log_2026_10" PARTITION OF "enkrypt_guardrail_scan_log" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
--> statement-breakpoint
CREATE TABLE "enkrypt_guardrail_scan_log_2026_11" PARTITION OF "enkrypt_guardrail_scan_log" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
--> statement-breakpoint
CREATE TABLE "enkrypt_guardrail_scan_log_2026_12" PARTITION OF "enkrypt_guardrail_scan_log" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
--> statement-breakpoint
CREATE INDEX "idx_enkrypt_guardrail_scan_log_org_created" ON "enkrypt_guardrail_scan_log" USING btree ("organization_id","created_at");