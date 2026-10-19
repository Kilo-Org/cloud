CREATE TABLE "vercel_model_id_overrides" (
	"openrouter_model_id" text PRIMARY KEY NOT NULL,
	"vercel_model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
