import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

// Resolves the effective config Wrangler deploys, inheritance applied, rather
// than the raw file, so a key the environment silently inherits is caught too.
const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

const PRODUCTION_STORE = '342a86d9e3a94da698e82d0c6e2a36f0';
const PRODUCTION_HYPERDRIVE = '624ec80650dd414199349f4e217ddb10';
const STAGING_HYPERDRIVE = 'c9c9b6b68684471ba0fcc69fff3673cf';

const CHANNEL_DO = {
  bindings: [{ name: 'NOTIFICATION_CHANNEL_DO', class_name: 'NotificationChannelDO' }],
};
const MIGRATIONS = [{ tag: 'v1', new_classes: ['NotificationChannelDO'] }];

type Effective = ReturnType<typeof unstable_readConfig>;

// Every binding kind Wrangler can attach; a block may hold only the kinds it names.
const BINDING_KINDS = [
  'ai',
  'analytics_engine_datasets',
  'assets',
  'browser',
  'containers',
  'd1_databases',
  'dispatch_namespaces',
  'durable_objects',
  'hyperdrive',
  'images',
  'kv_namespaces',
  'mtls_certificates',
  'pipelines',
  'queues',
  'r2_buckets',
  'secrets_store_secrets',
  'send_email',
  'services',
  'tail_consumers',
  'unsafe',
  'vectorize',
  'version_metadata',
  'workflows',
] as const satisfies readonly (keyof Effective)[];

function boundKinds(effective: Effective): string[] {
  return BINDING_KINDS.filter(kind => {
    const value: unknown = effective[kind];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (kind === 'durable_objects') return effective.durable_objects.bindings.length > 0;
    if (kind === 'queues') {
      return effective.queues.producers.length > 0 || (effective.queues.consumers ?? []).length > 0;
    }
    return typeof value === 'object' ? Object.keys(value).length > 0 : true;
  });
}

describe('notifications wrangler.jsonc', () => {
  it('keeps the production render as it was', () => {
    const production = unstable_readConfig({ config });

    expect(production.name).toBe('notifications');
    expect(production.targetEnvironment).toBeUndefined();
    expect(production.definedEnvironments).toEqual(['staging']);
    expect(production.routes).toEqual([
      { pattern: 'notifications.kiloapps.io', zone_name: 'kiloapps.io', custom_domain: true },
    ]);
    expect(production.workers_dev).toBeUndefined();
    expect(production.preview_urls).toBeUndefined();
    expect(production.triggers).toEqual({ crons: ['41 3 * * *'] });
    expect(production.placement).toEqual({ mode: 'smart' });
    expect(production.observability).toEqual({ enabled: true, traces: { enabled: false } });
    expect(production.vars).toEqual({
      WORKER_ENV: 'production',
      KILO_WEB_API_BASE_URL: 'https://app.kilo.ai',
      APNS_TOPIC: 'com.kilocode.kiloapp',
      APNS_TEAM_ID: 'X96D76J65Z',
      APNS_KEY_ID: 'KRYMZL626P',
      SECRETS_SOURCE: 'secrets-store',
    });
    expect(boundKinds(production)).toEqual([
      'durable_objects',
      'hyperdrive',
      'queues',
      'secrets_store_secrets',
      'services',
    ]);
    expect(production.hyperdrive).toEqual([
      {
        binding: 'HYPERDRIVE',
        id: PRODUCTION_HYPERDRIVE,
        localConnectionString: 'postgres://postgres:postgres@localhost:5432/postgres',
      },
    ]);
    expect(production.durable_objects).toEqual(CHANNEL_DO);
    expect(production.migrations).toEqual(MIGRATIONS);
    expect(production.queues).toEqual({
      producers: [{ binding: 'RECEIPTS_QUEUE', queue: 'notifications-receipts' }],
      consumers: [
        {
          queue: 'notifications-receipts',
          max_retries: 3,
          dead_letter_queue: 'notifications-receipts-dlq',
          retry_delay: 60,
        },
      ],
    });
    expect(production.services).toEqual([
      { binding: 'EVENT_SERVICE', service: 'event-service' },
      {
        binding: 'STS',
        service: 'sts',
        entrypoint: 'SecretsBroker',
        props: { caller: 'notifications' },
      },
    ]);
    expect(production.secrets_store_secrets).toEqual([
      {
        binding: 'APNS_PRIVATE_KEY',
        store_id: PRODUCTION_STORE,
        secret_name: 'APNS_PRIVATE_KEY_PROD',
      },
      {
        binding: 'EXPO_ACCESS_TOKEN',
        store_id: PRODUCTION_STORE,
        secret_name: 'EXPO_ACCESS_TOKEN',
      },
      {
        binding: 'NEXTAUTH_SECRET',
        store_id: PRODUCTION_STORE,
        secret_name: 'NEXTAUTH_SECRET_PROD',
      },
      {
        binding: 'INTERNAL_API_SECRET',
        store_id: PRODUCTION_STORE,
        secret_name: 'INTERNAL_API_SECRET_PROD',
      },
    ]);
  });

  it('closes staging: its own database and object only, push off, no signer, route or schedule', () => {
    const staging = unstable_readConfig({ config, env: 'staging' });

    expect(staging.name).toBe('notifications-staging');
    expect(staging.targetEnvironment).toBe('staging');
    expect(staging.vars).toEqual({
      WORKER_ENV: 'staging',
      NOTIFICATIONS_PUSH_ENABLED: 'false',
      SECRETS_SOURCE: 'secrets-store',
    });
    // The current `workers.dev` and preview URL settings, pinned so a deploy
    // neither re-enables nor adds ingress; no route and no custom domain.
    expect(staging.workers_dev).toBe(true);
    expect(staging.preview_urls).toBe(true);
    expect(staging.routes ?? []).toEqual([]);
    expect(staging.route).toBeUndefined();
    expect(staging.triggers).toEqual({ crons: [] });
    expect(staging.observability).toEqual({ enabled: true, traces: { enabled: false } });
    expect(staging.logpush).toBeUndefined();

    expect(boundKinds(staging)).toEqual(['durable_objects', 'hyperdrive']);
    expect(staging.hyperdrive).toEqual([{ binding: 'HYPERDRIVE', id: STAGING_HYPERDRIVE }]);
    expect(staging.durable_objects).toEqual(CHANNEL_DO);
    expect(staging.migrations).toEqual(MIGRATIONS);
    expect(JSON.stringify(staging)).not.toContain(PRODUCTION_HYPERDRIVE);
    expect(JSON.stringify(staging)).not.toContain(PRODUCTION_STORE);
    expect(JSON.stringify(staging)).not.toContain('kiloapps.io');
  });

  it('refuses an undeclared environment instead of rendering production', () => {
    expect(() => unstable_readConfig({ config, env: 'preview' })).toThrow();
  });
});
