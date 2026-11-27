#!/usr/bin/env node
// Runner-side gates for the temporary runtime copiers (one per source Worker of the reviewed row
// table): table and tracked-source match, rendered config, the receipt parser, and the preflight,
// post-run and cleanup gates over names-only metadata. Pure functions; no Cloudflare runtime
// import, no credential, no value. Every gate takes the source Worker's batch explicitly.
//
//   node scripts/secrets-migration/runtime-copy/checks.mjs source|table      (every table Worker)
//   node scripts/secrets-migration/runtime-copy/checks.mjs <gate> <worker>  < input.json
//   gates: config | receipt | preflight | postrun | cleanup (and their -cloudflare/-infisical halves)
// stdout: one JSON verdict {gate, ok, failures, ...}; exit 0 ok, 1 failed, 2 usage or unreadable.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT_ID,
  ALLOWED_STORE_IDS,
  CRON,
  OUTCOMES,
  PIN_FORMAT,
  RECEIPT_SCHEMA,
  RUN_VARS,
  VERSION_ID,
  WRITER_SECRET,
  copierName,
  newReceipt,
  validateBatch,
  windowOf,
} from './src/core.mjs';
import { BATCHES, TABLE_PROBLEMS, WORKERS } from './src/table.mjs';
import { COMPATIBILITY_DATE, REPO_ROOT, SRC_DIR, buildConfig } from './render-config.mjs';

export const MODULES = Object.freeze(['worker.mjs', 'core.mjs', 'table.mjs']);
const ACCESS_TOKEN_TTL_S = 300;
const CLIENT_SECRET_GRACE_MS = 15 * 60_000;

// JSONC: drop // and /* */ comments outside strings, then trailing commas.
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) throw new Error('unterminated comment');
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const canon = v =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, canon(v[k])])
        )
      : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// The folder rule of each Worker's lookup names lives in its WORKER_SOURCES entry (`workloadPrefix`).

// Minimal reader for the policy file's flat shape (scalars, lists of scalars, identity.kind).
export function parsePolicy(text) {
  const p = { lists: {} };
  let list = null;
  let block = null;
  for (const line of text.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    let m;
    if ((m = /^([a-z_]+):\s*(\S.*)?$/.exec(line))) {
      list = block = null;
      if (m[2] !== undefined) p[m[1]] = m[2].trim();
      else {
        list = block = m[1];
        p.lists[list] = [];
      }
    } else if ((m = /^\s+-\s+(\S+)\s*$/.exec(line)) && list) p.lists[list].push(m[1]);
    else if ((m = /^\s+([a-z_]+):\s*(\S+)\s*$/.exec(line)) && block) {
      p[`${block}.${m[1]}`] = m[2];
      list = null;
    } else throw new Error('policy shape not recognized');
  }
  return p;
}

const storeRows = bindings =>
  (bindings ?? [])
    .filter(b => b.type === 'secrets_store_secret')
    .map(b => ({ binding: b.name, storeId: b.store_id, secretName: b.secret_name }));
const bindingRows = rows =>
  rows.map(r => ({ binding: r.binding, storeId: r.storeId, secretName: r.secretName }));
const nameRow = r => ({
  binding: r.binding,
  storeId: r.storeId,
  secretName: r.secretName,
  secretPath: r.secretPath,
  secretKey: r.secretKey,
});
const STORE = ALLOWED_STORE_IDS[0];
const names = rows =>
  Object.freeze(
    rows.map(([binding, secretName, secretPath, secretKey]) =>
      Object.freeze({ binding, storeId: STORE, secretName, secretPath, secretKey })
    )
  );

/**
 * M89b per source Worker: every Secrets Store binding of its production config with the STS lookup
 * name (= Infisical target key) and folder, the reader map that resolves those lookup names, the STS
 * policy, and the intentional aliases. `checkSource` holds each entry to the tracked files; a copy
 * batch's rows must be rows of its Worker's `names`. A table Worker without an entry here is refused
 * (`worker_source_unreviewed`): adding a Worker means reviewing its reader shape and this entry.
 * Notifications keeps all four names (three are copied from 1Password by secrets-cutover, M108).
 */
export const WORKER_SOURCES = Object.freeze({
  notifications: Object.freeze({
    wrangler: 'services/notifications/wrangler.jsonc',
    reader: 'services/notifications/src/secrets.ts',
    readerMap: 'SECRETS_STORE_BINDINGS',
    policy: 'services/sts/policy/notifications.yaml',
    workload: 'notifications',
    folder: '/workloads/notifications',
    workloadPrefix: 'NOTIFICATIONS_',
    productionVars: Object.freeze({ WORKER_ENV: 'production' }),
    stagingStoreBindings: Object.freeze([]),
    aliases: Object.freeze({
      NOTIFICATIONS_APNS_PRIVATE_KEY: 'APNS_PRIVATE_KEY',
      NOTIFICATIONS_EXPO_ACCESS_TOKEN: 'EXPO_ACCESS_TOKEN',
    }),
    names: names([
      [
        'APNS_PRIVATE_KEY',
        'APNS_PRIVATE_KEY_PROD',
        '/workloads/notifications',
        'NOTIFICATIONS_APNS_PRIVATE_KEY',
      ],
      [
        'EXPO_ACCESS_TOKEN',
        'EXPO_ACCESS_TOKEN',
        '/workloads/notifications',
        'NOTIFICATIONS_EXPO_ACCESS_TOKEN',
      ],
      ['NEXTAUTH_SECRET', 'NEXTAUTH_SECRET_PROD', '/shared', 'NEXTAUTH_SECRET'],
      ['INTERNAL_API_SECRET', 'INTERNAL_API_SECRET_PROD', '/shared', 'INTERNAL_API_SECRET'],
    ]),
  }),
});

