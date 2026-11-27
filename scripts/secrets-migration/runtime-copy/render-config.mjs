#!/usr/bin/env node
// Renders one source Worker's temporary copier Wrangler config from names-only run pins into
// runner scratch. The config is never tracked: every field except the five run vars is fixed here
// or by that Worker's reviewed batch (src/table.mjs), and the absolute module paths point at this
// checkout's src/. No credential is an input or an output.
//
//   node scripts/secrets-migration/runtime-copy/render-config.mjs \
//     --run-id m65-<[a-z0-9-]{8,60}> --batch <source Worker> --not-before <YYYY-MM-DDTHH:MM:SSZ> \
//     --not-after <YYYY-MM-DDTHH:MM:SSZ> --client-id <uuid> --out <path outside the repository>
//
// Rules: the batch is a Worker of the valid table, not-before at least 16 minutes from now (cron
// changes take up to 15 minutes to propagate), window length 5 to 30 minutes, output written once
// with mode 0600. Prints one JSON line: {configPath, configSha256, name, cron, notBefore, notAfter}.

import { createHash } from 'node:crypto';
import { closeSync, openSync, realpathSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRON, PIN_FORMAT, RUN_VARS, copierName, windowOf } from './src/core.mjs';
import { TABLE } from './src/table.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = join(HERE, 'src');
export const REPO_ROOT = resolve(HERE, '../../..');
export const COMPATIBILITY_DATE = '2026-06-01';
export const MIN_LEAD_MS = 16 * 60_000;
export const OBSERVABILITY = Object.freeze({
  enabled: true,
  head_sampling_rate: 1,
  logs: { invocation_logs: false },
  traces: { enabled: false },
});

/**
 * Names-only pin problems; empty when the pins are usable at `nowMs`. `table` is the checked-in
 * table; tests pass a fixture table.
 */
export function pinProblems(pins, nowMs, table = TABLE) {
  const f = [];
  for (const k of RUN_VARS) if (!PIN_FORMAT[k].test(String(pins[k]))) f.push(`pin_${k}`);
  if (!f.includes('pin_M65_BATCH') && !Object.hasOwn(table.batches, pins.M65_BATCH)) {
    f.push('batch_not_in_table');
  }
  if (f.length) return f;
  const win = windowOf(pins);
  if (!win) return ['window_length'];
  if (win.notBefore - nowMs < MIN_LEAD_MS) return ['not_before_too_soon'];
  return [];
}

/**
 * The complete config for `pins`, or null when `pins.M65_BATCH` is not a Worker of the valid table.
 * `srcDir` is absolute so the file can live outside the repo.
 */
export function buildConfig(pins, srcDir = SRC_DIR, table = TABLE) {
  const batch = Object.hasOwn(table.batches, pins?.M65_BATCH)
    ? table.batches[pins.M65_BATCH]
    : null;
  if (!batch) return null;
  return {
    name: copierName(batch.sourceScript),
    account_id: batch.accountId,
    main: join(srcDir, 'worker.mjs'),
    compatibility_date: COMPATIBILITY_DATE,
    no_bundle: true,
    find_additional_modules: true,
    base_dir: srcDir,
    rules: [{ type: 'ESModule', globs: ['**/*.mjs'] }],
    workers_dev: false,
    preview_urls: false,
    routes: [],
    triggers: { crons: [CRON] },
    observability: structuredClone(OBSERVABILITY),
    logpush: false,
    upload_source_maps: false,
    vars: Object.fromEntries(RUN_VARS.map(k => [k, pins[k]])),
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    durable_objects: { bindings: [{ name: 'M65_GATE', class_name: 'M65Gate' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['M65Gate'] }],
    secrets_store_secrets: batch.rows.map(r => ({
      binding: r.binding,
      store_id: r.storeId,
      secret_name: r.secretName,
    })),
  };
}

const FLAGS = {
  '--run-id': 'M65_RUN_ID',
  '--batch': 'M65_BATCH',
  '--not-before': 'M65_NOT_BEFORE',
  '--not-after': 'M65_NOT_AFTER',
  '--client-id': 'M65_INFISICAL_CLIENT_ID',
  '--out': 'out',
};

export function parseArgs(argv) {
  const got = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i]];
    if (!key || key in got || argv[i + 1] === undefined) throw new Error('usage');
    got[key] = argv[i + 1];
  }
  if (Object.keys(got).length !== Object.keys(FLAGS).length) throw new Error('usage');
  return got;
}

/** True when `path` (whose parent must exist) resolves inside the repository checkout. */
export function insideRepo(path) {
  const parent = realpathSync(dirname(resolve(path)));
  const rel = relative(realpathSync(REPO_ROOT), parent);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    process.stderr.write('render-config: usage error\n');
    return 2;
  }
  const problems = pinProblems(args, Date.now());
  if (problems.length) {
    process.stderr.write(`render-config: refused ${problems.join(',')}\n`);
    return 2;
  }
  let inside;
  try {
    inside = insideRepo(args.out);
  } catch {
    inside = true;
  }
  if (inside) {
    process.stderr.write('render-config: refused out_path_inside_repo_or_unresolvable\n');
    return 2;
  }
  const text = `${JSON.stringify(buildConfig(args), null, 2)}\n`;
  let fd;
  try {
    fd = openSync(resolve(args.out), 'wx', 0o600);
    writeSync(fd, text);
  } catch {
    process.stderr.write('render-config: refused out_path_exists_or_unwritable\n');
    return 2;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  process.stdout.write(
    `${JSON.stringify({
      configPath: resolve(args.out),
      configSha256: createHash('sha256').update(text).digest('hex'),
      name: copierName(args.M65_BATCH),
      cron: CRON,
      notBefore: args.M65_NOT_BEFORE,
      notAfter: args.M65_NOT_AFTER,
    })}\n`
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
