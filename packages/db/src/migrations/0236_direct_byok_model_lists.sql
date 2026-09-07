CREATE TABLE "direct_byok_model_lists" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"models" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
