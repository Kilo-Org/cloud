CREATE TABLE "kilo_pass_welcome_promo_store_payer_claims" (
	"payment_provider" text NOT NULL,
	"provider_payer_id" text NOT NULL,
	"source_provider_transaction_id" text NOT NULL,
	"source_provider_subscription_id" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"kilo_pass_subscription_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilo_pass_welcome_promo_store_payer_claims_payment_provider_provider_payer_id_pk" PRIMARY KEY("payment_provider","provider_payer_id"),
	CONSTRAINT "UQ_kilo_pass_welcome_promo_store_payer_claims_source_transaction" UNIQUE("payment_provider","source_provider_transaction_id"),
	CONSTRAINT "UQ_kilo_pass_welcome_promo_store_payer_claims_source_subscription" UNIQUE("payment_provider","source_provider_subscription_id"),
	CONSTRAINT "kilo_pass_welcome_promo_store_payer_claims_store_provider_check" CHECK ("kilo_pass_welcome_promo_store_payer_claims"."payment_provider" IN ('app_store', 'google_play')),
	CONSTRAINT "kilo_pass_welcome_promo_store_payer_claims_payment_provider_check" CHECK ("kilo_pass_welcome_promo_store_payer_claims"."payment_provider" IN ('stripe', 'app_store', 'google_play'))
);
--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" DROP CONSTRAINT "kilo_pass_issuances_initial_welcome_promo_reason_check";--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_welcome_promo_store_payer_claims_user" ON "kilo_pass_welcome_promo_store_payer_claims" USING btree ("kilo_user_id");--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD CONSTRAINT "kilo_pass_issuances_initial_welcome_promo_reason_check" CHECK ("kilo_pass_issuances"."initial_welcome_promo_eligibility_reason" IN ('first_payment_fingerprint_claim', 'fingerprint_previously_claimed', 'missing_fingerprint', 'no_supported_fingerprint', 'no_positive_settlement', 'settlement_unresolved', 'store_payer_first_claim', 'store_payer_previously_claimed', 'store_payer_unresolved'));