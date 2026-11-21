/**
 * Syntactic placeholders for the billing modules that validate Stripe configuration when they
 * load. Imported for its side effect first, so a benchmark billing test can import the real
 * native writer without a Stripe deployment. Nothing here contacts Stripe.
 */
for (const tier of ['19', '49', '199']) {
  for (const cadence of ['MONTHLY', 'YEARLY']) {
    const key = `STRIPE_KILO_PASS_TIER_${tier}_${cadence}_PRICE_ID`;
    process.env[key] ??= `test_${key.toLowerCase()}`;
  }
}
process.env.STRIPE_SECRET_KEY ??= 'test_stripe_secret_key';
process.env.STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID ??= 'test_teams_product';
process.env.STRIPE_TEAMS_SUBSCRIPTION_PRICE_ID ??= 'test_teams_price';

export {};
