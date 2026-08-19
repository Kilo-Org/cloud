CREATE TABLE "organization_service_fee_exemptions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"is_exempt" boolean NOT NULL,
	"reason" text NOT NULL,
	"changed_by_kilo_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_service_fee_exemptions_reason_check" CHECK (length(trim("organization_service_fee_exemptions"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_service_fee_assessments" (
	"assessment_key" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"flow" text NOT NULL,
	"outcome" text NOT NULL,
	"currency" text NOT NULL,
	"kilo_user_id" text,
	"organization_id" uuid,
	"stripe_customer_id" text,
	"stripe_checkout_session_id" text,
	"stripe_invoice_id" text,
	"stripe_payment_intent_id" text,
	"stripe_charge_id" text,
	"stripe_fee_price_id" text,
	"stripe_checkout_fee_line_item_id" text,
	"stripe_invoice_fee_line_item_id" text,
	"eligibility_created_at" timestamp with time zone NOT NULL,
	"eligible_subtotal_minor" integer NOT NULL,
	"expected_fee_minor" integer NOT NULL,
	"charged_fee_minor" integer DEFAULT 0 NOT NULL,
	"gross_paid_minor" integer DEFAULT 0 NOT NULL,
	"settled_product_minor" integer DEFAULT 0 NOT NULL,
	"refunded_product_minor" integer DEFAULT 0 NOT NULL,
	"refunded_fee_minor" integer DEFAULT 0 NOT NULL,
	"refunded_gross_minor" integer DEFAULT 0 NOT NULL,
	"disputed_product_minor" integer DEFAULT 0 NOT NULL,
	"disputed_fee_minor" integer DEFAULT 0 NOT NULL,
	"settled_at" timestamp with time zone,
	"exemption_id" uuid,
	"failure_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_service_fee_assessments_flow_check" CHECK ("stripe_service_fee_assessments"."flow" IN ('personal_top_up', 'organization_top_up', 'personal_auto_top_up_setup', 'organization_auto_top_up_setup', 'personal_auto_top_up', 'organization_auto_top_up', 'personal_kilo_pass', 'organization_kilo_pass')),
	CONSTRAINT "stripe_service_fee_assessments_outcome_check" CHECK ("stripe_service_fee_assessments"."outcome" IN ('pending', 'charged', 'exempt', 'pre_activation', 'zero_rounded', 'unsupported_currency', 'missed')),
	CONSTRAINT "stripe_service_fee_assessments_currency_check" CHECK ("stripe_service_fee_assessments"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "stripe_service_fee_assessments_owner_check" CHECK ((
        "stripe_service_fee_assessments"."flow" LIKE 'personal_%'
        AND "stripe_service_fee_assessments"."kilo_user_id" IS NOT NULL
        AND "stripe_service_fee_assessments"."organization_id" IS NULL
      ) OR (
        "stripe_service_fee_assessments"."flow" LIKE 'organization_%'
        AND "stripe_service_fee_assessments"."organization_id" IS NOT NULL
      )),
	CONSTRAINT "stripe_service_fee_assessments_amounts_nonnegative_check" CHECK ("stripe_service_fee_assessments"."eligible_subtotal_minor" >= 0
        AND "stripe_service_fee_assessments"."expected_fee_minor" >= 0
        AND "stripe_service_fee_assessments"."charged_fee_minor" >= 0
        AND "stripe_service_fee_assessments"."gross_paid_minor" >= 0
        AND "stripe_service_fee_assessments"."settled_product_minor" >= 0
        AND "stripe_service_fee_assessments"."refunded_product_minor" >= 0
        AND "stripe_service_fee_assessments"."refunded_fee_minor" >= 0
        AND "stripe_service_fee_assessments"."refunded_gross_minor" >= 0
        AND "stripe_service_fee_assessments"."disputed_product_minor" >= 0
        AND "stripe_service_fee_assessments"."disputed_fee_minor" >= 0),
	CONSTRAINT "stripe_service_fee_assessments_refund_fee_check" CHECK ("stripe_service_fee_assessments"."refunded_fee_minor" <= "stripe_service_fee_assessments"."charged_fee_minor"),
	CONSTRAINT "stripe_service_fee_assessments_refund_product_check" CHECK ("stripe_service_fee_assessments"."refunded_product_minor" <= "stripe_service_fee_assessments"."settled_product_minor"),
	CONSTRAINT "stripe_service_fee_assessments_disputed_fee_check" CHECK ("stripe_service_fee_assessments"."disputed_fee_minor" <= "stripe_service_fee_assessments"."charged_fee_minor"),
	CONSTRAINT "stripe_service_fee_assessments_disputed_product_check" CHECK ("stripe_service_fee_assessments"."disputed_product_minor" <= "stripe_service_fee_assessments"."settled_product_minor"),
	CONSTRAINT "stripe_service_fee_assessments_pending_check" CHECK ("stripe_service_fee_assessments"."outcome" <> 'pending'
        OR ("stripe_service_fee_assessments"."charged_fee_minor" = 0 AND "stripe_service_fee_assessments"."settled_at" IS NULL)),
	CONSTRAINT "stripe_service_fee_assessments_charged_check" CHECK ("stripe_service_fee_assessments"."outcome" <> 'charged' OR (
        (
          "stripe_service_fee_assessments"."stripe_invoice_fee_line_item_id" IS NOT NULL
          OR "stripe_service_fee_assessments"."stripe_checkout_fee_line_item_id" IS NOT NULL
          OR "stripe_service_fee_assessments"."settled_at" IS NOT NULL
        )
        AND ("stripe_service_fee_assessments"."charged_fee_minor" <> 0 OR "stripe_service_fee_assessments"."settled_product_minor" = 0)
      )),
	CONSTRAINT "stripe_service_fee_assessments_missed_check" CHECK ("stripe_service_fee_assessments"."outcome" <> 'missed' OR (
        "stripe_service_fee_assessments"."expected_fee_minor" > 0
        AND "stripe_service_fee_assessments"."charged_fee_minor" = 0
        AND "stripe_service_fee_assessments"."failure_code" IS NOT NULL
        AND length(trim("stripe_service_fee_assessments"."failure_code")) > 0
      )),
	CONSTRAINT "stripe_service_fee_assessments_zero_rounded_check" CHECK ("stripe_service_fee_assessments"."outcome" <> 'zero_rounded' OR "stripe_service_fee_assessments"."expected_fee_minor" = 0),
	CONSTRAINT "stripe_service_fee_assessments_uncharged_outcome_check" CHECK ("stripe_service_fee_assessments"."outcome" NOT IN ('exempt', 'pre_activation', 'zero_rounded', 'unsupported_currency')
        OR "stripe_service_fee_assessments"."charged_fee_minor" = 0),
	CONSTRAINT "stripe_service_fee_assessments_exemption_check" CHECK (("stripe_service_fee_assessments"."outcome" = 'exempt') = ("stripe_service_fee_assessments"."exemption_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "organization_service_fee_exemptions" ADD CONSTRAINT "FK_org_svc_fee_exemptions_organization" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "organization_service_fee_exemptions" ADD CONSTRAINT "FK_org_svc_fee_exemptions_changed_by" FOREIGN KEY ("changed_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stripe_service_fee_assessments" ADD CONSTRAINT "FK_stripe_svc_fee_assessments_kilo_user" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stripe_service_fee_assessments" ADD CONSTRAINT "FK_stripe_svc_fee_assessments_organization" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stripe_service_fee_assessments" ADD CONSTRAINT "FK_stripe_svc_fee_assessments_exemption" FOREIGN KEY ("exemption_id") REFERENCES "public"."organization_service_fee_exemptions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "IDX_org_service_fee_exemptions_org_created_at" ON "organization_service_fee_exemptions" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "IDX_stripe_service_fee_assessments_stripe_customer_id" ON "stripe_service_fee_assessments" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_stripe_service_fee_assessments_checkout_session_id" ON "stripe_service_fee_assessments" USING btree ("stripe_checkout_session_id") WHERE "stripe_service_fee_assessments"."stripe_checkout_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_stripe_service_fee_assessments_stripe_invoice_id" ON "stripe_service_fee_assessments" USING btree ("stripe_invoice_id") WHERE "stripe_service_fee_assessments"."stripe_invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_stripe_service_fee_assessments_stripe_payment_intent_id" ON "stripe_service_fee_assessments" USING btree ("stripe_payment_intent_id") WHERE "stripe_service_fee_assessments"."stripe_payment_intent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_stripe_service_fee_assessments_stripe_charge_id" ON "stripe_service_fee_assessments" USING btree ("stripe_charge_id") WHERE "stripe_service_fee_assessments"."stripe_charge_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_stripe_service_fee_assessments_checkout_fee_line_item_id" ON "stripe_service_fee_assessments" USING btree ("stripe_checkout_fee_line_item_id") WHERE "stripe_service_fee_assessments"."stripe_checkout_fee_line_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_stripe_service_fee_assessments_invoice_fee_line_item_id" ON "stripe_service_fee_assessments" USING btree ("stripe_invoice_fee_line_item_id") WHERE "stripe_service_fee_assessments"."stripe_invoice_fee_line_item_id" is not null;