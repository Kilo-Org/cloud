import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig, unstable_readConfig } from 'wrangler';

// Resolves the effective config Wrangler deploys, inheritance applied, rather than the raw file.
// Scope: the environments that fix the secret source, and every binding a secret read can reach.
const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

const STORE = '342a86d9e3a94da698e82d0c6e2a36f0';

describe('webhook-agent-ingest wrangler.jsonc secrets', () => {
  it('runs production as `production`, with STS and every binding but no source setting', () => {
    const production = unstable_readConfig({ config });

    expect(production.name).toBe('cloudflare-webhook-agent-ingest');
    expect(production.targetEnvironment).toBeUndefined();
    expect(production.vars).toEqual({
      ENVIRONMENT: 'production',
      KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
      WEBHOOK_AGENT_URL: 'https://hooks.kilosessions.ai',
      KILOCLAW_API_URL: 'https://claw.kilosessions.ai',
      SHARED_RESOURCE_TOKENS_ENABLED: 'true',
    });
    expect(production.services).toEqual([
      { binding: 'CLOUD_AGENT', service: 'cloud-agent-next' },
      { binding: 'KILO_CHAT', service: 'kilo-chat', entrypoint: 'KiloChatService' },
      {
        binding: 'STS',
        service: 'sts',
        entrypoint: 'SecretsBroker',
        props: { caller: 'cloudflare-webhook-agent-ingest' },
      },
    ]);
    expect(production.secrets_store_secrets).toEqual([
      { binding: 'INTERNAL_API_SECRET', store_id: STORE, secret_name: 'INTERNAL_API_SECRET_PROD' },
      {
        binding: 'CALLBACK_TOKEN_SECRET',
        store_id: STORE,
        secret_name: 'CALLBACK_TOKEN_SECRET_PROD',
      },
      { binding: 'NEXTAUTH_SECRET', store_id: STORE, secret_name: 'NEXTAUTH_SECRET_PROD' },
    ]);
  });

  it('runs env.dev as `development`, without the STS binding', () => {
    const dev = unstable_readConfig({ config, env: 'dev' });

    expect(dev.name).toBe('cloudflare-webhook-agent-ingest-dev');
    expect(dev.vars).toEqual({
      ENVIRONMENT: 'development',
      KILOCODE_BACKEND_BASE_URL: 'http://localhost:3000',
      KILOCLAW_API_URL: 'http://localhost:8795',
      WEBHOOK_AGENT_URL: 'http://localhost:8793',
      SHARED_RESOURCE_TOKENS_ENABLED: 'true',
    });
    expect(dev.services).toEqual([
      { binding: 'CLOUD_AGENT', service: 'cloud-agent-next-dev' },
      { binding: 'KILO_CHAT', service: 'kilo-chat', entrypoint: 'KiloChatService' },
    ]);
    expect(dev.secrets_store_secrets).toEqual([
      { binding: 'INTERNAL_API_SECRET', store_id: STORE, secret_name: 'INTERNAL_API_SECRET_DEV' },
      {
        binding: 'CALLBACK_TOKEN_SECRET',
        store_id: STORE,
        secret_name: 'CALLBACK_TOKEN_SECRET_DEV',
      },
      { binding: 'NEXTAUTH_SECRET', store_id: STORE, secret_name: 'NEXTAUTH_SECRET_DEV' },
    ]);
  });

  it('declares no environment beyond production and env.dev', () => {
    // src/secrets.ts reads only for `production` (top level) and `development` (`env.dev`).
    const { rawConfig } = experimental_readRawConfig({ config });
    expect(Object.keys(rawConfig.env ?? {})).toEqual(['dev']);
    // Wrangler's own reason when `env` is declared but has no section of that name.
    expect(() => unstable_readConfig({ config, env: 'staging' })).toThrow(
      'No environment found in configuration with name "staging".'
    );
  });
});
