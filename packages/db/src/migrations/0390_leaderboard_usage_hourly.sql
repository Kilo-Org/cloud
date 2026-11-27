CREATE TABLE "leaderboard_usage_hourly" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"provider" text,
	"requested_model" text,
	"model" text,
	"inference_provider" text,
	"mode" text,
	"is_user_byok" boolean NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_hit_tokens" bigint NOT NULL,
	"cost_microdollars" bigint NOT NULL,
	"request_count" bigint NOT NULL,
	"error_count" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_usage_hours" (
	"hour_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"rows" integer NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_leaderboard_usage_hourly_hour_start" ON "leaderboard_usage_hourly" USING btree ("hour_start");