export const sourceOf = batch =>
  Object.hasOwn(WORKER_SOURCES, String(batch?.sourceScript))
    ? WORKER_SOURCES[batch.sourceScript]
    : null;

/**
 * A Worker's reader map in its secrets module: `const <readerMap> = { LOOKUP: 'BINDING', ... } as
 * const;` -> STS lookup name (the name the code passes to its reader) -> legacy binding.
 */
export function parseReaderBindings(readerText, readerMap = 'SECRETS_STORE_BINDINGS') {
  if (!/^[A-Z][A-Z0-9_]*$/.test(readerMap)) throw new Error('reader map name not recognized');
  const m = new RegExp(`const ${readerMap} = \\{([^}]*)\\} as const;`).exec(readerText);
  if (!m) throw new Error('reader map not found');
  const map = {};
  for (const line of m[1].split('\n')) {
    if (line.trim() === '') continue;
    const e = /^\s*([A-Z][A-Z0-9_]*): '([A-Z][A-Z0-9_]*)',\s*$/.exec(line);
    if (!e || e[1] in map) throw new Error('reader map shape not recognized');
    map[e[1]] = e[2];
  }
  return map;
}

/**
 * One Worker against the reviewed table and its tracked sources. The batch must be exactly the
 * table's batch for that Worker. Its WORKER_SOURCES names must equal the production Wrangler config
 * (binding -> store name), the reader map (target key = the STS lookup name that indexes that
 * binding) and the STS policy (exactly these keys). A target is never a store name and never
 * carries an environment suffix; the only key/binding differences are the reviewed aliases. Every
 * copy batch row must be exactly one names row, in the Worker's own workload folder.
 */
export function checkSource(wranglerText, policyText, readerText, batch, src = sourceOf(batch)) {
  const f = [];
  if (TABLE_PROBLEMS.length > 0) f.push('table_invalid');
  const worker = String(batch?.sourceScript);
  if (!Object.hasOwn(BATCHES, worker) || !same(batch, BATCHES[worker])) {
    f.push('batch_not_in_table');
  }
  const bv = validateBatch(batch);
  if (bv) f.push(`batch_${bv}`);
  if (!src) return [...f, 'worker_source_unreviewed'];
  const rows = Array.isArray(batch?.rows) ? batch.rows : [];
  for (const r of rows) {
    if (src.names.filter(n => same(nameRow(n), nameRow(r ?? {}))).length !== 1) {
      f.push(`batch_row_not_in_name_map_${r?.secretKey}`);
    }
    if (r?.secretPath !== src.folder) f.push(`batch_row_folder_${r?.secretKey}`);
  }
  const cfg = parseJsonc(wranglerText);
  if (
    cfg.name !== worker ||
    cfg.account_id !== ACCOUNT_ID ||
    Object.entries(src.productionVars).some(([k, v]) => cfg.vars?.[k] !== v)
  ) {
    f.push('source_script_identity');
  }
  const live = (cfg.secrets_store_secrets ?? []).map(s => ({
    binding: s.binding,
    storeId: s.store_id,
    secretName: s.secret_name,
  }));
  if (!same(live, bindingRows(src.names))) f.push('source_bindings_differ');
  if (!same(cfg.env?.staging?.secrets_store_secrets, src.stagingStoreBindings)) {
    f.push('source_staging_binds_store');
  }
  let reader = null;
  try {
    reader = parseReaderBindings(readerText, src.readerMap);
  } catch {
    f.push('reader_map_unreadable');
  }
  if (reader) {
    if (!same(Object.keys(reader).sort(), src.names.map(r => r.secretKey).sort())) {
      f.push('reader_keys_differ');
    }
    for (const r of src.names) {
      if (reader[r.secretKey] !== r.binding) f.push(`reader_lookup_differs_${r.secretKey}`);
    }
    const aliases = Object.fromEntries(Object.entries(reader).filter(([k, b]) => k !== b));
    if (!same(aliases, src.aliases)) f.push('reader_aliases_differ');
  }
  const pol = parsePolicy(policyText);
  if (
    pol.workload !== src.workload ||
    !same(pol.lists.environments, ['production']) ||
    pol['identity.kind'] !== 'worker-binding'
  ) {
    f.push('policy_identity');
  }
  if (!same([...(pol.lists.secrets ?? [])].sort(), src.names.map(r => r.secretKey).sort())) {
    f.push('policy_targets_differ');
  }
  for (const r of src.names) {
    const inWorkload = r.secretKey.startsWith(src.workloadPrefix);
    if (r.secretPath !== (inWorkload ? src.folder : '/shared')) {
      f.push(`target_folder_${r.secretKey}`);
    }
    if (src.names.some(x => x.secretName === r.secretKey))
      f.push(`target_is_store_name_${r.secretKey}`);
    if (/_(PROD|DEV|STAGING)$/.test(r.secretKey))
      f.push(`target_environment_suffix_${r.secretKey}`);
  }
  return f;
}

export function readTrackedSource(src, root = REPO_ROOT) {
  return {
    wranglerText: readFileSync(join(root, src.wrangler), 'utf8'),
    policyText: readFileSync(join(root, src.policy), 'utf8'),
    readerText: readFileSync(join(root, src.reader), 'utf8'),
  };
}

/**
 * One row per names row of a Worker, each column read from its own tracked source: the old binding
 * and its backing store name from the production Wrangler config, the STS lookup name from the
 * reader map (the key whose binding it is), and the matching policy entry. `checkSource` proves
 * they agree.
 */
