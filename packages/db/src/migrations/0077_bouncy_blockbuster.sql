CREATE TABLE "exa_monthly_usage" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"month" date NOT NULL,
	"total_cost_microdollars" bigint DEFAULT 0 NOT NULL,
	"total_charged_microdollars" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"free_allowance_microdollars" bigint DEFAULT 10000000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exa_usage_log" (
	"id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"path" text NOT NULL,
	"cost_microdollars" bigint NOT NULL,
	"charged_to_balance" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exa_usage_log_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "exa_usage_log_2026_04" PARTITION OF "exa_usage_log"
	FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
--> statement-breakpoint
CREATE TABLE "exa_usage_log_2026_05" PARTITION OF "exa_usage_log"
	FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_exa_monthly_usage_personal" ON "exa_monthly_usage" USING btree ("kilo_user_id","month") WHERE "exa_monthly_usage"."organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_exa_monthly_usage_org" ON "exa_monthly_usage" USING btree ("kilo_user_id","organization_id","month") WHERE "exa_monthly_usage"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_exa_usage_log_user_created" ON "exa_usage_log" USING btree ("kilo_user_id","created_at");