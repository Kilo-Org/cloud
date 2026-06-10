CREATE TABLE "microdollar_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"usage_date" date NOT NULL,
	"total_cost_microdollars" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_microdollar_usage_daily_personal" ON "microdollar_usage_daily" USING btree ("kilo_user_id","usage_date") WHERE "microdollar_usage_daily"."organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_microdollar_usage_daily_org" ON "microdollar_usage_daily" USING btree ("kilo_user_id","organization_id","usage_date") WHERE "microdollar_usage_daily"."organization_id" is not null;