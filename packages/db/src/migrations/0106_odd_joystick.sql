CREATE TABLE "api_request_log_cleanup_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_count" integer NOT NULL,
	"cutoff_date" timestamp with time zone NOT NULL
);