export function mappingRows({ wranglerText, policyText, readerText }, src) {
  const store = Object.fromEntries(
    (parseJsonc(wranglerText).secrets_store_secrets ?? []).map(s => [s.binding, s.secret_name])
  );
  const reader = parseReaderBindings(readerText, src.readerMap);
  const policy = parsePolicy(policyText).lists.secrets ?? [];
  return src.names.map(r => {
    const lookups = Object.keys(reader).filter(k => reader[k] === r.binding);
    const lookup = lookups.length === 1 ? lookups[0] : null;
    return {
      binding: r.binding,
      storeSecretName: store[r.binding] ?? null,
      lookup,
      target: `${r.secretPath}/${r.secretKey}`,
      policyEntry: lookup !== null && policy.filter(p => p === lookup).length === 1 ? lookup : null,
    };
  });
}

/** Names-only four-column table from `mappingRows`. */
export function mappingTable(rows) {
  const header = [
    'old binding name',
    'store secret_name (if any)',
    'STS lookup name (= Infisical target)',
    'policy entry',
  ];
  const body = rows.map(r => [
    r.binding,
    r.storeSecretName ?? '(none)',
    r.lookup === null ? '(missing)' : `${r.lookup} (${r.target})`,
    r.policyEntry ?? '(missing)',
  ]);
  return [header, ...body].map(cols => cols.join(' | ')).join('\n');
}

/**
 * Reads one Worker's tracked sources under `root`, validates them (`checkSource`) and returns the
 * names-only table of all its lookup names: {gate:"table", worker, ok, failures, rows:[{binding,
 * storeSecretName, lookup, target, policyEntry}], table}. Callers must refuse when `ok` is false.
 */
export function validatedNameTable(batch, root = REPO_ROOT) {
  const src = sourceOf(batch);
  const worker = typeof batch?.sourceScript === 'string' ? batch.sourceScript : null;
  if (!src) {
    return {
      gate: 'table',
      worker,
      ok: false,
      failures: checkSource('', '', '', batch, null),
      rows: [],
      table: '',
    };
  }
  const sources = readTrackedSource(src, root);
  const failures = checkSource(
    sources.wranglerText,
    sources.policyText,
    sources.readerText,
    batch,
    src
  );
  let rows = [];
  try {
    rows = mappingRows(sources, src);
  } catch {
    failures.push('mapping_rows_unreadable');
  }
  if (rows.some(r => r.storeSecretName === null || r.lookup === null || r.policyEntry === null)) {
    failures.push('mapping_row_missing');
  }
  if (
    rows.some(
      r => r.target !== `${src.names.find(x => x.binding === r.binding)?.secretPath}/${r.lookup}`
    )
  ) {
    failures.push('mapping_target_not_lookup');
  }
  return {
    gate: 'table',
    worker,
    ok: failures.length === 0,
    failures,
    rows,
    table: mappingTable(rows),
  };
}

/** A rendered config file must equal `buildConfig(pins)` exactly. */
export function checkRenderedConfig(text, pins, srcDir = SRC_DIR) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return ['config_unparsable'];
  }
  return same(cfg, buildConfig(pins, srcDir)) ? [] : ['config_not_closed'];
}

export function moduleHashes(srcDir = SRC_DIR) {
  return Object.fromEntries(
    MODULES.map(m => [
      m,
      createHash('sha256')
        .update(readFileSync(join(srcDir, m)))
        .digest('hex'),
    ])
  );
}

// ---------- receipts ----------

const ROW_BASE = ['binding', 'sourceSecretName', 'secretPath', 'secretKey', 'read'];
const ROW_STEP = [
  'storable',
  'referenceFree',
  'bytesParity',
  'serializationParity',
  'created',
  'echo',
];
const ENUM = {
  outcome: ['refused', 'unarmed', 'idle', ...OUTCOMES],
  window: ['invalid', 'before', 'open', 'closed'],
  gate: ['not_attempted', 'consumed_now', 'already_consumed', 'ambiguous'],
  created: ['not_attempted', 'unknown', 'no', 'pending', 'yes'],
  echo: [null, 'equal', 'differs', 'absent'],
};
const READY_KEYS = ['bindings', 'cron', 'envClosed', 'gate', 'pins'];
const isBool = v => typeof v === 'boolean';
const isCount = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

/**
 * Parses one logged receipt line (the JSON text the Worker wrote). Accepts exactly the receipt
 * fields with their fixed types and enums; anything else is refused, so nothing extra can pass.
 * Returns {ok, failures, receipt}.
 */
