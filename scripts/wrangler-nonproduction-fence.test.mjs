// Fences every direct services/*/wrangler.{json,jsonc,toml}, each file on its
// own even when several coexist (Wrangler picks one by precedence): no nonproduction
// environment may publish to a production host, run an inherited schedule, or
// bind a production or hosted database. Configs render through the pinned
// Wrangler in the usage-ingest closure, so inheritance matches `wrangler deploy
// --env`. Failures name service, environment and field only.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const servicesDir = fileURLToPath(new URL('../services', import.meta.url));
const require = createRequire(join(servicesDir, 'usage-ingest', 'package.json'));
const { experimental_readRawConfig, unstable_readConfig } = require('wrangler');

const routesOf = config => config.routes ?? (config.route ? [config.route] : []);
const hostOf = route =>
  String(typeof route === 'string' ? route : route.pattern)
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
const hostRegExp = host =>
  new RegExp(`^${host.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const hostsOverlap = (a, b) => a === b || hostRegExp(a).test(b) || hostRegExp(b).test(a);

function isLoopback(connectionString) {
  try {
    const host = new URL(connectionString).hostname;
    return ['localhost', '[::1]', '::1'].includes(host) || /^127(\.\d+){3}$/.test(host);
  } catch {
    return false;
  }
}

// The SCIM staging watchdog re-arms its own Durable Object's alarm against the
// WorkOS Staging stream (services/scim-sync/wrangler.jsonc), so its inherited
// schedule is intentional. Every other staging schedule must be restated.
const isScimWatchdog = (service, env, crons) =>
  service === 'scim-sync' && env === 'staging' && crons.join('\n') === '*/5 * * * *';

function violations({ service, env, explicitCrons, previewUrls, config }, production) {
  const where = `${service} env.${env}`;
  const found = [];
  const routes = routesOf(config);
  const crons = config.triggers?.crons ?? [];
  for (const route of routes) {
    const owner = production.hosts.find(p => hostsOverlap(p.host, hostOf(route)));
    if (owner) found.push(`${where} routes: overlaps ${owner.service} production`);
  }
  for (const { binding, id } of config.hyperdrive ?? []) {
    const owner = production.hyperdrive.get(String(id).toLowerCase());
    if (owner) found.push(`${where} hyperdrive ${binding}: ${owner} production id`);
  }
  if (env === 'staging') {
    if (crons.length > 0 && !explicitCrons && !isScimWatchdog(service, env, crons)) {
      found.push(`${where} triggers.crons: inherited from production`);
    }
    return found;
  }
  if (routes.length > 0) found.push(`${where} routes: must be empty`);
  if (config.workers_dev ?? routes.length === 0) found.push(`${where} workers_dev: must be false`);
  // Checked on the raw inherited value: an unset flag leaves preview aliases to
  // the API default even with workers.dev off.
  if (previewUrls !== false) found.push(`${where} preview_urls: must be false`);
  if (crons.length > 0) found.push(`${where} triggers.crons: must be empty`);
  for (const { binding, id, localConnectionString } of config.hyperdrive ?? []) {
    if (/^[0-9a-f]{32}$/i.test(String(id))) found.push(`${where} hyperdrive ${binding}: hosted id`);
    if (!isLoopback(localConnectionString)) {
      found.push(`${where} hyperdrive ${binding}: localConnectionString must be loopback`);
    }
  }
  return found;
}

// Ambient CLOUDFLARE_ENV would otherwise render another environment in place
// of the one named, so each render must report the environment it was asked for.
function render(service, path, env) {
  const config = unstable_readConfig({ config: path, env }, { hideWarnings: true });
  assert.equal(config.targetEnvironment, env, `${service}: rendered the wrong environment`);
  return config;
}

const services = readdirSync(servicesDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .flatMap(entry =>
    ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']
      .map(file => join(servicesDir, entry.name, file))
      .filter(path => existsSync(path))
      .map(path => {
        const service = entry.name;
        const raw = experimental_readRawConfig({ config: path }).rawConfig;
        const envs = Object.keys(raw.env ?? {}).filter(env => env !== 'production');
        return {
          service,
          root: render(service, path, undefined),
          envs: envs.map(env => ({
            service,
            env,
            explicitCrons: raw.env[env].triggers?.crons !== undefined,
            previewUrls: raw.env[env].preview_urls ?? raw.preview_urls,
            config: render(service, path, env),
          })),
        };
      })
  );

const production = {
  hosts: services.flatMap(({ service, root }) =>
    routesOf(root).map(route => ({ service, host: hostOf(route) }))
  ),
  hyperdrive: new Map(
    services.flatMap(({ service, root }) =>
      (root.hyperdrive ?? []).map(({ id }) => [String(id).toLowerCase(), service])
    )
  ),
};

for (const { service, envs } of services.filter(s => s.envs.length > 0)) {
  test(`${service}: nonproduction environments stay off production`, () => {
    const found = envs.flatMap(entry => violations(entry, production));
    assert.deepEqual(found, []);
  });
}

test('staging cannot reach another service production or inherit its schedule', () => {
  const fixed = {
    hosts: [{ service: 'owner', host: '*.fence-owner.test' }],
    hyperdrive: new Map([['0123456789abcdef0123456789abcdef', 'owner']]),
  };
  const stage = (explicitCrons, config) =>
    violations({ service: 'probe', env: 'staging', explicitCrons, config }, fixed);
  assert.deepEqual(stage(true, { routes: ['HTTPS://A.Fence-Owner.test/*'] }), [
    'probe env.staging routes: overlaps owner production',
  ]);
  const hyperdrive = [{ binding: 'H', id: '0123456789ABCDEF0123456789ABCDEF' }];
  assert.deepEqual(stage(true, { hyperdrive }), [
    'probe env.staging hyperdrive H: owner production id',
  ]);
  assert.deepEqual(stage(false, { triggers: { crons: ['*/5 * * * *'] } }), [
    'probe env.staging triggers.crons: inherited from production',
  ]);
  const stageRoute = { pattern: 'probe-staging.fence-probe.test', custom_domain: true };
  assert.deepEqual(stage(true, { route: stageRoute }), []);
});
