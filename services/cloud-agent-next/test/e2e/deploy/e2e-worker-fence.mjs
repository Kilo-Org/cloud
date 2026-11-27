// Fence for the deployed e2e Worker config. The rendered config may carry only
// the keys the renderer emits, may bind no production resource and must have no
// public address. Production is every resource a top-level (or env.production)
// block of a direct services/*/wrangler.{json,jsonc} binds, plus the prepared
// runtime configuration the renderer reads. Findings name the field only.
//
// CLI, run by deploy-e2e-worker.sh on the file it is about to deploy:
//   node test/e2e/deploy/e2e-worker-fence.mjs <rendered config> <prepared source config>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'jsonc-parser';

const defaultServicesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// Exactly the top-level keys `buildE2eWorkerConfig` emits. Any other key, such as
// a service, Hyperdrive, R2, KV, D1, AI, VPC service, rate limit or Worker loader
// binding, is a finding.
const ALLOWED_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'account_id',
  'compatibility_date',
  'compatibility_flags',
  'upload_source_maps',
  'version_metadata',
  'rules',
  'observability',
  'placement',
  'workers_dev',
  'preview_urls',
  'triggers',
  'routes',
  'containers',
  'durable_objects',
  'migrations',
  'vars',
  'secrets_store_secrets',
  'queues',
]);
const NONPRODUCTION_SECRET = /_(DEV|STAGING)$/;
const ACCESS_AUD = /^[a-f0-9]{64}$/;
const ACCESS_TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

const text = value => (typeof value === 'string' ? value : '');
const routesOf = config => config.routes ?? (config.route ? [config.route] : []);
const routeField = (route, key) =>
  typeof route === 'object' && route !== null && key in route ? route[key] : undefined;
const hostOf = route =>
  text(typeof route === 'string' ? route : routeField(route, 'pattern'))
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
const values = (entries, key) => (entries ?? []).map(entry => text(entry[key]).toLowerCase());
const queuesOf = config => [
  ...values(config.queues?.producers, 'queue'),
  ...values(config.queues?.consumers, 'queue'),
  ...values(config.queues?.consumers, 'dead_letter_queue').filter(Boolean),
];

function hostsOverlap(a, b) {
  const matches = (host, other) =>
    new RegExp(`^${host.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(other);
  return a === b || matches(a, b) || matches(b, a);
}

/** Every production resource in the repository, plus those of `extraConfigs`. */
export function collectProduction(extraConfigs = [], servicesDir = defaultServicesDir) {
  const configs = [
    ...extraConfigs,
    ...readdirSync(servicesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry =>
        ['wrangler.json', 'wrangler.jsonc']
          .map(file => join(servicesDir, entry.name, file))
          .filter(path => existsSync(path))
      )
      .flatMap(path => {
        const config = parse(readFileSync(path, 'utf8'));
        return config.env?.production ? [config, config.env.production] : [config];
      }),
  ];
  return {
    hosts: configs.flatMap(config => routesOf(config).map(hostOf)),
    queues: new Set(configs.flatMap(queuesOf)),
  };
}

export function violations(config, production) {
  const found = [];
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) found.push(`${key}: not allowed`);
  }
  const routes = routesOf(config);
  if (config.workers_dev !== false) found.push('workers_dev: must be false');
  if (config.preview_urls !== false) found.push('preview_urls: must be false');
  if ((config.triggers?.crons ?? []).length > 0) found.push('triggers.crons: must be empty');
  if (routes.length > 1) found.push('routes: at most the one Access custom domain');
  for (const route of routes) {
    const host = hostOf(route);
    if (routeField(route, 'custom_domain') !== true) found.push('routes: only a custom domain');
    if (host.includes('*')) found.push('routes: wildcard host');
    if (host.endsWith('workers.dev')) found.push('routes: workers.dev host');
    if (production.hosts.some(owned => hostsOverlap(owned, host))) {
      found.push('routes: overlaps a production host');
    }
  }
  const vars = config.vars ?? {};
  const expectedUrl = routes.length === 1 ? `https://${hostOf(routes[0])}` : undefined;
  if (vars.WORKER_URL !== expectedUrl) {
    found.push('vars.WORKER_URL: must be the custom domain or absent');
  }
  // The e2e entry skips Access verification only in development.
  if (vars.ENVIRONMENT === 'development') found.push('vars.ENVIRONMENT: must not be development');
  if (routes.length > 0 && !ACCESS_AUD.test(text(vars.E2E_ACCESS_AUD))) {
    found.push('vars.E2E_ACCESS_AUD: required with a route');
  }
  if (routes.length > 0 && !ACCESS_TEAM_DOMAIN.test(text(vars.E2E_ACCESS_TEAM_DOMAIN))) {
    found.push('vars.E2E_ACCESS_TEAM_DOMAIN: required with a route');
  }
  for (const binding of config.durable_objects?.bindings ?? []) {
    const script = text(binding.script_name).toLowerCase();
    if (script) found.push(`durable_objects ${text(binding.name)}: script_name ${script}`);
  }
  for (const queue of queuesOf(config)) {
    if (production.queues.has(queue)) found.push(`queues: production ${queue}`);
  }
  for (const secret of config.secrets_store_secrets ?? []) {
    const name = text(secret.secret_name);
    if (!NONPRODUCTION_SECRET.test(name)) found.push(`secrets_store_secrets: ${name}`);
  }
  return found;
}

const isMain = (() => {
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const [renderedPath, sourcePath] = process.argv.slice(2);
  if (!renderedPath || !sourcePath) {
    console.error('Usage: e2e-worker-fence.mjs <rendered config> <prepared source config>');
    process.exit(2);
  }
  const found = violations(
    parse(readFileSync(renderedPath, 'utf8')),
    collectProduction([parse(readFileSync(sourcePath, 'utf8'))])
  );
  if (found.length > 0) {
    console.error(`Refusing ${renderedPath}:\n  ${found.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Fence passed: ${renderedPath}`);
}
