CREATE TABLE "leaderboard_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"usage_date" date NOT NULL,
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
CREATE INDEX "IDX_leaderboard_usage_daily_usage_date" ON "leaderboard_usage_daily" USING btree ("usage_date");