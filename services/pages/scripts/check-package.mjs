#!/usr/bin/env node
// Check a staged Pages package against its profile before Wrangler reads it.
//
// The package is built by another repository's scripts, and the job that
// deploys it holds a Cloudflare token that reaches every Worker on the
// account. Wrangler trusts its configuration: a `build` command runs where
// Wrangler runs, and a binding may name any resource the token can see. So the
// configuration may hold only the fields listed here, and every field that
// names a Cloudflare resource must say what the profile says.
//
// What the Pages source decides stays open: its Durable Object classes, the
// migrations that add them, cron triggers, asset handling and extra variables.
// A field Pages adds later fails this check until it is listed here.
//
// Wrangler also reads files beside its configuration, so the package may hold
// only the entries the packaging script writes, as regular files.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const CONFIG_FIELDS = [
  'name',
  'account_id',
  'main',
  'no_bundle',
  'compatibility_date',
  'assets',
  'durable_objects',
  'migrations',
  'triggers',
  'vars',
  'workers_dev',
  'preview_urls',
  'routes',
  'd1_databases',
  'r2_buckets',
  'observability',
];
const ASSET_FIELDS = ['directory', 'binding', 'not_found_handling', 'run_worker_first'];
// A migration may only add classes. `deleted_classes` destroys stored
// documents, `renamed_classes` moves them, and `transferred_classes` takes
// storage from another Worker. A release that needs one of them changes this
// list in the same pull request that moves the pin.
const MIGRATION_FIELDS = ['tag', 'new_sqlite_classes'];
const PACKAGE_ENTRIES = ['build-receipt.json', 'public', 'worker', 'wrangler.json'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unknownFields = (value, known) => Object.keys(value).filter(key => !known.includes(key));

/** Every way `config` departs from what `profile` allows; empty when it may be
 * deployed. */
export function packageProblems(config, profile) {
  const problems = [];
  const expect = (ok, message) => {
    if (!ok) problems.push(message);
  };
  if (!isObject(config)) return ['wrangler.json must hold an object'];

  for (const field of unknownFields(config, CONFIG_FIELDS))
    problems.push(`${field} is not a field a Pages package may set`);

  expect(config.name === profile.name, 'name must be the profile name');
  expect(
    typeof profile.account_id === 'string' && config.account_id === profile.account_id,
    'account_id must be the profile account_id'
  );
  expect(config.main === 'worker/index.js', 'main must be worker/index.js');
  expect(config.no_bundle === true, 'no_bundle must be true');
  expect(config.workers_dev === profile.workers_dev, 'workers_dev must match the profile');
  expect(config.preview_urls === false, 'preview_urls must be false');

  const domain = profile.custom_domain;
  expect(
    isDeepStrictEqual(
      config.routes,
      domain && [{ pattern: domain.hostname, zone_name: domain.zone_name, custom_domain: true }]
    ),
    'routes must be the profile custom_domain and nothing else'
  );

  expect(
    Array.isArray(config.d1_databases) &&
      isDeepStrictEqual(
        config.d1_databases.map(({ binding: _binding, ...database }) => database),
        [profile.d1?.auth, profile.d1?.usage]
      ) &&
      config.d1_databases.every(database => typeof database.binding === 'string'),
    'd1_databases must be the profile auth and usage databases'
  );
  expect(
    Array.isArray(config.r2_buckets) &&
      config.r2_buckets.length === 1 &&
      isDeepStrictEqual(Object.keys(config.r2_buckets[0]).sort(), ['binding', 'bucket_name']) &&
      config.r2_buckets[0].bucket_name === profile.r2_bucket,
    'r2_buckets must be the profile r2_bucket'
  );

  expect(
    isObject(config.vars) &&
      Object.values(config.vars).every(value => typeof value === 'string') &&
      Object.entries(profile.vars ?? {}).every(([key, value]) => config.vars[key] === value),
    'vars must be strings and carry every profile var unchanged'
  );

  expect(
    isObject(config.assets) &&
      unknownFields(config.assets, ASSET_FIELDS).length === 0 &&
      config.assets.directory === 'public',
    'assets must serve the public directory with known fields'
  );
  // A binding with `script_name` would reach another Worker's objects.
  expect(
    isObject(config.durable_objects) &&
      isDeepStrictEqual(Object.keys(config.durable_objects), ['bindings']) &&
      Array.isArray(config.durable_objects.bindings) &&
      config.durable_objects.bindings.every(
        binding =>
          isObject(binding) &&
          isDeepStrictEqual(Object.keys(binding).sort(), ['class_name', 'name']) &&
          typeof binding.name === 'string' &&
          typeof binding.class_name === 'string'
      ),
    'durable_objects bindings must name only classes of this Worker'
  );
  expect(
    Array.isArray(config.migrations) &&
      config.migrations.every(
        migration => isObject(migration) && unknownFields(migration, MIGRATION_FIELDS).length === 0
      ),
    'migrations may only add classes'
  );
  expect(
    isObject(config.triggers) &&
      isDeepStrictEqual(Object.keys(config.triggers), ['crons']) &&
      Array.isArray(config.triggers.crons) &&
      config.triggers.crons.every(cron => typeof cron === 'string'),
    'triggers must hold only crons'
  );
  expect(
    typeof config.compatibility_date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date),
    'compatibility_date must be a date'
  );
  expect(
    config.observability === undefined || isObject(config.observability),
    'observability must be an object'
  );
  return problems;
}

