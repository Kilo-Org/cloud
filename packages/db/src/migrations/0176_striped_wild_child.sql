CREATE TABLE "snowflake_query_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"query_label" text NOT NULL,
	"request_id" uuid NOT NULL,
	"statement_handle" text,
	"succeeded" boolean NOT NULL,
	"status_code" integer,
	"duration_ms" integer NOT NULL,
	"submit_request_count" integer DEFAULT 0 NOT NULL,
	"poll_request_count" integer DEFAULT 0 NOT NULL,
	"partition_request_count" integer DEFAULT 0 NOT NULL,
	"http_202_count" integer DEFAULT 0 NOT NULL,
	"http_429_count" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"partition_count" integer DEFAULT 0 NOT NULL,
	"row_count" integer,
	"error_code" text,
	"error_message" text
);
--> statement-breakpoint
CREATE INDEX "idx_snowflake_query_log_created_at" ON "snowflake_query_log" USING btree ("created_at");