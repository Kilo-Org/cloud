ALTER TABLE "kiloclaw_earlybird_purchases" ALTER COLUMN "stripe_charge_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_earlybird_purchases" ADD COLUMN "manual_payment_id" text;--> statement-breakpoint
ALTER TABLE "kiloclaw_earlybird_purchases" ADD CONSTRAINT "kiloclaw_earlybird_purchases_manual_payment_id_unique" UNIQUE("manual_payment_id");