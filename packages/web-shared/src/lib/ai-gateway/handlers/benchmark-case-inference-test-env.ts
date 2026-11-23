/**
 * Placeholders for the server config module that validates its required values at load time.
 *
 * Imported for its side effect before anything that reads `config.server`, so the benchmark
 * gateway handler test can reach the rebuilt-request boundary without a real deployment.
 * Nothing here contacts an external service.
 */
process.env.NEXTAUTH_SECRET ??= 'test-nextauth-secret';
// The handler's only config read is this secret; setting it here keeps the real config module
// (and every other export the proxy chain loads) exactly as production has it.
process.env.INTERNAL_API_SECRET ??= 'test-internal-secret';
// A base64 32-byte key, the shape `BYOK_ENCRYPTION_KEY` validates; nothing is decrypted here.
process.env.BYOK_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
// The handler imports the real proxy chain, which loads the Drizzle module. No query runs in
// this suite (the proxy is mocked), so only the module-load guards need satisfying.
process.env.POSTGRES_CONNECT_TIMEOUT ??= '10000';
process.env.POSTGRES_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';
process.env.STRIPE_SECRET_KEY ??= 'test_stripe_secret_key';
process.env.STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID ??= 'test_teams_product';
process.env.STRIPE_TEAMS_SUBSCRIPTION_PRICE_ID ??= 'test_teams_price';
for (const tier of ['19', '49', '199']) {
  for (const cadence of ['MONTHLY', 'YEARLY']) {
    const key = `STRIPE_KILO_PASS_TIER_${tier}_${cadence}_PRICE_ID`;
    process.env[key] ??= `test_${key.toLowerCase()}`;
  }
}

export {};
