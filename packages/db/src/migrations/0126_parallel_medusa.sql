DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM "kilo_pass_store_purchases" p
    LEFT JOIN "kilo_pass_subscriptions" s
      ON s."id" = p."kilo_pass_subscription_id"
      AND s."kilo_user_id" = p."kilo_user_id"
      AND s."payment_provider" = p."payment_provider"
      AND s."provider_subscription_id" = p."provider_subscription_id"
    WHERE s."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'kilo_pass_store_purchases contains rows that do not match their referenced subscription owner/provider';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "kilo_pass_store_purchases"
    WHERE "payment_provider" NOT IN ('app_store', 'google_play')
  ) THEN
    RAISE EXCEPTION 'kilo_pass_store_purchases contains non-store payment providers';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kilo_pass_subscriptions_store_purchase_reference" ON "kilo_pass_subscriptions" USING btree ("id","kilo_user_id","payment_provider","provider_subscription_id");--> statement-breakpoint
ALTER TABLE "kilo_pass_store_purchases" ADD CONSTRAINT "FK_kilo_pass_store_purchases_subscription_owner_provider" FOREIGN KEY ("kilo_pass_subscription_id","kilo_user_id","payment_provider","provider_subscription_id") REFERENCES "public"."kilo_pass_subscriptions"("id","kilo_user_id","payment_provider","provider_subscription_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kilo_pass_store_purchases" ADD CONSTRAINT "kilo_pass_store_purchases_store_provider_check" CHECK ("kilo_pass_store_purchases"."payment_provider" IN ('app_store', 'google_play'));