/** Every entry in the package directory that the packaging script does not
 * write. A symlink could attach a file from the deploying machine as a Worker
 * module or an asset, and a stray file such as `.env` could steer Wrangler. */
export function packageFileProblems(directory) {
  const problems = [];
  const kind = file => {
    const stat = lstatSync(file);
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  };
  const walk = relative => {
    for (const name of readdirSync(path.join(directory, relative)).sort()) {
      const entry = path.join(relative, name);
      const found = kind(path.join(directory, entry));
      if (found === 'other') problems.push(`${entry} must be a regular file or a directory`);
      else if (found === 'directory' && relative === 'worker')
        problems.push(`${entry} must be a file: worker holds only modules`);
      else if (found === 'directory') walk(entry);
    }
  };

  const present = readdirSync(directory).sort();
  for (const name of present)
    if (!PACKAGE_ENTRIES.includes(name)) problems.push(`${name} is not part of a Pages package`);
  for (const name of PACKAGE_ENTRIES)
    if (!present.includes(name)) problems.push(`The package has no ${name}`);
  if (problems.length) return problems;

  for (const name of PACKAGE_ENTRIES) {
    const expected = name.endsWith('.json') ? 'file' : 'directory';
    if (kind(path.join(directory, name)) !== expected)
      problems.push(`${name} must be a ${expected}`);
  }
  if (problems.length) return problems;

  walk('worker');
  walk('public');
  if (!readdirSync(path.join(directory, 'worker')).includes('index.js'))
    problems.push('The package has no worker/index.js');
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [profileName, directory, ...extra] = process.argv.slice(2);
  if (extra.length || !profileName || !directory) {
    console.error('Usage: check-package.mjs PROFILE PACKAGE_DIRECTORY');
    process.exit(2);
  }
  if (!/^[a-z0-9-]+$/.test(profileName)) {
    console.error('Name a profile in profiles/, such as dev');
    process.exit(2);
  }
  const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const profile = JSON.parse(
    readFileSync(path.join(service, 'profiles', `${profileName}.json`), 'utf8')
  );
  const problems = packageFileProblems(directory);
  // The configuration is read only once it is known to be a regular file.
  const config = problems.length
    ? undefined
    : JSON.parse(readFileSync(path.join(directory, 'wrangler.json'), 'utf8'));
  if (config) problems.push(...packageProblems(config, profile));
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`The package matches profile ${profileName}: Worker ${config.name}`);
}
