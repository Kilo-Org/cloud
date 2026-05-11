CREATE TABLE "deleted_user_email_tombstones" (
	"normalized_email_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "impact_advocate_participants" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"advocate_id" text NOT NULL,
	"advocate_account_id" text NOT NULL,
	"opaque_referral_identifier" text,
	"contact_email" text,
	"locale" text,
	"country_code" text,
	"registration_state" text DEFAULT 'pending' NOT NULL,
	"registered_at" timestamp with time zone,
	"last_registration_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_impact_advocate_participants_user_id" UNIQUE("user_id"),
	CONSTRAINT "UQ_impact_advocate_participants_opaque_referral_identifier" UNIQUE("opaque_referral_identifier"),
	CONSTRAINT "impact_advocate_participants_registration_state_check" CHECK ("impact_advocate_participants"."registration_state" IN ('pending', 'retrying', 'registered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "impact_advocate_registration_attempts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"opaque_cookie_value" text,
	"cookie_value_length" integer NOT NULL,
	"delivery_state" text DEFAULT 'queued' NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"response_status_code" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_impact_advocate_registration_attempts_dedupe_key" UNIQUE("dedupe_key"),
	CONSTRAINT "impact_advocate_registration_attempts_delivery_state_check" CHECK ("impact_advocate_registration_attempts"."delivery_state" IN ('queued', 'sending', 'succeeded', 'failed')),
	CONSTRAINT "impact_advocate_registration_attempts_cookie_value_length_non_negative_check" CHECK ("impact_advocate_registration_attempts"."cookie_value_length" >= 0),
	CONSTRAINT "impact_advocate_registration_attempts_attempt_count_non_negative_check" CHECK ("impact_advocate_registration_attempts"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "impact_advocate_reward_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"reward_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"beneficiary_user_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"impact_reward_id" text,
	"request_payload" jsonb,
	"lookup_response_payload" jsonb,
	"redeem_response_payload" jsonb,
	"response_status_code" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_impact_advocate_reward_redemptions_reward_id" UNIQUE("reward_id"),
	CONSTRAINT "UQ_impact_advocate_reward_redemptions_dedupe_key" UNIQUE("dedupe_key"),
	CONSTRAINT "impact_advocate_reward_redemptions_state_check" CHECK ("impact_advocate_reward_redemptions"."state" IN ('queued', 'retrying', 'redeemed', 'failed')),
	CONSTRAINT "impact_advocate_reward_redemptions_attempt_count_non_negative_check" CHECK ("impact_advocate_reward_redemptions"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "impact_conversion_reports" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"conversion_id" uuid,
	"dedupe_key" text NOT NULL,
	"action_tracker_id" integer NOT NULL,
	"order_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"response_status_code" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_impact_conversion_reports_dedupe_key" UNIQUE("dedupe_key"),
	CONSTRAINT "impact_conversion_reports_state_check" CHECK ("impact_conversion_reports"."state" IN ('queued', 'retrying', 'delivered', 'failed')),
	CONSTRAINT "impact_conversion_reports_attempt_count_non_negative_check" CHECK ("impact_conversion_reports"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_attribution_touches" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"anonymous_id" text,
	"user_id" text,
	"touch_type" text NOT NULL,
	"provider" text NOT NULL,
	"opaque_tracking_value" text,
	"tracking_value_length" integer NOT NULL,
	"is_tracking_value_accepted" boolean DEFAULT true NOT NULL,
	"rs_code" text,
	"rs_share_medium" text,
	"rs_engagement_medium" text,
	"im_ref" text,
	"landing_path" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"touched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sale_attributed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kiloclaw_attribution_touches_dedupe_key" UNIQUE("dedupe_key"),
	CONSTRAINT "kiloclaw_attribution_touches_touch_type_check" CHECK ("kiloclaw_attribution_touches"."touch_type" IN ('affiliate', 'referral')),
	CONSTRAINT "kiloclaw_attribution_touches_provider_check" CHECK ("kiloclaw_attribution_touches"."provider" IN ('impact_performance', 'impact_advocate')),
	CONSTRAINT "kiloclaw_attribution_touches_tracking_value_length_non_negative_check" CHECK ("kiloclaw_attribution_touches"."tracking_value_length" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_referral_conversions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"referee_user_id" text NOT NULL,
	"referrer_user_id" text,
	"source_touch_id" uuid,
	"winning_touch_type" text NOT NULL,
	"source_payment_id" text NOT NULL,
	"qualified" boolean DEFAULT false NOT NULL,
	"disqualification_reason" text,
	"converted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kiloclaw_referral_conversions_source_payment_id" UNIQUE("source_payment_id"),
	CONSTRAINT "kiloclaw_referral_conversions_winning_touch_type_check" CHECK ("kiloclaw_referral_conversions"."winning_touch_type" IN ('referral', 'affiliate', 'none'))
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_referral_reward_applications" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"reward_id" uuid NOT NULL,
	"beneficiary_user_id" text NOT NULL,
	"subscription_id" uuid,
	"previous_renewal_boundary" timestamp with time zone NOT NULL,
	"new_renewal_boundary" timestamp with time zone NOT NULL,
	"local_operation_id" text,
	"stripe_operation_id" text,
	"stripe_idempotency_key" text,
	"applied_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_referral_reward_decisions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"conversion_id" uuid NOT NULL,
	"beneficiary_user_id" text NOT NULL,
	"beneficiary_role" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"months_granted" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kiloclaw_referral_reward_decisions_conversion_role" UNIQUE("conversion_id","beneficiary_role"),
	CONSTRAINT "kiloclaw_referral_reward_decisions_beneficiary_role_check" CHECK ("kiloclaw_referral_reward_decisions"."beneficiary_role" IN ('referrer', 'referee')),
	CONSTRAINT "kiloclaw_referral_reward_decisions_outcome_check" CHECK ("kiloclaw_referral_reward_decisions"."outcome" IN ('granted', 'cap_limited', 'disqualified')),
	CONSTRAINT "kiloclaw_referral_reward_decisions_months_granted_non_negative_check" CHECK ("kiloclaw_referral_reward_decisions"."months_granted" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_referral_rewards" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"conversion_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"beneficiary_user_id" text NOT NULL,
	"beneficiary_role" text NOT NULL,
	"months_granted" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"applies_to_subscription_id" uuid,
	"earned_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kiloclaw_referral_rewards_conversion_role" UNIQUE("conversion_id","beneficiary_role"),
	CONSTRAINT "UQ_kiloclaw_referral_rewards_decision_id" UNIQUE("decision_id"),
	CONSTRAINT "kiloclaw_referral_rewards_beneficiary_role_check" CHECK ("kiloclaw_referral_rewards"."beneficiary_role" IN ('referrer', 'referee')),
	CONSTRAINT "kiloclaw_referral_rewards_status_check" CHECK ("kiloclaw_referral_rewards"."status" IN ('pending', 'earned', 'applied', 'reversed', 'expired', 'canceled', 'review_required')),
	CONSTRAINT "kiloclaw_referral_rewards_months_granted_positive_check" CHECK ("kiloclaw_referral_rewards"."months_granted" > 0)
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_referrals" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"referee_user_id" text NOT NULL,
	"referrer_user_id" text,
	"source_touch_id" uuid,
	"impact_referral_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_kiloclaw_referrals_referee_user_id" UNIQUE("referee_user_id")
);
--> statement-breakpoint
ALTER TABLE "impact_advocate_participants" ADD CONSTRAINT "impact_advocate_participants_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_advocate_registration_attempts" ADD CONSTRAINT "impact_advocate_registration_attempts_participant_id_impact_advocate_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."impact_advocate_participants"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_advocate_reward_redemptions" ADD CONSTRAINT "impact_advocate_reward_redemptions_reward_id_kiloclaw_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."kiloclaw_referral_rewards"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_advocate_reward_redemptions" ADD CONSTRAINT "impact_advocate_reward_redemptions_beneficiary_user_id_kilocode_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "impact_conversion_reports" ADD CONSTRAINT "impact_conversion_reports_conversion_id_kiloclaw_referral_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."kiloclaw_referral_conversions"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_attribution_touches" ADD CONSTRAINT "kiloclaw_attribution_touches_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_conversions" ADD CONSTRAINT "kiloclaw_referral_conversions_referee_user_id_kilocode_users_id_fk" FOREIGN KEY ("referee_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_conversions" ADD CONSTRAINT "kiloclaw_referral_conversions_referrer_user_id_kilocode_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_conversions" ADD CONSTRAINT "kiloclaw_referral_conversions_source_touch_id_kiloclaw_attribution_touches_id_fk" FOREIGN KEY ("source_touch_id") REFERENCES "public"."kiloclaw_attribution_touches"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_reward_applications" ADD CONSTRAINT "kiloclaw_referral_reward_applications_reward_id_kiloclaw_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."kiloclaw_referral_rewards"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_reward_applications" ADD CONSTRAINT "kiloclaw_referral_reward_applications_beneficiary_user_id_kilocode_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_reward_decisions" ADD CONSTRAINT "kiloclaw_referral_reward_decisions_conversion_id_kiloclaw_referral_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."kiloclaw_referral_conversions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_reward_decisions" ADD CONSTRAINT "kiloclaw_referral_reward_decisions_beneficiary_user_id_kilocode_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_rewards" ADD CONSTRAINT "kiloclaw_referral_rewards_conversion_id_kiloclaw_referral_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."kiloclaw_referral_conversions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_rewards" ADD CONSTRAINT "kiloclaw_referral_rewards_decision_id_kiloclaw_referral_reward_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."kiloclaw_referral_reward_decisions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referral_rewards" ADD CONSTRAINT "kiloclaw_referral_rewards_beneficiary_user_id_kilocode_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referrals" ADD CONSTRAINT "kiloclaw_referrals_referee_user_id_kilocode_users_id_fk" FOREIGN KEY ("referee_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referrals" ADD CONSTRAINT "kiloclaw_referrals_referrer_user_id_kilocode_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kiloclaw_referrals" ADD CONSTRAINT "kiloclaw_referrals_source_touch_id_kiloclaw_attribution_touches_id_fk" FOREIGN KEY ("source_touch_id") REFERENCES "public"."kiloclaw_attribution_touches"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "IDX_impact_advocate_participants_registration_state" ON "impact_advocate_participants" USING btree ("registration_state");--> statement-breakpoint
CREATE INDEX "IDX_impact_advocate_registration_attempts_participant_id" ON "impact_advocate_registration_attempts" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_advocate_registration_attempts_delivery_state" ON "impact_advocate_registration_attempts" USING btree ("delivery_state");--> statement-breakpoint
CREATE INDEX "IDX_impact_advocate_reward_redemptions_beneficiary_user_id" ON "impact_advocate_reward_redemptions" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_advocate_reward_redemptions_state" ON "impact_advocate_reward_redemptions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "IDX_impact_conversion_reports_conversion_id" ON "impact_conversion_reports" USING btree ("conversion_id");--> statement-breakpoint
CREATE INDEX "IDX_impact_conversion_reports_state" ON "impact_conversion_reports" USING btree ("state");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_attribution_touches_user_id" ON "kiloclaw_attribution_touches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_attribution_touches_anonymous_id" ON "kiloclaw_attribution_touches" USING btree ("anonymous_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_attribution_touches_expires_at" ON "kiloclaw_attribution_touches" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_attribution_touches_sale_attributed_at" ON "kiloclaw_attribution_touches" USING btree ("sale_attributed_at");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_referral_conversions_referee_user_id" ON "kiloclaw_referral_conversions" USING btree ("referee_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_referral_conversions_referrer_user_id" ON "kiloclaw_referral_conversions" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_referral_reward_applications_reward_id" ON "kiloclaw_referral_reward_applications" USING btree ("reward_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_referral_reward_applications_beneficiary_user_id" ON "kiloclaw_referral_reward_applications" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_referral_reward_decisions_beneficiary_user_id" ON "kiloclaw_referral_reward_decisions" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_referral_rewards_beneficiary_user_id" ON "kiloclaw_referral_rewards" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_referral_rewards_status" ON "kiloclaw_referral_rewards" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_referrals_referrer_user_id" ON "kiloclaw_referrals" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_referrals_source_touch_id" ON "kiloclaw_referrals" USING btree ("source_touch_id");