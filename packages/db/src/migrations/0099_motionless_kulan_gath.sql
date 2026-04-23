CREATE TABLE "usage_rollup_daily" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"model" text NOT NULL,
	"feature" text NOT NULL,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"project_id" text NOT NULL,
	"cost_microdollars" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cache_hit_tokens" bigint NOT NULL,
	"request_count" integer NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"cancelled_count" integer DEFAULT 0 NOT NULL,
	"free_request_count" integer DEFAULT 0 NOT NULL,
	"byok_request_count" integer DEFAULT 0 NOT NULL,
	"total_latency_ms" bigint DEFAULT 0 NOT NULL,
	"total_generation_time_ms" bigint DEFAULT 0 NOT NULL,
	"latency_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rollup_daily_dims" UNIQUE NULLS NOT DISTINCT("day","kilo_user_id","organization_id","model","feature","mode","provider","project_id")
);
--> statement-breakpoint
CREATE TABLE "usage_rollup_daily_totals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"cost_microdollars" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cache_hit_tokens" bigint NOT NULL,
	"request_count" integer NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"cancelled_count" integer DEFAULT 0 NOT NULL,
	"free_request_count" integer DEFAULT 0 NOT NULL,
	"byok_request_count" integer DEFAULT 0 NOT NULL,
	"total_latency_ms" bigint DEFAULT 0 NOT NULL,
	"total_generation_time_ms" bigint DEFAULT 0 NOT NULL,
	"latency_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rollup_daily_totals_dims" UNIQUE NULLS NOT DISTINCT("day","kilo_user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "usage_rollup_hourly" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"model" text NOT NULL,
	"feature" text NOT NULL,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"project_id" text NOT NULL,
	"cost_microdollars" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cache_hit_tokens" bigint NOT NULL,
	"request_count" integer NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"cancelled_count" integer DEFAULT 0 NOT NULL,
	"free_request_count" integer DEFAULT 0 NOT NULL,
	"byok_request_count" integer DEFAULT 0 NOT NULL,
	"total_latency_ms" bigint DEFAULT 0 NOT NULL,
	"total_generation_time_ms" bigint DEFAULT 0 NOT NULL,
	"latency_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rollup_hourly_dims" UNIQUE NULLS NOT DISTINCT("hour","kilo_user_id","organization_id","model","feature","mode","provider","project_id")
);
--> statement-breakpoint
CREATE TABLE "usage_rollup_hourly_totals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"cost_microdollars" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cache_hit_tokens" bigint NOT NULL,
	"request_count" integer NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"cancelled_count" integer DEFAULT 0 NOT NULL,
	"free_request_count" integer DEFAULT 0 NOT NULL,
	"byok_request_count" integer DEFAULT 0 NOT NULL,
	"total_latency_ms" bigint DEFAULT 0 NOT NULL,
	"total_generation_time_ms" bigint DEFAULT 0 NOT NULL,
	"latency_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rollup_hourly_totals_dims" UNIQUE NULLS NOT DISTINCT("hour","kilo_user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "usage_rollup_monthly" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"month" date NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"model" text NOT NULL,
	"feature" text NOT NULL,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"project_id" text NOT NULL,
	"cost_microdollars" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cache_hit_tokens" bigint NOT NULL,
	"request_count" integer NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"cancelled_count" integer DEFAULT 0 NOT NULL,
	"free_request_count" integer DEFAULT 0 NOT NULL,
	"byok_request_count" integer DEFAULT 0 NOT NULL,
	"total_latency_ms" bigint DEFAULT 0 NOT NULL,
	"total_generation_time_ms" bigint DEFAULT 0 NOT NULL,
	"latency_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rollup_monthly_dims" UNIQUE NULLS NOT DISTINCT("month","kilo_user_id","organization_id","model","feature","mode","provider","project_id")
);
--> statement-breakpoint
CREATE TABLE "usage_rollup_monthly_totals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"month" date NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"cost_microdollars" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cache_hit_tokens" bigint NOT NULL,
	"request_count" integer NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"cancelled_count" integer DEFAULT 0 NOT NULL,
	"free_request_count" integer DEFAULT 0 NOT NULL,
	"byok_request_count" integer DEFAULT 0 NOT NULL,
	"total_latency_ms" bigint DEFAULT 0 NOT NULL,
	"total_generation_time_ms" bigint DEFAULT 0 NOT NULL,
	"latency_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rollup_monthly_totals_dims" UNIQUE NULLS NOT DISTINCT("month","kilo_user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "usage_rollup_watermark" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"granularity" text NOT NULL,
	"last_completed" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_usage_rollup_watermark_granularity" UNIQUE("granularity")
);
--> statement-breakpoint
CREATE INDEX "idx_rollup_daily_day" ON "usage_rollup_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "idx_rollup_daily_user_day" ON "usage_rollup_daily" USING btree ("kilo_user_id","day" DESC);--> statement-breakpoint
CREATE INDEX "idx_rollup_daily_org_day" ON "usage_rollup_daily" USING btree ("organization_id","day" DESC) WHERE "usage_rollup_daily"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_rollup_daily_totals_day" ON "usage_rollup_daily_totals" USING btree ("day");--> statement-breakpoint
CREATE INDEX "idx_rollup_daily_totals_user" ON "usage_rollup_daily_totals" USING btree ("kilo_user_id","day" DESC);--> statement-breakpoint
CREATE INDEX "idx_rollup_daily_totals_org" ON "usage_rollup_daily_totals" USING btree ("organization_id","day" DESC) WHERE "usage_rollup_daily_totals"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_rollup_hourly_hour" ON "usage_rollup_hourly" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "idx_rollup_hourly_user_hour" ON "usage_rollup_hourly" USING btree ("kilo_user_id","hour" DESC);--> statement-breakpoint
CREATE INDEX "idx_rollup_hourly_org_hour" ON "usage_rollup_hourly" USING btree ("organization_id","hour" DESC) WHERE "usage_rollup_hourly"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_rollup_hourly_totals_hour" ON "usage_rollup_hourly_totals" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "idx_rollup_hourly_totals_user" ON "usage_rollup_hourly_totals" USING btree ("kilo_user_id","hour" DESC);--> statement-breakpoint
CREATE INDEX "idx_rollup_hourly_totals_org" ON "usage_rollup_hourly_totals" USING btree ("organization_id","hour" DESC) WHERE "usage_rollup_hourly_totals"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_rollup_monthly_month" ON "usage_rollup_monthly" USING btree ("month");--> statement-breakpoint
CREATE INDEX "idx_rollup_monthly_user_month" ON "usage_rollup_monthly" USING btree ("kilo_user_id","month" DESC);--> statement-breakpoint
CREATE INDEX "idx_rollup_monthly_org_month" ON "usage_rollup_monthly" USING btree ("organization_id","month" DESC) WHERE "usage_rollup_monthly"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_rollup_monthly_totals_month" ON "usage_rollup_monthly_totals" USING btree ("month");--> statement-breakpoint
CREATE INDEX "idx_rollup_monthly_totals_user" ON "usage_rollup_monthly_totals" USING btree ("kilo_user_id","month" DESC);--> statement-breakpoint
CREATE INDEX "idx_rollup_monthly_totals_org" ON "usage_rollup_monthly_totals" USING btree ("organization_id","month" DESC) WHERE "usage_rollup_monthly_totals"."organization_id" is not null;