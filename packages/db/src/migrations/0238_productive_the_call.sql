CREATE TABLE "api_request_log_2" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kilo_user_id" text,
	"organization_id" text,
	"session_id" text,
	"vercel_request_id" text,
	"provider" text,
	"model" text,
	"status_code" integer,
	"request" jsonb,
	"response" text,
	"error" jsonb
);
--> statement-breakpoint
CREATE INDEX "idx_api_request_log_2_created_at" ON "api_request_log_2" USING btree ("created_at");