CREATE TABLE "cloud_billing_sku" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit" text NOT NULL,
	"rate_cents_per_unit" numeric(24, 12) NOT NULL,
	"accepts_new_usage" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_billing_sku_id_format" CHECK ("cloud_billing_sku"."id" ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
	CONSTRAINT "cloud_billing_sku_name_nonempty" CHECK (length(btrim("cloud_billing_sku"."name")) > 0),
	CONSTRAINT "cloud_billing_sku_rate_positive" CHECK ("cloud_billing_sku"."rate_cents_per_unit" > 0)
);
--> statement-breakpoint
CREATE TABLE "container_usage_interval" (
	"id" text PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"instance_id" text NOT NULL,
	"start_epoch_ms" bigint NOT NULL,
	"cloud_billing_sku_id" text NOT NULL,
	"context_fingerprint" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"session_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_heartbeat_seq" integer DEFAULT 0 NOT NULL,
	"confirmed_seconds" integer DEFAULT 0 NOT NULL,
	"stopped_at" timestamp with time zone,
	"close_reason" text,
	"exit_code" integer,
	"final_stop_seq" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "container_usage_interval_subject_type" CHECK ("container_usage_interval"."subject_type" IN ('user', 'org')),
	CONSTRAINT "container_usage_interval_actor_type" CHECK ("container_usage_interval"."actor_type" IN ('user', 'bot')),
	CONSTRAINT "container_usage_interval_context_fingerprint" CHECK ("container_usage_interval"."context_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "container_usage_interval_attribution" CHECK ("container_usage_interval"."actor_type" = 'bot' OR ("container_usage_interval"."actor_type" = 'user' AND ("container_usage_interval"."subject_type" <> 'user' OR "container_usage_interval"."actor_id" = "container_usage_interval"."subject_id"))),
	CONSTRAINT "container_usage_interval_status" CHECK ("container_usage_interval"."status" IN ('open', 'closed')),
	CONSTRAINT "container_usage_interval_open_closed_shape" CHECK (("container_usage_interval"."status" = 'open' AND "container_usage_interval"."stopped_at" IS NULL AND "container_usage_interval"."close_reason" IS NULL) OR ("container_usage_interval"."status" = 'closed' AND "container_usage_interval"."stopped_at" IS NOT NULL AND "container_usage_interval"."close_reason" IS NOT NULL)),
	CONSTRAINT "container_usage_interval_time_order" CHECK ("container_usage_interval"."last_seen_at" >= "container_usage_interval"."started_at" AND ("container_usage_interval"."stopped_at" IS NULL OR ("container_usage_interval"."stopped_at" >= "container_usage_interval"."started_at" AND "container_usage_interval"."stopped_at" <= "container_usage_interval"."last_seen_at"))),
	CONSTRAINT "container_usage_interval_last_heartbeat_seq_nonnegative" CHECK ("container_usage_interval"."last_heartbeat_seq" >= 0),
	CONSTRAINT "container_usage_interval_confirmed_seconds_nonnegative" CHECK ("container_usage_interval"."confirmed_seconds" >= 0),
	CONSTRAINT "container_usage_interval_final_stop_seq_positive" CHECK ("container_usage_interval"."final_stop_seq" IS NULL OR "container_usage_interval"."final_stop_seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "container_usage_segment" (
	"interval_id" text NOT NULL,
	"seq" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"reported_seconds" integer NOT NULL,
	"usage_seconds" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "container_usage_segment_interval_id_seq_pk" PRIMARY KEY("interval_id","seq"),
	CONSTRAINT "container_usage_segment_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "container_usage_segment_seq_positive" CHECK ("container_usage_segment"."seq" > 0),
	CONSTRAINT "container_usage_segment_reported_seconds_nonnegative" CHECK ("container_usage_segment"."reported_seconds" >= 0),
	CONSTRAINT "container_usage_segment_usage_seconds_nonnegative" CHECK ("container_usage_segment"."usage_seconds" >= 0),
	CONSTRAINT "container_usage_segment_usage_within_reported" CHECK ("container_usage_segment"."usage_seconds" <= "container_usage_segment"."reported_seconds")
);
--> statement-breakpoint
ALTER TABLE "cloud_billing_sku" ADD CONSTRAINT "cloud_billing_sku_created_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_usage_interval" ADD CONSTRAINT "container_usage_interval_cloud_billing_sku_id_cloud_billing_sku_id_fk" FOREIGN KEY ("cloud_billing_sku_id") REFERENCES "public"."cloud_billing_sku"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_usage_segment" ADD CONSTRAINT "container_usage_segment_interval_id_container_usage_interval_id_fk" FOREIGN KEY ("interval_id") REFERENCES "public"."container_usage_interval"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_container_usage_interval_sweep" ON "container_usage_interval" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "IDX_container_usage_interval_subject_started" ON "container_usage_interval" USING btree ("subject_type","subject_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_container_usage_interval_single_open" ON "container_usage_interval" USING btree ("service","instance_id") WHERE "container_usage_interval"."status" = 'open';--> statement-breakpoint
CREATE INDEX "IDX_container_usage_segment_received" ON "container_usage_segment" USING btree ("received_at");