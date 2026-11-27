// Fences the deployed e2e Worker config: rendered from this package's production
// wrangler.jsonc, it may bind no production resource and must have no public
// address. Production is every resource a top-level (or env.production) block of a
// direct services/*/wrangler.{json,jsonc} binds, plus the prepared runtime
// configuration the renderer reads. Failures name the field only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { renderRuntimeTarget } from './runtime-target.js';
import { buildE2eWorkerConfig } from '../test/e2e/deploy/render-e2e-worker-config.mjs';

type Binding = Record<string, unknown>;
type WorkerConfig = {
  name?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  logpush?: boolean;
  route?: unknown;
  routes?: unknown[];
  triggers?: { crons?: string[] };
  services?: Binding[];
  hyperdrive?: Binding[];
  r2_buckets?: Binding[];
  kv_namespaces?: Binding[];
  d1_databases?: Binding[];
  queues?: { producers?: Binding[]; consumers?: Binding[] };
  secrets_store_secrets?: Binding[];
  durable_objects?: { bindings?: Binding[] };
  vars?: Record<string, unknown>;
  env?: Record<string, WorkerConfig>;
  [key: string]: unknown;
};

type Production = {
  hosts: string[];
  scripts: Set<string>;
  hyperdrive: Set<string>;
  r2: Set<string>;
  kv: Set<string>;
  d1: Set<string>;
  queues: Set<string>;
};

// Account resources outside the kinds above. The e2e Worker needs none of them,
// so any entry is a finding.
const FORBIDDEN_BINDING_KEYS = [
  'ai',
  'analytics_engine_datasets',
  'browser',
  'dispatch_namespaces',
  'images',
  'mtls_certificates',
  'pipelines',
  'send_email',
  'tail_consumers',
  'unsafe',
  'vectorize',
  'workflows',
];
const NONPRODUCTION_SECRET = /_(DEV|STAGING)$/;
const PROBE_HOST = 'cloud-agent-e2e.fence-probe.test';

const servicesDir = fileURLToPath(new URL('../../', import.meta.url));
const source = parse(readFileSync(join(servicesDir, 'cloud-agent-next', 'wrangler.jsonc'), 'utf8'));
const prepared = renderRuntimeTarget({
  config: source,
  environment: 'production',
  startup: { mode: 'downloaded', image: 'runtime-free' },
  release: {
    descriptorSha256: 'e'.repeat(64),
    bucket: 'cloud-agent-runtime-fence-probe',
    baseImage:
      'registry.cloudflare.com/' + 'c'.repeat(32) + '/kilo-runtime-base@sha256:' + 'd'.repeat(64),
  },
}) as WorkerConfig;

const routesOf = (config: WorkerConfig): unknown[] =>
  config.routes ?? (config.route ? [config.route] : []);
