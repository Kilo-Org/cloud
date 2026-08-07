CREATE TABLE "compute_usage_charge" (
	"usage_source" text NOT NULL,
	"usage_source_id" text NOT NULL,
	"user_id" text,
	"organization_id" uuid,
	"cloud_billing_sku_id" text NOT NULL,
	"quantity" numeric(24, 12) NOT NULL,
	"settled_quantity_after" numeric(24, 12),
	"rate_cents_per_unit" numeric(24, 12) NOT NULL,
	"amount_microdollars" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "compute_usage_charge_usage_source_usage_source_id_created_at_pk" PRIMARY KEY("usage_source","usage_source_id","created_at"),
	CONSTRAINT "compute_usage_charge_exactly_one_payer" CHECK (("compute_usage_charge"."user_id" IS NULL) <> ("compute_usage_charge"."organization_id" IS NULL)),
	CONSTRAINT "compute_usage_charge_quantity_positive" CHECK ("compute_usage_charge"."quantity" > 0),
	CONSTRAINT "compute_usage_charge_settled_quantity_positive" CHECK ("compute_usage_charge"."settled_quantity_after" IS NULL OR "compute_usage_charge"."settled_quantity_after" > 0),
	CONSTRAINT "compute_usage_charge_rate_positive" CHECK ("compute_usage_charge"."rate_cents_per_unit" > 0),
	CONSTRAINT "compute_usage_charge_amount_positive" CHECK ("compute_usage_charge"."amount_microdollars" > 0)
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "compute_usage_charge_2026_08" PARTITION OF "compute_usage_charge" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--> statement-breakpoint
CREATE TABLE "compute_usage_charge_2026_09" PARTITION OF "compute_usage_charge" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
--> statement-breakpoint
CREATE TABLE "compute_usage_charge_2026_10" PARTITION OF "compute_usage_charge" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
--> statement-breakpoint
ALTER TABLE "container_usage_interval" ADD COLUMN "billing_mode" text DEFAULT 'shadow' NOT NULL;--> statement-breakpoint
ALTER TABLE "container_usage_interval" ADD COLUMN "rate_cents_per_unit" numeric(24, 12);--> statement-breakpoint
ALTER TABLE "container_usage_interval" ADD COLUMN "settled_billable_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "compute_usage_charge" ADD CONSTRAINT "compute_usage_charge_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_usage_charge" ADD CONSTRAINT "compute_usage_charge_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_usage_charge" ADD CONSTRAINT "compute_usage_charge_cloud_billing_sku_id_cloud_billing_sku_id_fk" FOREIGN KEY ("cloud_billing_sku_id") REFERENCES "public"."cloud_billing_sku"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_compute_usage_charge_user_created" ON "compute_usage_charge" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_compute_usage_charge_organization_created" ON "compute_usage_charge" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "container_usage_interval" ADD CONSTRAINT "container_usage_interval_billing_mode" CHECK ("container_usage_interval"."billing_mode" IN ('shadow', 'paid'));--> statement-breakpoint
ALTER TABLE "container_usage_interval" ADD CONSTRAINT "container_usage_interval_paid_rate" CHECK (("container_usage_interval"."billing_mode" = 'shadow' AND "container_usage_interval"."rate_cents_per_unit" IS NULL) OR ("container_usage_interval"."billing_mode" = 'paid' AND "container_usage_interval"."rate_cents_per_unit" > 0));--> statement-breakpoint
ALTER TABLE "container_usage_interval" ADD CONSTRAINT "container_usage_interval_settled_billable_seconds_nonnegative" CHECK ("container_usage_interval"."settled_billable_seconds" >= 0 AND "container_usage_interval"."settled_billable_seconds" <= "container_usage_interval"."confirmed_seconds");
