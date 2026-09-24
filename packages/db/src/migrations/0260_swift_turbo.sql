CREATE TABLE "ai_gateway_external_models_cache" (
	"source" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
