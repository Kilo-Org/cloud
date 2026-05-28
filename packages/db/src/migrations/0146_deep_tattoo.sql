CREATE TABLE "kilo_pass_welcome_promo_payment_fingerprint_claims" (
	"stripe_payment_method_type" text NOT NULL,
	"stripe_fingerprint" text NOT NULL,
	"source_stripe_invoice_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilo_pass_welcome_promo_payment_fingerprint_claims_stripe_payment_method_type_stripe_fingerprint_pk" PRIMARY KEY("stripe_payment_method_type","stripe_fingerprint"),
	CONSTRAINT "UQ_kilo_pass_welcome_promo_payment_fingerprint_claims_source_invoice_id" UNIQUE("source_stripe_invoice_id"),
	CONSTRAINT "kilo_pass_welcome_promo_payment_fingerprint_claims_type_check" CHECK ("kilo_pass_welcome_promo_payment_fingerprint_claims"."stripe_payment_method_type" IN ('card', 'sepa_debit', 'us_bank_account', 'bacs_debit', 'au_becs_debit'))
);
--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD COLUMN "initial_welcome_promo_eligibility_reason" text;--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD CONSTRAINT "kilo_pass_issuances_initial_welcome_promo_reason_check" CHECK ("kilo_pass_issuances"."initial_welcome_promo_eligibility_reason" IN ('first_payment_fingerprint_claim', 'fingerprint_previously_claimed', 'missing_fingerprint', 'no_supported_fingerprint', 'no_positive_settlement', 'settlement_unresolved'));