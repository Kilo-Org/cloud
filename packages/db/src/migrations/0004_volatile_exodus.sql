CREATE TABLE "api_request_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kilo_user_id" text,
	"organization_id" text,
	"provider" text,
	"model" text,
	"status_code" integer,
	"request" jsonb,
	"response" text
);
--> statement-breakpoint
CREATE INDEX "idx_api_request_log_created_at" ON "api_request_log" USING btree ("created_at");