const routeField = (route: unknown, key: 'pattern' | 'custom_domain'): unknown =>
  typeof route === 'object' && route !== null && key in route ? Reflect.get(route, key) : undefined;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const hostOf = (route: unknown): string =>
  text(typeof route === 'string' ? route : routeField(route, 'pattern'))
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
function hostsOverlap(a: string, b: string): boolean {
  const matches = (host: string, other: string) =>
    new RegExp(`^${host.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(other);
  return a === b || matches(a, b) || matches(b, a);
}
const values = (entries: Binding[] | undefined, key: string): string[] =>
  (entries ?? []).map(entry => text(entry[key]).toLowerCase());
const queuesOf = (config: WorkerConfig): string[] => [
  ...values(config.queues?.producers, 'queue'),
  ...values(config.queues?.consumers, 'queue'),
];

function productionOf(configs: WorkerConfig[]): Production {
  return {
    hosts: configs.flatMap(config => routesOf(config).map(hostOf)),
    scripts: new Set(configs.map(config => String(config.name ?? '').toLowerCase())),
    hyperdrive: new Set(configs.flatMap(config => values(config.hyperdrive, 'id'))),
    r2: new Set(configs.flatMap(config => values(config.r2_buckets, 'bucket_name'))),
    kv: new Set(configs.flatMap(config => values(config.kv_namespaces, 'id'))),
    d1: new Set(configs.flatMap(config => values(config.d1_databases, 'database_id'))),
    queues: new Set(configs.flatMap(queuesOf)),
  };
}

const production = productionOf([
  prepared,
  ...readdirSync(servicesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry =>
      ['wrangler.json', 'wrangler.jsonc']
        .map(file => join(servicesDir, entry.name, file))
        .filter(path => existsSync(path))
    )
    .flatMap(path => {
      const config = parse(readFileSync(path, 'utf8')) as WorkerConfig;
      return config.env?.production ? [config, config.env.production] : [config];
    }),
]);

function violations(config: WorkerConfig, fixed: Production): string[] {
  const found: string[] = [];
  const routes = routesOf(config);
  if (config.workers_dev !== false) found.push('workers_dev: must be false');
  if (config.preview_urls !== false) found.push('preview_urls: must be false');
  if ((config.triggers?.crons ?? []).length > 0) found.push('triggers.crons: must be empty');
  if (config.logpush === true) found.push('logpush: must be off');
  if (routes.length > 1) found.push('routes: at most the one Access custom domain');
  for (const route of routes) {
    const host = hostOf(route);
    if (routeField(route, 'custom_domain') !== true) found.push('routes: only a custom domain');
    if (host.includes('*')) found.push('routes: wildcard host');
    if (host.endsWith('workers.dev')) found.push('routes: workers.dev host');
    if (fixed.hosts.some(owned => hostsOverlap(owned, host))) {
      found.push('routes: overlaps a production host');
    }
  }
  const workerUrl = config.vars?.WORKER_URL;
  const expectedUrl = routes.length === 1 ? `https://${hostOf(routes[0])}` : undefined;
  if (workerUrl !== expectedUrl) found.push('vars.WORKER_URL: must be the custom domain or absent');
  for (const service of values(config.services, 'service')) {
    if (fixed.scripts.has(service)) found.push(`services: production Worker ${service}`);
  }
  for (const binding of config.durable_objects?.bindings ?? []) {
    const script = text(binding.script_name).toLowerCase();
    if (script && fixed.scripts.has(script)) {
      found.push(`durable_objects ${text(binding.name)}: production Worker ${script}`);
    }
  }
  const resources: Array<[string, string[], Set<string>]> = [
    ['hyperdrive', values(config.hyperdrive, 'id'), fixed.hyperdrive],
    ['r2_buckets', values(config.r2_buckets, 'bucket_name'), fixed.r2],
    ['kv_namespaces', values(config.kv_namespaces, 'id'), fixed.kv],
    ['d1_databases', values(config.d1_databases, 'database_id'), fixed.d1],
    ['queues', queuesOf(config), fixed.queues],
  ];
  for (const [field, used, owned] of resources) {
    for (const value of used) if (owned.has(value)) found.push(`${field}: production ${value}`);
  }
  for (const secret of config.secrets_store_secrets ?? []) {
    const name = text(secret.secret_name);
    if (!NONPRODUCTION_SECRET.test(name)) found.push(`secrets_store_secrets: ${name}`);
  }
  for (const key of FORBIDDEN_BINDING_KEYS) {
    const value = config[key];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      found.push(`${key}: not allowed`);
    }
  }
  return found;
}

const render = (workerHostname?: string) =>
  buildE2eWorkerConfig(prepared, {
    ...(workerHostname === undefined ? {} : { workerHostname }),
    kiloOpenRouterBase: 'https://fake.fence-probe.test/api/openrouter',
  }) as WorkerConfig;

describe('deployed e2e Worker fence', () => {
  it('binds no production resource and has no public address', () => {
    expect(violations(render(), production)).toEqual([]);
    expect(render().routes).toBeUndefined();
  });

  it('reaches its Access hostname through one custom domain and nothing else', () => {
    const config = render(PROBE_HOST);
    expect(violations(config, production)).toEqual([]);
    expect(config.routes).toEqual([{ pattern: PROBE_HOST, custom_domain: true }]);
    expect(config.vars?.WORKER_URL).toBe(`https://${PROBE_HOST}`);
  });

  it('refuses a hostname that is public or overlaps production', () => {
    for (const host of [
      'cloud-agent-e2e-test.engineering-e11.workers.dev',
      'cloud-agent.kiloapps.ai',
      'preview.cloud-agent.kiloapps.ai',
      '*.fence-probe.test',
      'https://cloud-agent-e2e.fence-probe.test',
    ]) {
      expect(() => render(host), host).toThrow(/E2E_WORKER_HOSTNAME/);
    }
  });

  it('flags every production binding and public address of the source config', () => {
    const found = violations(prepared, production);
    for (const expected of [
      'workers_dev: must be false',
      'triggers.crons: must be empty',
      'logpush: must be off',
      'routes: overlaps a production host',
      'services: production Worker git-token-service',
      'hyperdrive: production 624ec80650dd414199349f4e217ddb10',
      'r2_buckets: production cloud-agent-runtime-fence-probe',
      'queues: production cloud-agent-next-callback-queue',
      'secrets_store_secrets: INTERNAL_API_SECRET_PROD',
      'ai: not allowed',
    ]) {
      expect(found).toContain(expected);
    }
  });
});
