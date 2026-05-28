ALTER TABLE "kiloclaw_attribution_touches" RENAME TO "impact_attribution_touches";--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_conversions" RENAME TO "impact_referral_conversions";--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_reward_applications" RENAME TO "impact_referral_reward_applications";--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_reward_decisions" RENAME TO "impact_referral_reward_decisions";--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_rewards" RENAME TO "impact_referral_rewards";--> statement-breakpoint
ALTER TABLE "kiloclaw_referrals" RENAME TO "impact_referrals";--> statement-breakpoint
ALTER TABLE "impact_advocate_participants" DROP CONSTRAINT "UQ_impact_advocate_participants_user_id";--> statement-breakpoint
ALTER TABLE "impact_advocate_participants" DROP CONSTRAINT "UQ_impact_advocate_participants_opaque_referral_identifier";--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" DROP CONSTRAINT "UQ_kiloclaw_attribution_touches_dedupe_key";--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" DROP CONSTRAINT "UQ_kiloclaw_referral_conversions_source_payment_id";--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" DROP CONSTRAINT "UQ_kiloclaw_referral_reward_decisions_conversion_role";--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" DROP CONSTRAINT "UQ_kiloclaw_referral_rewards_conversion_role";--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" DROP CONSTRAINT "UQ_kiloclaw_referral_rewards_decision_id";--> statement-breakpoint
ALTER TABLE "impact_referrals" DROP CONSTRAINT "UQ_kiloclaw_referrals_referee_user_id";--> statement-breakpoint
ALTER TABLE "kilo_pass_issuance_items" DROP CONSTRAINT "kilo_pass_issuance_items_kind_check";--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" DROP CONSTRAINT "kiloclaw_attribution_touches_touch_type_check";--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" DROP CONSTRAINT "kiloclaw_attribution_touches_provider_check";--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" DROP CONSTRAINT "kiloclaw_attribution_touches_tracking_value_length_non_negative_check";--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" DROP CONSTRAINT "kiloclaw_referral_conversions_winning_touch_type_check";--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" DROP CONSTRAINT "kiloclaw_referral_reward_decisions_beneficiary_role_check";--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" DROP CONSTRAINT "kiloclaw_referral_reward_decisions_outcome_check";--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" DROP CONSTRAINT "kiloclaw_referral_reward_decisions_months_granted_non_negative_check";--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" DROP CONSTRAINT "kiloclaw_referral_rewards_beneficiary_role_check";--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" DROP CONSTRAINT "kiloclaw_referral_rewards_status_check";--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" DROP CONSTRAINT "kiloclaw_referral_rewards_months_granted_positive_check";--> statement-breakpoint
ALTER TABLE "impact_advocate_reward_redemptions" DROP CONSTRAINT "impact_advocate_reward_redemptions_reward_id_kiloclaw_referral_rewards_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_conversion_reports" DROP CONSTRAINT "impact_conversion_reports_conversion_id_kiloclaw_referral_conversions_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" DROP CONSTRAINT "kiloclaw_attribution_touches_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" DROP CONSTRAINT "kiloclaw_referral_conversions_referee_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" DROP CONSTRAINT "kiloclaw_referral_conversions_referrer_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" DROP CONSTRAINT "kiloclaw_referral_conversions_source_touch_id_kiloclaw_attribution_touches_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_reward_applications" DROP CONSTRAINT "kiloclaw_referral_reward_applications_reward_id_kiloclaw_referral_rewards_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_reward_applications" DROP CONSTRAINT "kiloclaw_referral_reward_applications_beneficiary_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" DROP CONSTRAINT "kiloclaw_referral_reward_decisions_conversion_id_kiloclaw_referral_conversions_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" DROP CONSTRAINT "kiloclaw_referral_reward_decisions_beneficiary_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" DROP CONSTRAINT "kiloclaw_referral_rewards_conversion_id_kiloclaw_referral_conversions_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" DROP CONSTRAINT "kiloclaw_referral_rewards_decision_id_kiloclaw_referral_reward_decisions_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" DROP CONSTRAINT "kiloclaw_referral_rewards_beneficiary_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referrals" DROP CONSTRAINT "kiloclaw_referrals_referee_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referrals" DROP CONSTRAINT "kiloclaw_referrals_referrer_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "impact_referrals" DROP CONSTRAINT "kiloclaw_referrals_source_touch_id_kiloclaw_attribution_touches_id_fk";
--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_attribution_touches_user_id";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_attribution_touches_anonymous_id";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_attribution_touches_expires_at";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_attribution_touches_sale_attributed_at";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_referral_conversions_referee_user_id";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_referral_conversions_referrer_user_id";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_referral_reward_applications_reward_id";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_referral_reward_applications_beneficiary_user_id";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_referral_reward_decisions_beneficiary_user_id";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_referral_rewards_beneficiary_user_id";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_referral_rewards_status";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_referrals_referrer_user_id";--> statement-breakpoint
DROP INDEX "IDX_kiloclaw_referrals_source_touch_id";--> statement-breakpoint
ALTER TABLE "impact_advocate_participants" ADD COLUMN "program_key" text DEFAULT 'kiloclaw' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_advocate_registration_attempts" ADD COLUMN "program_key" text DEFAULT 'kiloclaw' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" ADD COLUMN "product" text DEFAULT 'kiloclaw' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" ADD COLUMN "program_key" text DEFAULT 'kiloclaw';--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" ADD COLUMN "product" text DEFAULT 'kiloclaw' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" ADD COLUMN "payment_provider" text DEFAULT 'credits' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_referral_reward_applications" ADD COLUMN "product" text DEFAULT 'kiloclaw' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD COLUMN "product" text DEFAULT 'kiloclaw' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD COLUMN "reward_kind" text DEFAULT 'kiloclaw_free_month' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD COLUMN "reward_percent" numeric(6, 4);--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD COLUMN "source_tier" text;--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD COLUMN "reward_amount_usd" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD COLUMN "product" text DEFAULT 'kiloclaw' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD COLUMN "reward_kind" text DEFAULT 'kiloclaw_free_month' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD COLUMN "reward_percent" numeric(6, 4);--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD COLUMN "source_tier" text;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD COLUMN "reward_amount_usd" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD COLUMN "applies_to_kilo_pass_subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD COLUMN "consumed_kilo_pass_issuance_id" uuid;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD COLUMN "consumed_kilo_pass_issuance_item_id" uuid;--> statement-breakpoint
ALTER TABLE "impact_referrals" ADD COLUMN "product" text DEFAULT 'kiloclaw' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_advocate_reward_redemptions" ADD CONSTRAINT "impact_advocate_reward_redemptions_reward_id_impact_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."impact_referral_rewards"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_conversion_reports" ADD CONSTRAINT "impact_conversion_reports_conversion_id_impact_referral_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."impact_referral_conversions"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" ADD CONSTRAINT "impact_attribution_touches_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" ADD CONSTRAINT "impact_referral_conversions_referee_user_id_kilocode_users_id_fk" FOREIGN KEY ("referee_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" ADD CONSTRAINT "impact_referral_conversions_referrer_user_id_kilocode_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" ADD CONSTRAINT "impact_referral_conversions_source_touch_id_impact_attribution_touches_id_fk" FOREIGN KEY ("source_touch_id") REFERENCES "public"."impact_attribution_touches"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_reward_applications" ADD CONSTRAINT "impact_referral_reward_applications_reward_id_impact_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."impact_referral_rewards"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_reward_applications" ADD CONSTRAINT "impact_referral_reward_applications_beneficiary_user_id_kilocode_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD CONSTRAINT "impact_referral_reward_decisions_conversion_id_impact_referral_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."impact_referral_conversions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD CONSTRAINT "impact_referral_reward_decisions_beneficiary_user_id_kilocode_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "impact_referral_rewards_conversion_id_impact_referral_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."impact_referral_conversions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "impact_referral_rewards_decision_id_impact_referral_reward_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."impact_referral_reward_decisions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "impact_referral_rewards_beneficiary_user_id_kilocode_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "FK_impact_referral_rewards_kilo_pass_subscription" FOREIGN KEY ("applies_to_kilo_pass_subscription_id") REFERENCES "public"."kilo_pass_subscriptions"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "FK_impact_referral_rewards_kilo_pass_issuance" FOREIGN KEY ("consumed_kilo_pass_issuance_id") REFERENCES "public"."kilo_pass_issuances"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "FK_impact_referral_rewards_kilo_pass_issuance_item" FOREIGN KEY ("consumed_kilo_pass_issuance_item_id") REFERENCES "public"."kilo_pass_issuance_items"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referrals" ADD CONSTRAINT "impact_referrals_referee_user_id_kilocode_users_id_fk" FOREIGN KEY ("referee_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referrals" ADD CONSTRAINT "impact_referrals_referrer_user_id_kilocode_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_referrals" ADD CONSTRAINT "impact_referrals_source_touch_id_impact_attribution_touches_id_fk" FOREIGN KEY ("source_touch_id") REFERENCES "public"."impact_attribution_touches"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_impact_advocate_participants_program_referral_identifier" ON "impact_advocate_participants" USING btree ("program_key","opaque_referral_identifier") WHERE "impact_advocate_participants"."opaque_referral_identifier" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_impact_attribution_touches_product_user_id" ON "impact_attribution_touches" USING btree ("product","user_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_attribution_touches_user_id" ON "impact_attribution_touches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_attribution_touches_anonymous_id" ON "impact_attribution_touches" USING btree ("anonymous_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_attribution_touches_expires_at" ON "impact_attribution_touches" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_impact_attribution_touches_sale_attributed_at" ON "impact_attribution_touches" USING btree ("sale_attributed_at");--> statement-breakpoint
CREATE INDEX "IDX_impact_referral_conversions_referee_user_id" ON "impact_referral_conversions" USING btree ("referee_user_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_referral_conversions_referrer_user_id" ON "impact_referral_conversions" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_referral_reward_applications_reward_id" ON "impact_referral_reward_applications" USING btree ("reward_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_referral_reward_applications_beneficiary_user_id" ON "impact_referral_reward_applications" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_referral_reward_decisions_beneficiary_user_id" ON "impact_referral_reward_decisions" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_referral_rewards_beneficiary_user_id" ON "impact_referral_rewards" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_referral_rewards_status" ON "impact_referral_rewards" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_impact_referrals_referrer_user_id" ON "impact_referrals" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_referrals_source_touch_id" ON "impact_referrals" USING btree ("source_touch_id");--> statement-breakpoint
ALTER TABLE "impact_advocate_participants" ADD CONSTRAINT "UQ_impact_advocate_participants_program_user" UNIQUE("program_key","user_id");--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" ADD CONSTRAINT "UQ_impact_attribution_touches_dedupe_key" UNIQUE("dedupe_key");--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" ADD CONSTRAINT "UQ_impact_referral_conversions_product_payment_source" UNIQUE("product","payment_provider","source_payment_id");--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD CONSTRAINT "UQ_impact_referral_reward_decisions_conversion_role" UNIQUE("conversion_id","beneficiary_role");--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "UQ_impact_referral_rewards_conversion_role" UNIQUE("conversion_id","beneficiary_role");--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "UQ_impact_referral_rewards_decision_id" UNIQUE("decision_id");--> statement-breakpoint
ALTER TABLE "impact_referrals" ADD CONSTRAINT "UQ_impact_referrals_product_referee_user_id" UNIQUE("product","referee_user_id");--> statement-breakpoint
ALTER TABLE "impact_advocate_participants" ADD CONSTRAINT "impact_advocate_participants_program_key_check" CHECK ("impact_advocate_participants"."program_key" IN ('kiloclaw', 'kilo_pass'));--> statement-breakpoint
ALTER TABLE "impact_advocate_registration_attempts" ADD CONSTRAINT "impact_advocate_registration_attempts_program_key_check" CHECK ("impact_advocate_registration_attempts"."program_key" IN ('kiloclaw', 'kilo_pass'));--> statement-breakpoint
ALTER TABLE "kilo_pass_issuance_items" ADD CONSTRAINT "kilo_pass_issuance_items_kind_check" CHECK ("kilo_pass_issuance_items"."kind" IN ('base', 'bonus', 'promo_first_month_50pct', 'referral_bonus'));--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" ADD CONSTRAINT "impact_attribution_touches_product_check" CHECK ("impact_attribution_touches"."product" IN ('kiloclaw', 'kilo_pass'));--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" ADD CONSTRAINT "impact_attribution_touches_program_key_check" CHECK ("impact_attribution_touches"."program_key" IN ('kiloclaw', 'kilo_pass'));--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" ADD CONSTRAINT "impact_attribution_touches_touch_type_check" CHECK ("impact_attribution_touches"."touch_type" IN ('affiliate', 'referral'));--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" ADD CONSTRAINT "impact_attribution_touches_provider_check" CHECK ("impact_attribution_touches"."provider" IN ('impact_performance', 'impact_advocate'));--> statement-breakpoint
ALTER TABLE "impact_attribution_touches" ADD CONSTRAINT "impact_attribution_touches_tracking_value_length_non_negative_check" CHECK ("impact_attribution_touches"."tracking_value_length" >= 0);--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" ADD CONSTRAINT "impact_referral_conversions_product_check" CHECK ("impact_referral_conversions"."product" IN ('kiloclaw', 'kilo_pass'));--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" ADD CONSTRAINT "impact_referral_conversions_winning_touch_type_check" CHECK ("impact_referral_conversions"."winning_touch_type" IN ('referral', 'affiliate', 'none'));--> statement-breakpoint
ALTER TABLE "impact_referral_conversions" ADD CONSTRAINT "impact_referral_conversions_payment_provider_check" CHECK ("impact_referral_conversions"."payment_provider" IN ('stripe', 'credits', 'app_store', 'google_play'));--> statement-breakpoint
ALTER TABLE "impact_referral_reward_applications" ADD CONSTRAINT "impact_referral_reward_applications_product_check" CHECK ("impact_referral_reward_applications"."product" IN ('kiloclaw', 'kilo_pass'));--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD CONSTRAINT "impact_referral_reward_decisions_product_check" CHECK ("impact_referral_reward_decisions"."product" IN ('kiloclaw', 'kilo_pass'));--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD CONSTRAINT "impact_referral_reward_decisions_beneficiary_role_check" CHECK ("impact_referral_reward_decisions"."beneficiary_role" IN ('referrer', 'referee'));--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD CONSTRAINT "impact_referral_reward_decisions_outcome_check" CHECK ("impact_referral_reward_decisions"."outcome" IN ('granted', 'cap_limited', 'disqualified'));--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD CONSTRAINT "impact_referral_reward_decisions_reward_kind_check" CHECK ("impact_referral_reward_decisions"."reward_kind" IN ('kiloclaw_free_month', 'kilo_pass_bonus'));--> statement-breakpoint
ALTER TABLE "impact_referral_reward_decisions" ADD CONSTRAINT "impact_referral_reward_decisions_months_granted_non_negative_check" CHECK ("impact_referral_reward_decisions"."months_granted" >= 0);--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "impact_referral_rewards_product_check" CHECK ("impact_referral_rewards"."product" IN ('kiloclaw', 'kilo_pass'));--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "impact_referral_rewards_beneficiary_role_check" CHECK ("impact_referral_rewards"."beneficiary_role" IN ('referrer', 'referee'));--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "impact_referral_rewards_reward_kind_check" CHECK ("impact_referral_rewards"."reward_kind" IN ('kiloclaw_free_month', 'kilo_pass_bonus'));--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "impact_referral_rewards_status_check" CHECK ("impact_referral_rewards"."status" IN ('pending', 'earned', 'applied', 'reversed', 'expired', 'canceled', 'review_required'));--> statement-breakpoint
ALTER TABLE "impact_referral_rewards" ADD CONSTRAINT "impact_referral_rewards_months_granted_non_negative_check" CHECK ("impact_referral_rewards"."months_granted" >= 0);--> statement-breakpoint
ALTER TABLE "impact_referrals" ADD CONSTRAINT "impact_referrals_product_check" CHECK ("impact_referrals"."product" IN ('kiloclaw', 'kilo_pass'));--> statement-breakpoint
UPDATE "impact_referral_conversions" SET "payment_provider" = 'stripe' WHERE "product" = 'kiloclaw' AND "source_payment_id" LIKE 'in\_%' ESCAPE '\';
