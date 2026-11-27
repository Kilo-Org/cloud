// Fence for the deployed e2e Worker config and the fake-LLM Worker config. Each
// may carry only the keys its renderer emits, may bind no production resource
// and must have no public address: workers.dev and preview URLs off, and at
// most the one Access-protected custom domain the workflow configured.
// Production is every resource a top-level (or env.production) block of a
// direct services/*/wrangler.{json,jsonc} binds, plus the prepared runtime
// configuration the renderer reads. Findings name the field only.
//
// CLI, run by the deploy scripts on the file they are about to deploy, with the
// configured E2E_WORKER_HOSTNAME and E2E_FAKE_LLM_HOSTNAME as the exact hosts:
//   node test/e2e/deploy/e2e-worker-fence.mjs <rendered config> <prepared source config>
//   node test/e2e/deploy/e2e-worker-fence.mjs --fake-llm <fake-LLM config>
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

/** Findings for a route list that must be exactly one custom domain, or none. */
function routeViolations(routes, production, expectedHost) {
  const found = [];
  if (expectedHost === undefined && routes.length > 0) {
    found.push('routes: none allowed without a configured hostname');
  }
  if (routes.length > 1) found.push('routes: at most the one Access custom domain');
  for (const route of routes) {
    const host = hostOf(route);
    if (routeField(route, 'custom_domain') !== true) found.push('routes: only a custom domain');
    if (host.includes('*')) found.push('routes: wildcard host');
    if (host.endsWith('workers.dev')) found.push('routes: workers.dev host');
    if (production.hosts.some(owned => hostsOverlap(owned, host))) {
      found.push('routes: overlaps a production host');
    }
    if (expectedHost !== undefined && host !== expectedHost) {
      found.push('routes: not the configured hostname');
    }
  }
  return found;
}

function addressViolations(config) {
  const found = [];
  if (config.workers_dev !== false) found.push('workers_dev: must be false');
  if (config.preview_urls !== false) found.push('preview_urls: must be false');
  return found;
}

function secretAndObjectViolations(config) {
  const found = [];
  for (const binding of config.durable_objects?.bindings ?? []) {
    const script = text(binding.script_name).toLowerCase();
    if (script) found.push(`durable_objects ${text(binding.name)}: script_name ${script}`);
  }
  for (const secret of config.secrets_store_secrets ?? []) {
    const name = text(secret.secret_name);
    if (!NONPRODUCTION_SECRET.test(name)) found.push(`secrets_store_secrets: ${name}`);
  }
  return found;
}

/** The host of `https://<plain host>` with nothing else, or undefined. */
function plainHttpsHost(value) {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    return undefined;
  }
  return url.protocol === 'https:' && text(value) === `https://${url.hostname}`
    ? url.hostname
    : undefined;
}

/**
 * Findings for the rendered e2e Worker config. With `expected`, the hostnames
 * the workflow configured are authoritative: the route and `WORKER_URL` (the
 * origin callbacks and sandboxes address) must be exactly the Worker hostname,
 * or absent when it is unset, and the fake-LLM origin exactly its hostname.
 * Without it, the one route's own host is taken as configured.
 */
