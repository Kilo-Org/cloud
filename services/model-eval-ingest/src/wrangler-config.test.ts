import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

// Resolves the effective config Wrangler deploys, inheritance applied, rather than the raw file,
// so a variable or binding the dev environment silently inherits is caught too.
const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

const STORE = '342a86d9e3a94da698e82d0c6e2a36f0';

describe('model-eval-ingest wrangler.jsonc secrets', () => {
  it('serves production from the Secrets Store with the source comparison on', () => {
    const production = unstable_readConfig({ config });

    expect(production.name).toBe('model-eval-ingest');
    expect(production.targetEnvironment).toBeUndefined();
    expect(production.vars).toEqual({
      ENVIRONMENT: 'production',
      SECRETS_SOURCE: 'secrets-store',
      SECRETS_COMPARE_ENABLED: 'true',
    });
    expect(production.services).toEqual([
      { binding: 'BENCH_DASHBOARD', service: 'kilo-bench-dashboard', entrypoint: 'Dashboard' },
      {
        binding: 'STS',
        service: 'sts',
        entrypoint: 'SecretsBroker',
        props: { caller: 'model-eval-ingest' },
      },
    ]);
    expect(production.secrets_store_secrets).toEqual([
      { binding: 'INTERNAL_API_SECRET', store_id: STORE, secret_name: 'INTERNAL_API_SECRET_PROD' },
    ]);
  });

  it('keeps env.dev on its own binding, with no STS binding, source or comparison', () => {
    const dev = unstable_readConfig({ config, env: 'dev' });

    expect(dev.name).toBe('model-eval-ingest-dev');
    expect(dev.targetEnvironment).toBe('dev');
    expect(dev.vars).toEqual({ ENVIRONMENT: 'development' });
    expect(dev.services).toEqual([
      { binding: 'BENCH_DASHBOARD', service: 'kilo-bench-dashboard-dev', entrypoint: 'Dashboard' },
    ]);
    expect(dev.secrets_store_secrets).toEqual([
      { binding: 'INTERNAL_API_SECRET', store_id: STORE, secret_name: 'INTERNAL_API_SECRET_DEV' },
    ]);
  });
});
