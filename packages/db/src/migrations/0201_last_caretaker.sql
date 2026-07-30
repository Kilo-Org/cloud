CREATE TABLE "kilo_pass_org_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"processing_run_id" uuid NOT NULL,
	"recipient_kilo_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_org_notification_deliveries_run_recipient" UNIQUE("processing_run_id","recipient_kilo_user_id"),
	CONSTRAINT "kilo_pass_org_notification_deliveries_status_check" CHECK ("kilo_pass_org_notification_deliveries"."status" IN ('pending', 'sending', 'sent')),
	CONSTRAINT "kilo_pass_org_notification_deliveries_attempt_count_check" CHECK ("kilo_pass_org_notification_deliveries"."attempt_count" >= 0),
	CONSTRAINT "kilo_pass_org_notification_deliveries_sent_check" CHECK (("kilo_pass_org_notification_deliveries"."status" = 'sent' AND "kilo_pass_org_notification_deliveries"."sent_at" IS NOT NULL AND "kilo_pass_org_notification_deliveries"."lease_expires_at" IS NULL) OR ("kilo_pass_org_notification_deliveries"."status" = 'sending' AND "kilo_pass_org_notification_deliveries"."sent_at" IS NULL AND "kilo_pass_org_notification_deliveries"."lease_expires_at" IS NOT NULL) OR ("kilo_pass_org_notification_deliveries"."status" = 'pending' AND "kilo_pass_org_notification_deliveries"."sent_at" IS NULL AND "kilo_pass_org_notification_deliveries"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "kilo_pass_org_issuance_snapshots" ADD COLUMN "repair_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_notification_deliveries" ADD CONSTRAINT "kilo_pass_org_notification_deliveries_processing_run_id_kilo_pass_org_processing_runs_id_fk" FOREIGN KEY ("processing_run_id") REFERENCES "public"."kilo_pass_org_processing_runs"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_org_notification_deliveries" ADD CONSTRAINT "kilo_pass_org_notification_deliveries_recipient_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("recipient_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_org_notification_deliveries_status" ON "kilo_pass_org_notification_deliveries" USING btree ("status","created_at");