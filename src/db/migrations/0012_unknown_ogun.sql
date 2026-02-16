CREATE TABLE "custom_llm" (
	"public_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"context_length" integer NOT NULL,
	"max_completion_tokens" integer NOT NULL,
	"internal_id" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text NOT NULL,
	"verbosity" text NOT NULL,
	"organization_ids" jsonb NOT NULL
);
