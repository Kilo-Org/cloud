CREATE TABLE "webhook_event_signatures" (
	"event_signature" text PRIMARY KEY NOT NULL,
	"webhook_event_id" uuid NOT NULL,
	"webhook_event_created_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events_v2" (
	"id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"platform" text NOT NULL,
	"event_type" text NOT NULL,
	"event_action" text,
	"payload" jsonb NOT NULL,
	"headers" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"handlers_triggered" text[] DEFAULT '{}' NOT NULL,
	"errors" jsonb,
	"event_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_v2_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "webhook_events_v2_owner_check" CHECK ((
        ("webhook_events_v2"."owned_by_user_id" IS NOT NULL AND "webhook_events_v2"."owned_by_organization_id" IS NULL) OR
        ("webhook_events_v2"."owned_by_user_id" IS NULL AND "webhook_events_v2"."owned_by_organization_id" IS NOT NULL)
      ))
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE INDEX "IDX_webhook_event_signatures_created_at" ON "webhook_event_signatures" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_webhook_events_v2_owned_by_org_id_created_at" ON "webhook_events_v2" USING btree ("owned_by_organization_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_webhook_events_v2_owned_by_user_id_created_at" ON "webhook_events_v2" USING btree ("owned_by_user_id","created_at");--> statement-breakpoint
-- Hand-written: Drizzle cannot express partitions. Create today's UTC day and the
-- next seven from the time the migration runs, so inserts succeed before the
-- maintenance cron first runs. Bounds carry an explicit +00 because a bare date
-- is read in the session time zone. Fillfactor is per partition: a partitioned
-- parent cannot take storage parameters.
DO $$
DECLARE
  first_day date := (now() AT TIME ZONE 'UTC')::date;
  day date;
BEGIN
  FOR offset_days IN 0..7 LOOP
    day := first_day + offset_days;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "webhook_events_v2" FOR VALUES FROM (%L) TO (%L) WITH (fillfactor = 90)',
      'webhook_events_v2_' || to_char(day, 'YYYY_MM_DD'),
      to_char(day, 'YYYY-MM-DD') || ' 00:00:00+00',
      to_char(day + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
    );
  END LOOP;
END $$;
