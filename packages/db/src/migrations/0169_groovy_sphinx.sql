CREATE TABLE "api_request_compress_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" text,
	"session_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_api_request_compress_log_created_at" ON "api_request_compress_log" USING btree ("created_at");