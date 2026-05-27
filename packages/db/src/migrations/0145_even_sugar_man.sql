CREATE TABLE "kilo_pass_welcome_promo_card_claims" (
	"stripe_fingerprint" text PRIMARY KEY NOT NULL,
	"source_stripe_invoice_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kilo_pass_welcome_promo_card_claims_source_invoice_id" UNIQUE("source_stripe_invoice_id")
);
--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD COLUMN "initial_welcome_promo_eligibility" text;--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD COLUMN "initial_welcome_promo_eligibility_reason" text;--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD CONSTRAINT "kilo_pass_issuances_initial_welcome_promo_eligibility_check" CHECK ("kilo_pass_issuances"."initial_welcome_promo_eligibility" IN ('eligible', 'ineligible'));--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD CONSTRAINT "kilo_pass_issuances_initial_welcome_promo_reason_check" CHECK ("kilo_pass_issuances"."initial_welcome_promo_eligibility_reason" IN ('first_card_claim', 'fingerprint_previously_claimed', 'missing_fingerprint', 'non_card_payment_method'));--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD CONSTRAINT "kilo_pass_issuances_initial_welcome_promo_decision_consistency_check" CHECK (("kilo_pass_issuances"."initial_welcome_promo_eligibility" IS NULL AND "kilo_pass_issuances"."initial_welcome_promo_eligibility_reason" IS NULL) OR ("kilo_pass_issuances"."initial_welcome_promo_eligibility" IS NOT NULL AND "kilo_pass_issuances"."initial_welcome_promo_eligibility_reason" IS NOT NULL));