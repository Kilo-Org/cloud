CREATE TABLE "kilo_pass_store_events" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"payment_provider" text NOT NULL,
	"event_id" text NOT NULL,
	"provider_subscription_id" text,
	"provider_transaction_id" text,
	"app_account_token" uuid,
	"product_id" text NOT NULL,
	"environment" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilo_pass_store_events_payment_provider_check" CHECK ("kilo_pass_store_events"."payment_provider" IN ('stripe', 'app_store', 'google_play'))
);
--> statement-breakpoint
CREATE TABLE "kilo_pass_store_purchases" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_pass_subscription_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"payment_provider" text NOT NULL,
	"product_id" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"provider_original_transaction_id" text,
	"app_account_token" uuid,
	"purchase_token" text,
	"environment" text NOT NULL,
	"purchased_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"raw_payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilo_pass_store_purchases_store_provider_check" CHECK ("kilo_pass_store_purchases"."payment_provider" IN ('app_store', 'google_play')),
	CONSTRAINT "kilo_pass_store_purchases_payment_provider_check" CHECK ("kilo_pass_store_purchases"."payment_provider" IN ('stripe', 'app_store', 'google_play'))
);
--> statement-breakpoint
ALTER TABLE "kilo_pass_audit_log" DROP CONSTRAINT "kilo_pass_audit_log_action_check";--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" DROP CONSTRAINT "kilo_pass_issuances_source_check";--> statement-breakpoint
ALTER TABLE "kilo_pass_subscriptions" ALTER COLUMN "stripe_subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kilo_pass_subscriptions" ADD COLUMN "payment_provider" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "kilo_pass_subscriptions" ADD COLUMN "provider_subscription_id" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "kilo_pass_subscriptions"
    WHERE "payment_provider" = 'stripe'
      AND "stripe_subscription_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'kilo_pass_subscriptions contains Stripe rows without stripe_subscription_id';
  END IF;
END $$;--> statement-breakpoint
UPDATE "kilo_pass_subscriptions"
SET "provider_subscription_id" = "stripe_subscription_id"
WHERE "payment_provider" = 'stripe'
  AND "stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD COLUMN "app_store_account_token" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "kilo_pass_store_purchases" ADD CONSTRAINT "kilo_pass_store_purchases_kilo_pass_subscription_id_kilo_pass_subscriptions_id_fk" FOREIGN KEY ("kilo_pass_subscription_id") REFERENCES "public"."kilo_pass_subscriptions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_store_purchases" ADD CONSTRAINT "kilo_pass_store_purchases_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_store_events_provider_event" ON "kilo_pass_store_events" USING btree ("payment_provider","event_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_store_events_provider_subscription" ON "kilo_pass_store_events" USING btree ("payment_provider","provider_subscription_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_store_events_app_account_token" ON "kilo_pass_store_events" USING btree ("app_account_token");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_store_purchases_provider_transaction" ON "kilo_pass_store_purchases" USING btree ("payment_provider","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_store_purchases_subscription_id" ON "kilo_pass_store_purchases" USING btree ("kilo_pass_subscription_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_store_purchases_user_id" ON "kilo_pass_store_purchases" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_store_purchases_app_account_token" ON "kilo_pass_store_purchases" USING btree ("app_account_token");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_store_purchases_latest_subscription_purchase" ON "kilo_pass_store_purchases" USING btree ("payment_provider","provider_subscription_id","purchased_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_subscriptions_payment_provider" ON "kilo_pass_subscriptions" USING btree ("payment_provider");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_subscriptions_provider_subscription" ON "kilo_pass_subscriptions" USING btree ("payment_provider","provider_subscription_id") WHERE "kilo_pass_subscriptions"."provider_subscription_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_subscriptions_store_purchase_reference" ON "kilo_pass_subscriptions" USING btree ("id","kilo_user_id","payment_provider","provider_subscription_id");--> statement-breakpoint
ALTER TABLE "kilo_pass_store_purchases" ADD CONSTRAINT "FK_kilo_pass_store_purchases_subscription_owner_provider" FOREIGN KEY ("kilo_pass_subscription_id","kilo_user_id","payment_provider","provider_subscription_id") REFERENCES "public"."kilo_pass_subscriptions"("id","kilo_user_id","payment_provider","provider_subscription_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD CONSTRAINT "kilocode_users_app_store_account_token_unique" UNIQUE("app_store_account_token");--> statement-breakpoint
ALTER TABLE "kilo_pass_audit_log" ADD CONSTRAINT "kilo_pass_audit_log_action_check" CHECK ("kilo_pass_audit_log"."action" IN ('stripe_webhook_received', 'kilo_pass_invoice_paid_handled', 'store_purchase_completed', 'store_notification_received', 'store_subscription_renewed', 'store_subscription_canceled', 'store_subscription_expired', 'store_subscription_refunded', 'base_credits_issued', 'bonus_credits_issued', 'bonus_credits_skipped_idempotent', 'first_month_50pct_promo_issued', 'yearly_monthly_base_cron_started', 'yearly_monthly_base_cron_completed', 'issue_yearly_remaining_credits', 'yearly_monthly_bonus_cron_started', 'yearly_monthly_bonus_cron_completed'));--> statement-breakpoint
ALTER TABLE "kilo_pass_issuances" ADD CONSTRAINT "kilo_pass_issuances_source_check" CHECK ("kilo_pass_issuances"."source" IN ('stripe_invoice', 'app_store_transaction', 'google_play_transaction', 'cron'));--> statement-breakpoint
ALTER TABLE "kilo_pass_subscriptions" ADD CONSTRAINT "kilo_pass_subscriptions_provider_ids_check" CHECK ((
        "kilo_pass_subscriptions"."payment_provider" = 'stripe'
        AND "kilo_pass_subscriptions"."provider_subscription_id" IS NOT NULL
        AND "kilo_pass_subscriptions"."stripe_subscription_id" IS NOT NULL
        AND "kilo_pass_subscriptions"."provider_subscription_id" = "kilo_pass_subscriptions"."stripe_subscription_id"
      ) OR (
        "kilo_pass_subscriptions"."payment_provider" IN ('app_store', 'google_play')
        AND "kilo_pass_subscriptions"."provider_subscription_id" IS NOT NULL
        AND "kilo_pass_subscriptions"."stripe_subscription_id" IS NULL
      ));--> statement-breakpoint
ALTER TABLE "kilo_pass_subscriptions" ADD CONSTRAINT "kilo_pass_subscriptions_payment_provider_check" CHECK ("kilo_pass_subscriptions"."payment_provider" IN ('stripe', 'app_store', 'google_play'));