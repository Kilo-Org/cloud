CREATE TABLE "service_fee_rollback_refunds" (
	"assessment_key" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"rejected_attempts" integer DEFAULT 0 NOT NULL,
	"amount_minor" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"stripe_charge_id" text,
	"stripe_refund_id" text,
	"reason" text,
	"requested_by_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_fee_rollback_refunds_status_check" CHECK ("service_fee_rollback_refunds"."status" IN ('pending', 'succeeded', 'skipped', 'failed')),
	CONSTRAINT "service_fee_rollback_refunds_amounts_check" CHECK ("service_fee_rollback_refunds"."amount_minor" >= 0 AND "service_fee_rollback_refunds"."attempt" >= 1 AND "service_fee_rollback_refunds"."rejected_attempts" >= 0),
	CONSTRAINT "service_fee_rollback_refunds_succeeded_check" CHECK ("service_fee_rollback_refunds"."status" <> 'succeeded' OR "service_fee_rollback_refunds"."stripe_refund_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "service_fee_rollback_refunds" ADD CONSTRAINT "FK_svc_fee_rollback_refunds_assessment" FOREIGN KEY ("assessment_key") REFERENCES "public"."stripe_service_fee_assessments"("assessment_key") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "service_fee_rollback_refunds" ADD CONSTRAINT "FK_svc_fee_rollback_refunds_requested_by" FOREIGN KEY ("requested_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_service_fee_rollback_refunds_stripe_refund_id" ON "service_fee_rollback_refunds" USING btree ("stripe_refund_id") WHERE "service_fee_rollback_refunds"."stripe_refund_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_service_fee_rollback_refunds_status" ON "service_fee_rollback_refunds" USING btree ("status");