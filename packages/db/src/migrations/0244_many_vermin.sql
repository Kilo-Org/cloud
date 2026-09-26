ALTER TABLE "stripe_service_fee_assessments" DROP CONSTRAINT "stripe_service_fee_assessments_charged_check";--> statement-breakpoint
ALTER TABLE "stripe_service_fee_assessments" ADD COLUMN "stripe_invoice_fee_item_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_stripe_service_fee_assessments_invoice_fee_item_id" ON "stripe_service_fee_assessments" USING btree ("stripe_invoice_fee_item_id") WHERE "stripe_service_fee_assessments"."stripe_invoice_fee_item_id" is not null;--> statement-breakpoint
ALTER TABLE "stripe_service_fee_assessments" ADD CONSTRAINT "stripe_service_fee_assessments_charged_check" CHECK ("stripe_service_fee_assessments"."outcome" <> 'charged' OR (
        (
          "stripe_service_fee_assessments"."stripe_invoice_fee_item_id" IS NOT NULL
          OR "stripe_service_fee_assessments"."stripe_invoice_fee_line_item_id" IS NOT NULL
          OR "stripe_service_fee_assessments"."stripe_checkout_fee_line_item_id" IS NOT NULL
          OR "stripe_service_fee_assessments"."settled_at" IS NOT NULL
        )
        AND ("stripe_service_fee_assessments"."charged_fee_minor" <> 0 OR "stripe_service_fee_assessments"."settled_product_minor" = 0)
      ));-->  statement-breakpoint
UPDATE "stripe_service_fee_assessments"
SET
	"stripe_invoice_fee_item_id" = "stripe_invoice_fee_line_item_id",
	"stripe_invoice_fee_line_item_id" = NULL
WHERE "stripe_invoice_fee_line_item_id" LIKE 'ii\_%' ESCAPE '\';