export function violations(config, production, expected) {
  const found = [];
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) found.push(`${key}: not allowed`);
  }
  const routes = routesOf(config);
  found.push(...addressViolations(config));
  // Present and empty: wrangler clears live schedules only when the list exists.
  if (!Array.isArray(config.triggers?.crons) || config.triggers.crons.length > 0) {
    found.push('triggers.crons: must be present and empty');
  }
  const routeHost = routes.length > 0 ? hostOf(routes[0]) : undefined;
  const workerHost = expected === undefined ? routeHost : expected.workerHostname;
  found.push(...routeViolations(routes, production, workerHost));
  const vars = config.vars ?? {};
  const expectedUrl = workerHost === undefined ? undefined : `https://${workerHost}`;
  if (vars.WORKER_URL !== expectedUrl) {
    found.push('vars.WORKER_URL: must be https://<configured Worker hostname> or absent');
  }
  const fakeHost = plainHttpsHost(vars.E2E_FAKE_LLM_URL);
  if (
    fakeHost === undefined ||
    fakeHost.endsWith('workers.dev') ||
    production.hosts.some(owned => hostsOverlap(owned, fakeHost)) ||
    vars.E2E_FAKE_LLM_URL === vars.WORKER_URL ||
    (expected !== undefined && fakeHost !== expected.fakeLlmHostname)
  ) {
    found.push('vars.E2E_FAKE_LLM_URL: must be https://<configured fake-LLM hostname>');
  }
  if (vars.KILO_OPENROUTER_BASE !== `${text(vars.E2E_FAKE_LLM_URL)}/api/openrouter`) {
    found.push('vars.KILO_OPENROUTER_BASE: must be the fake-LLM origin');
  }
  if (vars.E2E_MODEL_VALIDATION_BASE_URL !== vars.E2E_FAKE_LLM_URL) {
    found.push('vars.E2E_MODEL_VALIDATION_BASE_URL: must be the fake-LLM origin');
  }
  // The e2e entry skips Access verification only in development.
  if (vars.ENVIRONMENT === 'development') found.push('vars.ENVIRONMENT: must not be development');
  if (routes.length > 0 && !ACCESS_AUD.test(text(vars.E2E_ACCESS_AUD))) {
    found.push('vars.E2E_ACCESS_AUD: required with a route');
  }
  if (routes.length > 0 && !ACCESS_TEAM_DOMAIN.test(text(vars.E2E_ACCESS_TEAM_DOMAIN))) {
    found.push('vars.E2E_ACCESS_TEAM_DOMAIN: required with a route');
  }
  for (const queue of queuesOf(config)) {
    if (production.queues.has(queue)) found.push(`queues: production ${queue}`);
  }
  found.push(...secretAndObjectViolations(config));
  return found;
}

// Exactly the top-level keys of test/e2e/wrangler.fake-llm.jsonc and its render.
const FAKE_LLM_ALLOWED_KEYS = new Set([
  '$schema',
  'name',
  'account_id',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'workers_dev',
  'preview_urls',
  'dev',
  'durable_objects',
  'migrations',
  'secrets_store_secrets',
  'routes',
]);

/**
 * Findings for a fake-LLM Worker config: the checked-in file (no hostname, so no
 * route) or its render, whose one route must be exactly `hostname`.
 */
export function fakeLlmViolations(config, production, { hostname } = {}) {
  const found = [];
  for (const key of Object.keys(config)) {
    if (!FAKE_LLM_ALLOWED_KEYS.has(key)) found.push(`${key}: not allowed`);
  }
  found.push(...addressViolations(config));
  found.push(...routeViolations(routesOf(config), production, hostname));
  found.push(...secretAndObjectViolations(config));
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
  const args = process.argv.slice(2);
  // Hostnames the workflow configured; unset means the config may have none.
  const workerHostname = process.env.E2E_WORKER_HOSTNAME || undefined;
  const fakeLlmHostname = process.env.E2E_FAKE_LLM_HOSTNAME || undefined;
  let target;
  let found;
  if (args[0] === '--fake-llm' && args.length === 2) {
    target = args[1];
    found = fakeLlmViolations(parse(readFileSync(target, 'utf8')), collectProduction(), {
      hostname: fakeLlmHostname,
    });
  } else if (args.length === 2 && !args[0].startsWith('--')) {
    const [renderedPath, sourcePath] = args;
    target = renderedPath;
    found = violations(
      parse(readFileSync(renderedPath, 'utf8')),
      collectProduction([parse(readFileSync(sourcePath, 'utf8'))]),
      { workerHostname, fakeLlmHostname }
    );
  } else {
    console.error(
      'Usage: e2e-worker-fence.mjs <rendered config> <prepared source config>\n' +
        '       e2e-worker-fence.mjs --fake-llm <fake-LLM config>'
    );
    process.exit(2);
  }
  if (found.length > 0) {
    console.error(`Refusing ${target}:\n  ${found.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Fence passed: ${target}`);
}
