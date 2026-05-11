ALTER TABLE "kilo_pass_subscriptions" DROP CONSTRAINT "kilo_pass_subscriptions_provider_subscription_required_check";--> statement-breakpoint
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
ALTER TABLE "kilo_pass_subscriptions" ADD CONSTRAINT "kilo_pass_subscriptions_provider_ids_check" CHECK ((
        "kilo_pass_subscriptions"."payment_provider" = 'stripe'
        AND "kilo_pass_subscriptions"."provider_subscription_id" IS NOT NULL
        AND "kilo_pass_subscriptions"."stripe_subscription_id" IS NOT NULL
        AND "kilo_pass_subscriptions"."provider_subscription_id" = "kilo_pass_subscriptions"."stripe_subscription_id"
      ) OR (
        "kilo_pass_subscriptions"."payment_provider" IN ('app_store', 'google_play')
        AND "kilo_pass_subscriptions"."provider_subscription_id" IS NOT NULL
        AND "kilo_pass_subscriptions"."stripe_subscription_id" IS NULL
      ));
