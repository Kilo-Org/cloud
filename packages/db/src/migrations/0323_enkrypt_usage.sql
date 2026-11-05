CREATE TABLE "enkrypt_usage" (
	"id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"session_id" text,
	"api_kind_id" integer NOT NULL,
	"decision_id" integer NOT NULL,
	"enkrypt_credits_cost" real,
	"charged_microdollars" bigint NOT NULL,
	"added_latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enkrypt_usage_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
DO $$
DECLARE
  month_start date := date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date;
  partition_start date;
  partition_end date;
BEGIN
  FOR month_offset IN 0..2 LOOP
    partition_start := (month_start + make_interval(months => month_offset))::date;
    partition_end := (partition_start + interval '1 month')::date;
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "enkrypt_usage" FOR VALUES FROM (%L) TO (%L)',
      'enkrypt_usage_' || to_char(partition_start, 'YYYY_MM'),
      partition_start::text || ' 00:00:00+00',
      partition_end::text || ' 00:00:00+00'
    );
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE "enkrypt_usage_decision" (
	"decision_id" serial PRIMARY KEY NOT NULL,
	"decision" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enkrypt_usage" ADD CONSTRAINT "enkrypt_usage_api_kind_id_api_kind_api_kind_id_fk" FOREIGN KEY ("api_kind_id") REFERENCES "public"."api_kind"("api_kind_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enkrypt_usage" ADD CONSTRAINT "enkrypt_usage_decision_id_enkrypt_usage_decision_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."enkrypt_usage_decision"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_enkrypt_usage_organization_created_at" ON "enkrypt_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_enkrypt_usage_user_created_at" ON "enkrypt_usage" USING btree ("kilo_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_enkrypt_usage_decision" ON "enkrypt_usage_decision" USING btree ("decision");
