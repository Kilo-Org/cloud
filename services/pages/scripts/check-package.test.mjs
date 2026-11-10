import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { packageProblems } from './check-package.mjs';

const profile = JSON.parse(readFileSync(new URL('../profiles/dev.json', import.meta.url), 'utf8'));

/** The configuration the Pages packaging script writes for `profile`. */
function packaged() {
  return {
    name: profile.name,
    account_id: profile.account_id,
    main: 'worker/index.js',
    no_bundle: true,
    compatibility_date: '2026-10-01',
    assets: {
      directory: 'public',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: true,
    },
    durable_objects: {
      bindings: [
        { name: 'PAGES', class_name: 'Page' },
        { name: 'PROJECTS', class_name: 'Space' },
      ],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Page', 'Space'] }],
    triggers: { crons: ['5 0 * * *'] },
    vars: { ...profile.vars, NOTEBOOK_CLOUD_OIDC_FLOW: 'server' },
    workers_dev: false,
    preview_urls: false,
    routes: [
      {
        pattern: profile.custom_domain.hostname,
        zone_name: profile.custom_domain.zone_name,
        custom_domain: true,
      },
    ],
    d1_databases: [
      { binding: 'DB', ...profile.d1.auth },
      { binding: 'PAGES_USAGE', ...profile.d1.usage },
    ],
    r2_buckets: [{ binding: 'PAGES_ASSETS', bucket_name: profile.r2_bucket }],
    observability: { enabled: true },
  };
}

test('the configuration the packaging script writes passes', () => {
  assert.deepEqual(packageProblems(packaged(), profile), []);
});

const refused = {
  'a build command': config => (config.build = { command: 'true' }),
  'a service binding': config => (config.services = [{ binding: 'X', service: 'other' }]),
  'a secrets store binding': config => (config.secrets_store_secrets = []),
  'another Worker name': config => (config.name = 'another-worker'),
  'another account': config => (config.account_id = '0'.repeat(32)),
  'a missing account': config => delete config.account_id,
  'bundling turned on': config => (config.no_bundle = false),
  'another entry module': config => (config.main = '../index.js'),
  'the workers.dev address': config => (config.workers_dev = true),
  'a second route': config => config.routes.push({ pattern: 'app.kilo.ai/*' }),
  'no route': config => delete config.routes,
  'another D1 database': config =>
    (config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000'),
  'a third D1 database': config => config.d1_databases.push(config.d1_databases[0]),
  'another R2 bucket': config => (config.r2_buckets[0].bucket_name = 'another-bucket'),
  'an R2 jurisdiction': config => (config.r2_buckets[0].jurisdiction = 'eu'),
  'a changed profile var': config => (config.vars.PAGES_KILO_APP_URL = 'https://example.com'),
  'a dropped profile var': config => delete config.vars.PAGES_KILO_APP_URL,
  'a var that is not a string': config => (config.vars.EXTRA = { nested: true }),
  'another assets directory': config => (config.assets.directory = '..'),
  "another Worker's Durable Object": config =>
    (config.durable_objects.bindings[0].script_name = 'another-worker'),
  'a transferred Durable Object class': config =>
    config.migrations.push({ tag: 'v2', transferred_classes: [] }),
  'a trigger that is not a cron': config => (config.triggers.events = []),
};

for (const [name, change] of Object.entries(refused)) {
  test(`refuses ${name}`, () => {
    const config = packaged();
    change(config);
    assert.notDeepEqual(packageProblems(config, profile), []);
  });
}

test('refuses a profile without an account', () => {
  const { account_id: _, ...withoutAccount } = profile;
  const config = packaged();
  delete config.account_id;
  assert.notDeepEqual(packageProblems(config, withoutAccount), []);
});