export function parseReceipt(text, batch) {
  let r;
  try {
    r = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { ok: false, failures: ['receipt_unparsable'], receipt: null };
  }
  const f = [];
  const want = Object.keys(newReceipt(batch.id)).sort();
  if (!r || typeof r !== 'object' || Array.isArray(r) || !same(Object.keys(r).sort(), want)) {
    return { ok: false, failures: ['receipt_keys'], receipt: null };
  }
  if (r.schema !== RECEIPT_SCHEMA || r.batch !== batch.id) f.push('receipt_schema');
  if (r.runId !== null && !PIN_FORMAT.M65_RUN_ID.test(String(r.runId))) f.push('receipt_run_id');
  if (r.versionId !== null && !VERSION_ID.test(String(r.versionId))) f.push('receipt_version_id');
  for (const k of ['outcome', 'window', 'gate'])
    if (!ENUM[k].includes(r[k])) f.push(`receipt_${k}`);
  if (r.reason !== null && !/^[a-z0-9_]{1,64}$/.test(String(r.reason))) f.push('receipt_reason');
  if (r.prior !== null && !OUTCOMES.includes(r.prior)) f.push('receipt_prior');
  if (![r.armed, r.revoked, r.denialProved].every(isBool)) f.push('receipt_flags');
  if (
    r.ready !== null &&
    (typeof r.ready !== 'object' ||
      !same(Object.keys(r.ready).sort(), READY_KEYS) ||
      !Object.values(r.ready).every(isBool))
  ) {
    f.push('receipt_ready');
  }
  if (
    !isCount(r.logins, 1) ||
    !isCount(r.reads, batch.rows.length) ||
    !isCount(r.posts, batch.rows.length)
  ) {
    f.push('receipt_counts');
  }
  if (!Array.isArray(r.rows) || r.rows.length > batch.rows.length) f.push('receipt_rows');
  else {
    r.rows.forEach((row, i) => {
      const keys = Object.keys(row ?? {});
      const want = batch.rows[i];
      const allowed = [...ROW_BASE, ...ROW_STEP];
      if (
        !ROW_BASE.every(k => keys.includes(k)) ||
        !keys.every(k => allowed.includes(k)) ||
        row.binding !== want.binding ||
        row.sourceSecretName !== want.secretName ||
        row.secretPath !== want.secretPath ||
        row.secretKey !== want.secretKey ||
        !isBool(row.read) ||
        ['storable', 'referenceFree', 'bytesParity', 'serializationParity'].some(
          k => k in row && !isBool(row[k])
        ) ||
        ('created' in row && !ENUM.created.includes(row.created)) ||
        ('echo' in row && !ENUM.echo.includes(row.echo))
      ) {
        f.push(`receipt_row_${i}`);
      }
    });
  }
  return { ok: f.length === 0, failures: f, receipt: f.length === 0 ? r : null };
}

// ---------- preflight ----------

const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = v => (Array.isArray(v) ? v : []);
const absent = v => v === undefined || v === null;
const emptyList = v => absent(v) || (Array.isArray(v) && v.length === 0);
const fullSampling = v => absent(v) || v === 1;
const onlyKeys = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const informational = () => true;

/**
 * Observability as `GET /settings` returns it: enabled, every invocation sampled, logs on and
 * persisted without invocation logs, and no log, trace or agent export. Unknown keys refuse.
 */
function observabilitySafe(o) {
  if (
    !isRecord(o) ||
    !onlyKeys(o, [
      'agents',
      'enabled',
      'head_sampling_rate',
      'issues',
      'logs',
      'redact_query_string',
      'traces',
    ])
  ) {
    return false;
  }
  const { logs: l, traces: t, agents: a, issues: i } = o;
  return (
    o.enabled === true &&
    fullSampling(o.head_sampling_rate) &&
    isRecord(l) &&
    onlyKeys(l, ['destinations', 'enabled', 'head_sampling_rate', 'invocation_logs', 'persist']) &&
    l.enabled === true &&
    l.invocation_logs === false &&
    fullSampling(l.head_sampling_rate) &&
    emptyList(l.destinations) &&
    (absent(l.persist) || l.persist === true) &&
    (absent(t) ||
      (isRecord(t) &&
        onlyKeys(t, [
          'destinations',
          'enabled',
          'head_sampling_rate',
          'persist',
          'propagation_policy',
        ]) &&
        t.enabled === false &&
        emptyList(t.destinations))) &&
    (absent(a) || (isRecord(a) && a.enabled !== true)) &&
    (absent(i) || isRecord(i)) &&
    (absent(o.redact_query_string) || typeof o.redact_query_string === 'boolean')
  );
}

// Every documented field of the settings result, each held to a value that opens no ingress,
// export, cache zone, extra runtime feature or placement. Bindings are judged only from the
// serving version's readback, never from settings.
const COPIER_SETTING_RULES = Object.freeze({
  annotations: informational,
  bindings: informational,
  cache_options: v => absent(v) || (isRecord(v) && v.enabled === false),
  compatibility_date: v => v === COMPATIBILITY_DATE,
  compatibility_flags: emptyList,
  exports: v =>
    absent(v) ||
    (isRecord(v) &&
      Object.entries(v).every(
        ([name, e]) =>
          isRecord(e) &&
          (e.type === 'worker'
            ? absent(e.cache) || (isRecord(e.cache) && e.cache.enabled === false)
            : e.type === 'durable-object' && name === 'M65Gate' && absent(e.container))
      )),
  exports_reconciliation: informational,
  limits: informational,
  logpush: v => absent(v) || v === false,
  migrations: informational,
  observability: observabilitySafe,
  placement: v => absent(v) || (isRecord(v) && Object.keys(v).length === 0),
  tags: informational,
  tail_consumers: emptyList,
  usage_model: informational,
});

/**
 * Problems in the copier's raw `GET /workers/scripts/<copier>/settings` result. The uploaded
 * config is never compared to it; an undocumented field refuses.
 */
function copierSettingsProblems(settings) {
  if (!isRecord(settings)) return ['copier_settings_unread'];
  const keys = new Set([...Object.keys(settings), ...Object.keys(COPIER_SETTING_RULES)]);
  const f = [];
  for (const k of [...keys].sort()) {
    if (!Object.hasOwn(COPIER_SETTING_RULES, k)) f.push('copier_setting_unknown');
    else if (!COPIER_SETTING_RULES[k](settings[k])) f.push(`copier_setting_${k}`);
  }
  return [...new Set(f)];
}

/**
 * The one version serving 100% of a script, with the bindings read back from that exact version
 * (`GET /workers/scripts/<name>/versions/<id>`, `resources.bindings`), never from script settings
 * or the latest upload. input: {deployments: [{version_id, percentage}], version: {id, bindings}}.
 * Null unless the shape is exact, one deployment entry carries 100% and the readback names it.
 */
