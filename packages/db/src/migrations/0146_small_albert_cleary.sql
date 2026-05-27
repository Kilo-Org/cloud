ALTER TABLE "kilo_pass_issuances" DROP CONSTRAINT "kilo_pass_issuances_initial_welcome_promo_eligibility_check";--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" DROP CONSTRAINT "kilo_pass_issuances_initial_welcome_promo_decision_consistency_check";--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" DROP COLUMN "initial_welcome_promo_eligibility";