import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig, type Unstable_Config as Effective } from 'wrangler';

// Resolves the effective config Wrangler deploys, inheritance applied, rather
// than the raw file, so a key the environment silently inherits is caught too.
const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

const PRODUCTION_STORE = '342a86d9e3a94da698e82d0c6e2a36f0';
const PRODUCTION_HYPERDRIVE = '624ec80650dd414199349f4e217ddb10';
const PRODUCTION_USER_EXISTS_CACHE = 'ab836697b6034a95beb92aceea474b10';

const VARS = {
  DIRECT_INGEST_PERCENT: '100',
  DIRECT_INGEST_MAX_BYTES: '4194304',
  SESSION_SHARE_TOKEN_MIN_IAT: '0',
};
// The live staging script's lineage: three classes at migration tag v2.
const STAGING_DURABLE_OBJECTS = {
  bindings: [
    { name: 'SESSION_INGEST_DO', class_name: 'SessionIngestDO' },
    { name: 'SESSION_ACCESS_CACHE_DO', class_name: 'SessionAccessCacheDO' },
    { name: 'USER_CONNECTION_DO', class_name: 'UserConnectionDO' },
  ],
};
const STAGING_MIGRATIONS = [
  { tag: 'v1', new_sqlite_classes: ['SessionIngestDO', 'SessionAccessCacheDO'] },
  { tag: 'v2', new_sqlite_classes: ['UserConnectionDO'] },
];
const DURABLE_OBJECTS = {
  bindings: [
    ...STAGING_DURABLE_OBJECTS.bindings,
    { name: 'CONNECTION_TICKET_DO', class_name: 'ConnectionTicketDO' },
  ],
};
const MIGRATIONS = [
  ...STAGING_MIGRATIONS,
  { tag: 'v3', new_sqlite_classes: ['ConnectionTicketDO'] },
];

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
      return (
        (effective.queues.producers ?? []).length > 0 ||
        (effective.queues.consumers ?? []).length > 0
      );
    }
    return typeof value === 'object' ? Object.keys(value).length > 0 : true;
  });
}

describe('session-ingest wrangler.jsonc', () => {
  it('keeps the production render as it was', () => {
    const production = unstable_readConfig({ config });

    expect(production.name).toBe('session-ingest');
    expect(production.targetEnvironment).toBeUndefined();
    expect(production.definedEnvironments).toEqual(['staging']);
    expect(production.routes).toEqual([
      { pattern: 'ingest.kilosessions.ai', zone_name: 'kilosessions.ai', custom_domain: true },
    ]);
    expect(production.workers_dev).toBeUndefined();
    expect(production.preview_urls).toBeUndefined();
    expect(production.logpush).toBe(true);
    expect(production.observability).toEqual({ enabled: true });
    expect(production.placement).toEqual({ mode: 'smart' });
    expect(production.vars).toEqual(VARS);
    expect(boundKinds(production)).toEqual([
      'durable_objects',
      'hyperdrive',
      'kv_namespaces',
      'queues',
      'r2_buckets',
      'secrets_store_secrets',
      'services',
    ]);
    expect(production.kv_namespaces).toEqual([
      { binding: 'USER_EXISTS_CACHE', id: PRODUCTION_USER_EXISTS_CACHE },
    ]);
    expect(production.hyperdrive).toEqual([
      {
        binding: 'HYPERDRIVE',
        id: PRODUCTION_HYPERDRIVE,
        localConnectionString: 'postgres://postgres:postgres@localhost:5432/postgres',
      },
    ]);
    expect(production.durable_objects).toEqual(DURABLE_OBJECTS);
    expect(production.migrations).toEqual(MIGRATIONS);
    // The production bucket's name is `session-ingest-staging`; it is not a staging resource.
    expect(production.r2_buckets).toEqual([
      { binding: 'SESSION_INGEST_R2', bucket_name: 'session-ingest-staging' },
    ]);
    expect(production.queues).toEqual({
      producers: [{ binding: 'INGEST_QUEUE', queue: 'session-ingest-processing' }],
      consumers: [
        {
          queue: 'session-ingest-processing',
          max_retries: 3,
          dead_letter_queue: 'session-ingest-dlq',
        },
      ],
    });
    expect(production.services).toEqual([
      { binding: 'O11Y', service: 'o11y' },
      { binding: 'NOTIFICATIONS', service: 'notifications', entrypoint: 'NotificationsService' },
    ]);
    expect(production.secrets_store_secrets).toEqual([
      {
        binding: 'NEXTAUTH_SECRET_PROD',
        store_id: PRODUCTION_STORE,
        secret_name: 'NEXTAUTH_SECRET_PROD',
      },
      {
        binding: 'INTERNAL_API_SECRET_PROD',
        store_id: PRODUCTION_STORE,
        secret_name: 'INTERNAL_API_SECRET_PROD',
      },
      {
        binding: 'SESSION_SHARE_JWT_SECRET_PROD',
        store_id: PRODUCTION_STORE,
        secret_name: 'SESSION_SHARE_JWT_SECRET_PROD',
      },
    ]);
  });

  it('closes staging: its live v2 Durable Objects only, no ingress, schedule, Logpush or logs', () => {
    const staging = unstable_readConfig({ config, env: 'staging' });

    expect(staging.name).toBe('session-ingest-staging');
    expect(staging.targetEnvironment).toBe('staging');
    expect(staging.workers_dev).toBe(false);
    expect(staging.preview_urls).toBe(false);
    expect(staging.routes ?? []).toEqual([]);
    expect(staging.route).toBeUndefined();
    expect(staging.triggers).toEqual({ crons: [] });
    expect(staging.logpush).toBe(false);
    expect(staging.observability).toEqual({ enabled: false });
    expect(staging.vars).toEqual(VARS);

    expect(boundKinds(staging)).toEqual(['durable_objects']);
    expect(staging.durable_objects).toEqual(STAGING_DURABLE_OBJECTS);
    expect(staging.migrations).toEqual(STAGING_MIGRATIONS);

    const rendered = JSON.stringify(staging);
    for (const absentValue of [
      PRODUCTION_HYPERDRIVE,
      PRODUCTION_USER_EXISTS_CACHE,
      PRODUCTION_STORE,
      'kilosessions.ai',
      'session-ingest-processing',
      'session-ingest-dlq',
      '"o11y"',
      '"notifications"',
      // No v3 class change and no ticket namespace until the isolated staging change.
      'ConnectionTicketDO',
      '"v3"',
    ]) {
      expect(rendered).not.toContain(absentValue);
    }
  });

  it('refuses an undeclared environment instead of rendering production', () => {
    // Wrangler's own reason when `env` is declared but has no section of that name.
    expect(() => unstable_readConfig({ config, env: 'preview' })).toThrow(
      'No environment found in configuration with name "preview".'
    );
  });
});