function servingVersion(script) {
  const d = script?.deployments;
  const v = script?.version;
  const ok =
    Array.isArray(d) &&
    d.length === 1 &&
    isRecord(d[0]) &&
    same(Object.keys(d[0]).sort(), ['percentage', 'version_id']) &&
    d[0].percentage === 100 &&
    typeof d[0].version_id === 'string' &&
    VERSION_ID.test(d[0].version_id) &&
    isRecord(v) &&
    same(Object.keys(v).sort(), ['bindings', 'id']) &&
    v.id === d[0].version_id &&
    Array.isArray(v.bindings) &&
    v.bindings.every(b => isRecord(b) && typeof b.name === 'string' && typeof b.type === 'string');
  return ok ? { id: v.id, bindings: v.bindings } : null;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const WRITER_BINDING = Object.freeze({ name: WRITER_SECRET, type: 'secret_text' });

/** The unarmed copier's exact bindings for `pins`: everything except the writer secret. */
const unarmedCopierBindings = (pins, batch) =>
  [
    ...bindingRows(batch.rows).map(m => ({
      name: m.binding,
      type: 'secrets_store_secret',
      store_id: m.storeId,
      secret_name: m.secretName,
    })),
    { name: 'M65_GATE', type: 'durable_object_namespace', class_name: 'M65Gate' },
    { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
    ...RUN_VARS.map(v => ({ name: v, type: 'plain_text', text: pins[v] })),
  ].sort(byName);

// Full binding objects: only a self-reference to the copier's own gate namespace is dropped.
const comparableCopierBindings = (bindings, gateNsId, copier) =>
  bindings
    .map(b => {
      const o = { ...b };
      if (o.type === 'durable_object_namespace') {
        if (o.script_name === copier) delete o.script_name;
        if (gateNsId !== null && o.namespace_id === gateNsId) delete o.namespace_id;
      }
      return o;
    })
    .sort(byName);

// True when an Infisical folder or permission path covers `target`. Understood exactly: literal
// paths, "/x/**", "/**", "**", "/". Any other glob (picomatch syntax) or unreadable value counts
// as covering, so the gate fails closed.
const GLOB = /[*?[\]{}!()+@]/;
export function pathCovers(path, target) {
  if (typeof path !== 'string' || path === '') return true;
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (p === '' || p === '/' || p === '**' || p === '/**') return true;
  const base = p.endsWith('/**') ? p.slice(0, -3) : p;
  if (GLOB.test(base)) return true;
  return target === base || target.startsWith(`${base}/`);
}

// Only a scalar naming a known non-production environment is excluded.
const NON_PRODUCTION = new Set(['staging', 'development', 'dev', 'test']);
const isProd = env => !(typeof env === 'string' && NON_PRODUCTION.has(env));

// Proof that a preflight verdict came from `evaluatePreflight` in this process and passed: the
// pins it returned and the unarmed bindings it verified. `bindArmedPreflight` accepts nothing else.
const VERIFIED = new WeakMap();
const NO_PINS = Object.freeze({
  runId: null,
  versionId: null,
  storeIds: {},
  sourceDeployments: [],
});

/**
 * Preflight on the UNARMED copier, before `wrangler secret put` adds the writer secret.
 * input: {meta, pins, deployedVersionId, allowedReaders, readinessReceipt, nowMs?}
 * - meta.notifications and meta.copier carry `deployments` and the serving `version` readback
 *   (`servingVersion`); meta.copier.settings is the raw settings result.
 * - pins: the four rendered run vars; deployedVersionId: the unarmed version `wrangler deploy`
 *   created, serving 100%.
 * - readinessReceipt: one parsed receipt from that version showing the cron fires before the
 *   window (outcome unarmed, reason writer_not_installed, window before, every ready flag true,
 *   no gate, login, read or post).
 * Malformed input fails closed. Returns {gate:"preflight", ok, failures, pins:{runId, versionId,
 * storeIds, sourceDeployments}}: names and ids only, never a value or a principal. versionId is the
 * unarmed version; `bindArmedPreflight` moves it to the armed version after the put.
 */
export function evaluatePreflight(input, batch, sources = WORKER_SOURCES) {
  try {
    return preflightOf(input, batch, sources);
  } catch {
    return {
      gate: 'preflight',
      ok: false,
      failures: ['preflight_input_malformed'],
      pins: structuredClone(NO_PINS),
    };
  }
}

function preflightOf(input, batch, sources) {
  const meta = isRecord(input?.meta) ? input.meta : {};
  const pins = isRecord(input?.pins) ? input.pins : {};
  const { deployedVersionId, allowedReaders, readinessReceipt } = isRecord(input) ? input : {};
  const nowMs = input?.nowMs === undefined ? Date.now() : input.nowMs;
  const f = [];
  // The batch comes from the reviewed table (the driver checks equality offline before any call);
  // here it must still be closed, and its Worker must have reviewed sources.
  const problem = validateBatch(batch);
  if (problem) f.push(`batch_${problem}`);
  const src = Object.hasOwn(sources, String(batch.sourceScript))
    ? sources[batch.sourceScript]
    : null;
  if (!src) f.push('worker_source_unreviewed');
  const copier = copierName(batch.sourceScript);
  const win = RUN_VARS.every(k => PIN_FORMAT[k].test(String(pins[k]))) ? windowOf(pins) : null;
  if (!win) f.push('pins_invalid');
  else if (!Number.isFinite(nowMs) || !(nowMs < win.notBefore)) {
    f.push('preflight_after_window_open');
  }
  if (pins.M65_BATCH !== batch.sourceScript) f.push('pins_batch_differs');

  const source = servingVersion(meta.source);
  if (!source) f.push('source_serving_version_not_single');
  else if (!same(storeRows(source.bindings), bindingRows(src?.names ?? []))) {
    f.push('source_live_bindings_differ');
  }
  const store = isRecord(meta.store) ? meta.store : {};
  const storeIds = {};
  if (!ALLOWED_STORE_IDS.includes(store.id) || batch.rows.some(r => r.storeId !== store.id)) {
    f.push('store_id');
  }
  for (const r of batch.rows) {
    const hits = list(store.secrets).filter(s => isRecord(s) && s.name === r.secretName);
    const ok =
      hits.length === 1 &&
      hits[0].status === 'active' &&
      Array.isArray(hits[0].scopes) &&
      hits[0].scopes.includes('workers') &&
      typeof hits[0].id === 'string' &&
      /^[0-9a-f]{32}$/.test(hits[0].id);
    if (ok) storeIds[r.secretName] = hits[0].id;
    else f.push(`store_secret_${r.secretName}`);
  }

  const c = isRecord(meta.copier) ? meta.copier : {};
  const gateNs = list(c.doNamespaces).filter(
    d => isRecord(d) && d.script === copier && d.class === 'M65Gate'
  );
  if (gateNs.length !== 1) f.push('copier_gate_namespace_not_single');
  const gateNsId = gateNs.length === 1 && typeof gateNs[0].id === 'string' ? gateNs[0].id : null;
  const serving = servingVersion(c);
  const versionId =
    typeof deployedVersionId === 'string' &&
    VERSION_ID.test(deployedVersionId) &&
    serving?.id === deployedVersionId
      ? deployedVersionId
      : null;
  if (!versionId) f.push('copier_deployment_not_the_unarmed_version');
  const wantCopier = unarmedCopierBindings(pins, batch);
  const gotCopier = serving ? comparableCopierBindings(serving.bindings, gateNsId, copier) : null;
  if (gotCopier?.some(b => b.name === WRITER_SECRET)) f.push('copier_already_armed');
  if (!gotCopier || !same(gotCopier, wantCopier)) f.push('copier_bindings_not_closed');
  f.push(...copierSettingsProblems(c.settings));
  if (
    !isRecord(c.subdomain) ||
    c.subdomain.enabled !== false ||
    c.subdomain.previews_enabled !== false
  ) {
    f.push('copier_workers_dev_or_preview_on');
  }
  for (const k of ['routes', 'domains', 'queueConsumers', 'workflows']) {
    if (!same(c[k], [])) f.push(`copier_${k}_present`);
  }
  if (!same(c.schedules, [CRON])) f.push('copier_schedule_differs');
  if (!same(c.modules, moduleHashes())) f.push('copier_modules_differ');

  const ready = parseReceipt(readinessReceipt ?? null, batch).receipt;
  if (
    !ready ||
    versionId === null ||
    ready.runId !== pins.M65_RUN_ID ||
    ready.versionId !== versionId ||
    ready.outcome !== 'unarmed' ||
    ready.reason !== 'writer_not_installed' ||
    ready.armed !== false ||
    ready.window !== 'before' ||
    ready.ready === null ||
    !Object.values(ready.ready).every(v => v === true) ||
    ready.gate !== 'not_attempted' ||
    ready.prior !== null ||
    ready.logins !== 0 ||
    ready.reads !== 0 ||
    ready.posts !== 0 ||
    ready.rows.length !== 0 ||
    ready.revoked !== false ||
    ready.denialProved !== false
  ) {
    f.push('readiness_receipt_missing');
  }

  const inf = isRecord(meta.infisical) ? meta.infisical : {};
  const names = isRecord(inf.names) ? inf.names : {};
  for (const r of batch.rows) {
    const here = names[r.secretPath];
    if (!Array.isArray(here) || here.includes(r.secretKey)) {
      f.push(`target_present_or_unread_${r.secretKey}`);
    }
  }
  const targets = batch.rows.map(r => `${r.secretPath}/${r.secretKey}`);
  const coversAny = p => targets.some(t => pathCovers(p, t));
  for (const k of ['syncs', 'imports', 'readers', 'approvalPolicies']) {
    if (!Array.isArray(inf[k])) f.push(`infisical_${k}_unread`);
  }
  const covering = (k, pathKey) =>
    list(inf[k]).some(s => !isRecord(s) || (isProd(s.environment) && coversAny(s[pathKey])));
  if (covering('syncs', 'path')) f.push('infisical_sync_covers_target');
  if (covering('imports', 'importPath')) f.push('infisical_import_covers_target');
  if (covering('approvalPolicies', 'path')) f.push('infisical_approval_policy_covers_target');
  const allowed =
    Array.isArray(allowedReaders) &&
    allowedReaders.length > 0 &&
    allowedReaders.every(r => typeof r === 'string' && r !== '')
      ? allowedReaders
      : null;
  if (!allowed) f.push('allowed_readers_unset');
  // One code for every reader outside the allowed list: a verdict never names a principal.
  const readerNotAllowed = list(inf.readers).some(rd => {
    if (!isRecord(rd)) return true;
    const ps = Array.isArray(rd.paths) && rd.paths.length > 0 ? rd.paths : [undefined];
    return isProd(rd.environment) && ps.some(coversAny) && !(allowed ?? []).includes(rd.principal);
  });
  if (readerNotAllowed) f.push('infisical_reader_not_allowed');

  // The Worker-only writer exactly as configured at the issuer (names-only readback): one create
  // permission per batch row (exactly this Worker's table targets) and an access token with one
  // use per create plus one for the denial probe. Login and revoke do not spend a token use.
  const w = isRecord(meta.writer) ? meta.writer : {};
  const key = p =>
    isRecord(p) ? `${p.action}|${p.environment}|${p.secretPath}|${p.secretName}` : '';
  const wantPerms = batch.rows.map(r =>
    key({
      action: 'create',
      environment: 'production',
      secretPath: r.secretPath,
      secretName: r.secretKey,
    })
  );
  if (!same(list(w.permissions).map(key).sort(), wantPerms.sort())) {
    f.push('writer_permissions_not_exact');
  }
  const a = isRecord(w.auth) ? w.auth : {};
  const expiresAt = Date.parse(String(a.clientSecretExpiresAt));
  if (
    w.clientId !== pins.M65_INFISICAL_CLIENT_ID ||
    a.accessTokenTTL !== ACCESS_TOKEN_TTL_S ||
    a.accessTokenMaxTTL !== ACCESS_TOKEN_TTL_S ||
    a.accessTokenNumUsesLimit !== batch.rows.length + 1 ||
    a.clientSecretNumUsesLimit !== 1 ||
    !win ||
    !(expiresAt >= win.notAfter && expiresAt <= win.notAfter + CLIENT_SECRET_GRACE_MS)
  ) {
    f.push('writer_auth_not_bounded');
  }
  const result = {
    gate: 'preflight',
    ok: f.length === 0,
    failures: f,
    pins: {
      runId: win ? pins.M65_RUN_ID : null,
      versionId,
      storeIds,
      sourceDeployments: source ? [{ version_id: source.id, percentage: 100 }] : [],
    },
  };
  if (result.ok) {
    VERIFIED.set(result, {
      pins: structuredClone(result.pins),
      bindings: wantCopier,
      gateNsId,
      copier,
    });
  }
  return result;
}

/**
 * Moves a passed preflight to the armed version after `wrangler secret put`, for the post-run
 * gate's version pin only. It re-checks none of the preflight and never stands in for it.
 * - preflight: the exact passed verdict `evaluatePreflight` returned in this process, pins unchanged.
 * - armedVersionId: the version the put created, a UUID other than the unarmed version.
 * - observed: the caller's post-put copier readback {deployments, version: {id, bindings}}
 *   (`servingVersion`): the armed version serves 100% and its bindings are the verified unarmed
 *   bindings plus exactly the writer secret binding.
 * Returns {gate:"preflight-armed", ok, failures, pins:{runId, unarmedVersionId, versionId,
 * storeIds, sourceDeployments}}; versionId is null unless ok.
 */
export function bindArmedPreflight(preflight, armedVersionId, observed) {
  const f = [];
  const v = isRecord(preflight) ? VERIFIED.get(preflight) : undefined;
  if (
    !v ||
    preflight.ok !== true ||
    !same(preflight.failures, []) ||
    !same(preflight.pins, v.pins)
  ) {
    f.push('preflight_not_verified');
  }
  const unarmedVersionId = v?.pins.versionId ?? null;
  if (
    typeof armedVersionId !== 'string' ||
    !VERSION_ID.test(armedVersionId) ||
    armedVersionId === unarmedVersionId
  ) {
    f.push('armed_version_invalid');
  }
  const serving = servingVersion(observed);
  if (!serving || serving.id !== armedVersionId) f.push('armed_version_not_serving');
  else if (
    !v ||
    !same(
      comparableCopierBindings(serving.bindings, v.gateNsId, v.copier),
      [...v.bindings, WRITER_BINDING].sort(byName)
    )
  ) {
    f.push('armed_bindings_not_writer_only');
  }
  const ok = f.length === 0;
  return {
    gate: 'preflight-armed',
    ok,
    failures: f,
    pins: {
      ...structuredClone(v?.pins ?? NO_PINS),
      unarmedVersionId,
      versionId: ok ? armedVersionId : null,
    },
  };
}

const verdict = (gate, f) => ({ gate, ok: f.length === 0, failures: f });

/**
 * Post-run, Cloudflare half. input: {pre (the `bindArmedPreflight` verdict),
 * meta{source{deployments, version}, store}, receipt}
 * The copy-tick receipt is complete for this run and the armed version; the source is unchanged.
 */
export function evaluatePostRunCloudflare(input, batch, sources = WORKER_SOURCES) {
  const { pre, meta } = input ?? {};
  const f = [];
  const { receipt: r, failures } = parseReceipt(input?.receipt ?? null, batch);
  f.push(...failures);
  if (
    !r ||
    r.outcome !== 'complete' ||
    r.reason !== null ||
    r.gate !== 'consumed_now' ||
    r.runId !== pre?.pins?.runId ||
    r.versionId !== pre?.pins?.versionId ||
    !r.revoked ||
    !r.denialProved ||
    r.reads !== batch.rows.length ||
    r.posts !== batch.rows.length
  ) {
    f.push('receipt_not_complete');
  }
  if (
    !r ||
    r.rows.length !== batch.rows.length ||
    !r.rows.every(
      x =>
        x.created === 'yes' &&
        x.storable &&
        x.referenceFree &&
        x.bytesParity &&
        x.serializationParity &&
        x.echo !== 'differs'
    )
  ) {
    f.push('receipt_rows');
  }
  const source = servingVersion(meta?.source);
  if (
    !source ||
    !same(storeRows(source.bindings), bindingRows(sources[batch.sourceScript]?.names ?? [])) ||
    !same(meta.source.deployments, pre?.pins?.sourceDeployments)
  ) {
    f.push('source_changed_during_run');
  }
  for (const row of batch.rows) {
    const id = pre?.pins?.storeIds?.[row.secretName];
    const hits = (meta?.store?.secrets ?? []).filter(s => s.name === row.secretName && s.id === id);
    if (hits.length !== 1) f.push(`store_secret_replaced_${row.secretName}`);
  }
  return verdict('postrun-cloudflare', f);
}

/** Post-run, Infisical half. input: {meta{infisical{names}}}. Every target is now present. */
export function evaluatePostRunInfisical(input, batch) {
  const names = input?.meta?.infisical?.names;
  const f = batch.rows
    .filter(row => !(names?.[row.secretPath] ?? []).includes(row.secretKey))
    .map(row => `target_absent_${row.secretKey}`);
  return verdict('postrun-infisical', f);
}

/** Post-run: both halves. input: {pre, meta{source, store, infisical{names}}, receipt} */
export function evaluatePostRun(input, batch, sources = WORKER_SOURCES) {
  return verdict('postrun', [
    ...evaluatePostRunCloudflare(input, batch, sources).failures,
    ...evaluatePostRunInfisical(input, batch).failures,
  ]);
}

/**
 * Cleanup, Cloudflare half: only the temporary copier is gone; the source script and every
 * existing deployment are unchanged. input: {meta{copier{scriptStatus, gateNamespacePresent},
 * sourceUnchanged, existingDeploymentsUnchanged}}
 */
export function evaluateCleanupCloudflare(input) {
  const meta = input?.meta;
  const f = [];
  if (meta?.copier?.scriptStatus !== 404) f.push('copier_script_present');
  if (meta?.copier?.gateNamespacePresent !== false) f.push('copier_gate_namespace_present');
  if (meta?.sourceUnchanged !== true) f.push('source_binding_changed');
  if (meta?.existingDeploymentsUnchanged !== true) f.push('existing_deployments_changed');
  return verdict('cleanup-cloudflare', f);
}

/**
 * Cleanup, Infisical half: the temporary writer identity and role are gone, counts are back at
 * baseline, no approval request is open and the writer token is denied. input: {meta{infisical
 * {identityPresent, rolePresent, identities, roles, openApprovalRequestsByWriter},
 * writerTokenStatus}, baseline{identities, roles}}
 */
export function evaluateCleanupInfisical(input) {
  const { meta, baseline } = input ?? {};
  const f = [];
  if (meta?.infisical?.identityPresent !== false || meta?.infisical?.rolePresent !== false) {
    f.push('infisical_actor_present');
  }
  if (
    !Number.isInteger(baseline?.identities) ||
    !Number.isInteger(baseline?.roles) ||
    meta?.infisical?.identities !== baseline.identities ||
    meta?.infisical?.roles !== baseline.roles
  ) {
    f.push('infisical_counts_differ');
  }
  if (meta?.infisical?.openApprovalRequestsByWriter !== 0)
    f.push('infisical_open_approval_requests');
  if (meta?.writerTokenStatus !== 401) f.push('writer_token_not_denied');
  return verdict('cleanup-infisical', f);
}

/** Cleanup: both halves. */
export function evaluateCleanup(input) {
  return verdict('cleanup', [
    ...evaluateCleanupCloudflare(input).failures,
    ...evaluateCleanupInfisical(input).failures,
  ]);
}

// ---------- CLI ----------

const STDIN_GATES = {
  preflight: evaluatePreflight,
  postrun: evaluatePostRun,
  'postrun-cloudflare': evaluatePostRunCloudflare,
  'postrun-infisical': evaluatePostRunInfisical,
  cleanup: evaluateCleanup,
  'cleanup-cloudflare': evaluateCleanupCloudflare,
  'cleanup-infisical': evaluateCleanupInfisical,
};
export const GATES = Object.freeze([
  'source',
  'table',
  'config',
  'receipt',
  ...Object.keys(STDIN_GATES),
]);
const ALL_WORKER_GATES = ['source', 'table'];

/**
 * One gate verdict. `source` and `table` cover the whole table and every Worker; every other gate
 * judges `worker`'s batch (a Worker of the valid table). Null for usage errors.
 */
export function runGate(gate, stdinText, worker) {
  if (ALL_WORKER_GATES.includes(gate)) {
    const per = WORKERS.map(w =>
      gate === 'table'
        ? validatedNameTable(BATCHES[w])
        : { worker: w, ...verdict('source', validatedNameTable(BATCHES[w]).failures) }
    );
    const failures = [...TABLE_PROBLEMS.map(p => `table_${p}`), ...per.flatMap(v => v.failures)];
    return { gate, ok: failures.length === 0, failures, workers: per, modules: moduleHashes() };
  }
  const batch = Object.hasOwn(BATCHES, String(worker)) ? BATCHES[worker] : null;
  if (!batch) return null;
  if (gate === 'receipt') {
    const { ok, failures, receipt } = parseReceipt(String(stdinText).trim(), batch);
    return { gate, ok, failures, receipt };
  }
  let input;
  try {
    input = JSON.parse(stdinText);
  } catch {
    return null;
  }
  if (gate === 'config') return verdict(gate, checkRenderedConfig(input?.configText, input?.pins));
  return STDIN_GATES[gate]?.(input, batch) ?? null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [gate, worker] = process.argv.slice(2);
  const allWorkers = ALL_WORKER_GATES.includes(gate);
  let result = null;
  if (GATES.includes(gate) && process.argv.length === (allWorkers ? 3 : 4)) {
    try {
      result = runGate(gate, allWorkers ? '' : readFileSync(0, 'utf8'), worker);
    } catch {
      result = null;
    }
  }
  if (!result) {
    process.stderr.write('checks: usage or unreadable input\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
