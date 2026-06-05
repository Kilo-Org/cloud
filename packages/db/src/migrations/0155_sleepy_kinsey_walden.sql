CREATE TABLE "kilo_pass_accepted_card_purchases" (
	"stripe_invoice_id" text PRIMARY KEY NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"fingerprint_digest" text NOT NULL,
	"purchased_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_accepted_card_purchases_stripe_subscription_id" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "kilo_pass_accepted_card_purchases_digest_format_check" CHECK ("kilo_pass_accepted_card_purchases"."fingerprint_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_accepted_card_purchases_digest_purchase_invoice" ON "kilo_pass_accepted_card_purchases" USING btree ("fingerprint_digest","purchased_at","stripe_invoice_id");