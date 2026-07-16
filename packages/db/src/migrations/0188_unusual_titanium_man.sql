CREATE TABLE "microdollar_usage_daily_repairs" (
	"usage_id" uuid PRIMARY KEY NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"usage_date" date NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_redacted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "microdollar_usage_daily_repairs_attempt_count_check" CHECK ("microdollar_usage_daily_repairs"."attempt_count" >= 0),
	CONSTRAINT "microdollar_usage_daily_repairs_claim_token_check" CHECK (("microdollar_usage_daily_repairs"."claimed_at" IS NULL AND "microdollar_usage_daily_repairs"."claim_token" IS NULL) OR ("microdollar_usage_daily_repairs"."claimed_at" IS NOT NULL AND "microdollar_usage_daily_repairs"."claim_token" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "microdollar_usage_daily_repairs" ADD CONSTRAINT "microdollar_usage_daily_repairs_usage_id_microdollar_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."microdollar_usage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_microdollar_usage_daily_repairs_claim" ON "microdollar_usage_daily_repairs" USING btree ("attempt_count","next_attempt_at","claimed_at","usage_date","usage_id");