CREATE TABLE "ai_gateway_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ai_gateway_config_singleton" CHECK ("ai_gateway_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "ai_gateway_request_logging_opt_ins" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"opt_ins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "ai_gateway_request_logging_opt_ins_singleton" CHECK ("ai_gateway_request_logging_opt_ins"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "ai_gateway_sync_providers_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_completed_at" timestamp with time zone,
	"stale_alert_last_posted_at" timestamp with time zone,
	CONSTRAINT "ai_gateway_sync_providers_state_singleton" CHECK ("ai_gateway_sync_providers_state"."id" = 1)
);
