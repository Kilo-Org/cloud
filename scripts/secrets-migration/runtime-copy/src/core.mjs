// Runtime core of the temporary runtime copier Worker (one per source Worker). One cron tick
// decides, in order:
//   batch, env, pins and cron checks (refused) -> writer secret absent (unarmed receipt) ->
//   window closed (idle receipt) -> durable one-time gate (Durable Object insert) -> one Universal
//   Auth login -> per row: one binding read, storable and parity checks, one Create-only POST ->
//   after the last row or the first stop: one revoke and one denial probe.
// M122: the batches come from the reviewed row table (table.mjs, `validateTable`): one batch per
// source Worker, Create-only targets in that Worker's one `/workloads/<folder>`, plus (M142) only
// the exact `/shared/<KEY>` targets of SHARED_TARGETS, each created by one matrix entry.
// The writer's access token has rows + 1 uses: one per create and the denial probe.
// Nothing reads a binding or calls Infisical before the gate admits this run once. Receipts carry
// names, booleans and fixed flags only: no value, digest, credential, id or provider response.

export const API_BASE = 'https://eu.infisical.com';
export const PROJECT_ID = '8cf601df-1c5a-4c8f-9e21-7e9af6728b06'; // EU project "kilo"
export const RECEIPT_SCHEMA = 'm65-copy-receipt/1';
export const CRON = '* * * * *';
// Every source Worker and copier lives in this one Cloudflare account.
export const ACCOUNT_ID = 'e115e769bcdd4c3d66af59d3332cb394';
// Reviewed Secrets Store ids a table row may read from.
export const ALLOWED_STORE_IDS = Object.freeze(['342a86d9e3a94da698e82d0c6e2a36f0']);
export const MAX_ROWS_PER_WORKER = 16;
export const RUN_VARS = Object.freeze([
  'M65_RUN_ID',
  'M65_BATCH',
  'M65_NOT_BEFORE',
  'M65_NOT_AFTER',
  'M65_INFISICAL_CLIENT_ID',
]);
export const WRITER_SECRET = 'M65_INFISICAL_CLIENT_SECRET';
export const FIXED_ENV = Object.freeze(['M65_GATE', 'CF_VERSION_METADATA', ...RUN_VARS]);
export const OUTCOMES = Object.freeze(['complete', 'copied_revoke_unproven', 'stopped']);
export const MIN_WINDOW_MS = 5 * 60_000;
export const MAX_WINDOW_MS = 30 * 60_000;
export const ACCESS_TOKEN_TTL_S = 300;

const MAX_VALUE_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
const MIN_TOKEN_LEFT_MS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;

export const PIN_FORMAT = Object.freeze({
  M65_RUN_ID: /^m65-[a-z0-9-]{8,60}$/,
  M65_BATCH: /^[a-z][a-z0-9-]{0,53}$/,
  M65_NOT_BEFORE: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
  M65_NOT_AFTER: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
  M65_INFISICAL_CLIENT_ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
});
export const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKER = PIN_FORMAT.M65_BATCH;
const BINDING = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
// A Create-only target: a key in one workload folder. /shared never matches.
const TARGET = /^\/workloads\/[a-z0-9][a-z0-9-]{0,62}\/[A-Z][A-Z0-9_]{0,127}$/;
// M142: the only /shared targets a copy may create, each exactly (path and key). Any other /shared
// target is refused. The table creates each once, from the first table Worker that binds it.
export const SHARED_TARGETS = Object.freeze([
  '/shared/AUTO_ROUTING_DECISION_SECRET',
  '/shared/O11Y_CF_AE_API_TOKEN',
]);

/** The reviewed batch id and copier script name of a source Worker. */
export const batchId = worker => `m65-${worker}-production-1`;
export const copierName = worker => `m65-${worker}-copy`;

const own = (o, k) =>
  o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
    ? o[k]
    : undefined;

export function expectedEnvKeys(batch, armed) {
  return [
    ...batch.rows.map(r => r.binding),
    ...FIXED_ENV,
    ...(armed ? [WRITER_SECRET] : []),
  ].sort();
}

/** Window bounds from the run pins, or null when malformed or out of the allowed length. */
export function windowOf(pins) {
  if (!PIN_FORMAT.M65_NOT_BEFORE.test(String(pins.M65_NOT_BEFORE))) return null;
  if (!PIN_FORMAT.M65_NOT_AFTER.test(String(pins.M65_NOT_AFTER))) return null;
  const notBefore = Date.parse(pins.M65_NOT_BEFORE);
  const notAfter = Date.parse(pins.M65_NOT_AFTER);
  const len = notAfter - notBefore;
  return Number.isFinite(len) && len >= MIN_WINDOW_MS && len <= MAX_WINDOW_MS
    ? { notBefore, notAfter }
    : null;
}

// Structural closure of one Worker's batch. Equality with the reviewed table and the tracked source
// is checked offline and at live preflight (checks.mjs); this keeps any other batch shape or
// target out of the deployed module.
export function validateBatch(batch) {
  const worker = own(batch, 'sourceScript');
  if (
    !WORKER.test(String(worker)) ||
    own(batch, 'id') !== batchId(worker) ||
    own(batch, 'environment') !== 'production' ||
    own(batch, 'accountId') !== ACCOUNT_ID
  ) {
    return 'batch_not_reviewed';
  }
  const rows = own(batch, 'rows');
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS_PER_WORKER) {
    return 'batch_row_count';
  }
  const seen = new Set();
  let folder;
  for (const r of rows) {
    if (own(r, 'kind') === 'secret_text') return 'secret_text_not_cross_script';
    if (own(r, 'kind') !== 'secrets_store') return 'row_kind_unsupported';
    const binding = String(own(r, 'binding'));
    if (!BINDING.test(binding) || [...FIXED_ENV, WRITER_SECRET].includes(binding)) {
      return 'row_binding_invalid';
    }
    if (!ALLOWED_STORE_IDS.includes(own(r, 'storeId'))) return 'row_store_not_allowed';
    if (!KEY.test(String(own(r, 'secretName'))) || !KEY.test(String(own(r, 'secretKey')))) {
      return 'row_name_invalid';
    }
    const target = `${own(r, 'secretPath')}/${r.secretKey}`;
    const shared = SHARED_TARGETS.includes(target);
    if (!shared && !TARGET.test(target)) return 'row_target_not_allowed';
    if (!shared) {
      folder ??= own(r, 'secretPath');
      if (own(r, 'secretPath') !== folder) return 'row_target_folders';
    }
    // A target is the STS lookup name: never another row's store name (its own may equal it, as
    // `WORKOS_API_KEY` -> `WORKOS_API_KEY`), never an environment-suffixed name.
    if (rows.some(x => x !== r && own(x, 'secretName') === r.secretKey)) {
      return 'row_target_is_store_name';
    }
    if (/_(PROD|DEV|STAGING)$/.test(r.secretKey)) return 'row_target_environment_suffix';
    for (const k of [`b:${binding}`, `s:${r.secretName}`, `t:${target}`]) {
      if (seen.has(k)) return 'row_duplicate';
      seen.add(k);
    }
  }
  return null;
}

const TABLE_ROW_KEYS = ['binding', 'secretName', 'storeId', 'target', 'worker'];

/**
 * The reviewed row table (worker | binding | store/secret | Infisical target), validated as a
 * whole before anything else uses it: one row per target and no duplicate target anywhere (so a
 * shared target is created by one row only), only reviewed store ids, no /shared target except the
 * exact SHARED_TARGETS, at most one workload folder per Worker and no workload folder shared by two
 * Workers, at most MAX_ROWS_PER_WORKER rows per Worker, and every Worker's batch closed under
 * `validateBatch`. Returns names-only problem codes; empty when the table is usable.
 */
export function validateTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return ['table_empty'];
  const f = [];
  const targets = new Set();
  const pairs = new Set();
  const folders = new Map();
  rows.forEach((r, i) => {
    const bad = code => f.push(`row_${i}_${code}`);
    if (
      r === null ||
      typeof r !== 'object' ||
      Array.isArray(r) ||
      Object.keys(r).sort().join() !== TABLE_ROW_KEYS.join()
    ) {
      bad('shape');
      return;
    }
    const { worker, binding, storeId, secretName, target } = r;
    if (!WORKER.test(String(worker))) bad('worker_invalid');
    if (!BINDING.test(String(binding)) || [...FIXED_ENV, WRITER_SECRET].includes(binding)) {
      bad('binding_invalid');
    }
    if (!ALLOWED_STORE_IDS.includes(storeId)) bad('store_not_reviewed');
    if (!KEY.test(String(secretName))) bad('store_secret_invalid');
    const shared = SHARED_TARGETS.includes(target);
    if (!shared && typeof target === 'string' && /^\/shared(\/|$)/.test(target)) {
      bad('target_shared');
    } else if (!shared && !TARGET.test(String(target))) bad('target_invalid');
    if (targets.has(target)) bad('target_duplicate');
    targets.add(target);
    if (pairs.has(`${worker}|${binding}`)) bad('binding_duplicate');
    pairs.add(`${worker}|${binding}`);
    if (typeof target === 'string' && !shared) {
      const set = folders.get(worker) ?? new Set();
      set.add(target.slice(0, target.lastIndexOf('/')));
      folders.set(worker, set);
    }
  });
  const owner = new Map();
  for (const [worker, set] of folders) {
    if (set.size > 1) f.push(`worker_${WORKER.test(String(worker)) ? worker : 'invalid'}_folders`);
    for (const folder of set) {
      if (owner.has(folder) && owner.get(folder) !== worker) f.push('table_folder_shared');
      owner.set(folder, worker);
    }
  }
  if (f.length > 0) return [...new Set(f)];
  for (const [worker, batch] of Object.entries(batchesOf(rows))) {
    const problem = validateBatch(batch);
    if (problem) f.push(`worker_${worker}_${problem}`);
  }
  return f;
}

const freeze = o => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
};

/**
 * One batch per source Worker, in table order. Call only on rows `validateTable` passed (its own
 * last step is the one exception: the shape is already checked there).
 */
export function batchesOf(rows) {
  const out = Object.create(null);
  for (const r of rows) {
    const cut = r.target.lastIndexOf('/');
    out[r.worker] ??= {
      id: batchId(r.worker),
      accountId: ACCOUNT_ID,
      sourceScript: r.worker,
      environment: 'production',
      rows: [],
    };
    out[r.worker].rows.push({
      kind: 'secrets_store',
      binding: r.binding,
      storeId: r.storeId,
      secretName: r.secretName,
      secretPath: r.target.slice(0, cut),
      secretKey: r.target.slice(cut + 1),
    });
  }
  return freeze(out);
}

/**
 * The reviewed table as one frozen value: its rows, its problems, one batch per Worker (none when
 * any problem exists, so nothing can run) and the Workers in table order (the workflow's matrix).
 */
export function tableOf(rows) {
  const problems = Object.freeze(validateTable(rows));
  const batches = problems.length === 0 ? batchesOf(rows) : Object.freeze(Object.create(null));
  return Object.freeze({
    rows: Object.freeze(Array.isArray(rows) ? [...rows] : []),
    problems,
    batches,
    workers: Object.freeze(Object.keys(batches)),
  });
}

// Infisical's v4 create schema stores `val.at(-1) === "\n" ? `${val.trim()}\n` : val.trim()`.
// A value that rule would change is refused, never normalized.
export const infisicalStoredForm = v => (v.at(-1) === '\n' ? `${v.trim()}\n` : v.trim());

// Infisical parses `${...}` as a secret reference at create time.
export const INFISICAL_REFERENCE = /\$\{[a-zA-Z0-9-_.]+\}/;

export function bytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
    return false;
  }
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// Byte parity: the value is well-formed UTF-16, so its UTF-8 bytes decode back to the same string.
export function utf8Parity(value) {
  const bytes = new TextEncoder().encode(value);
  let back;
  try {
    back = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    back = undefined;
  }
  return { ok: back === value, bytes };
}

// Serialization parity: the request body carries exactly the source bytes. A JSON round trip of
// well-formed text cannot fail this; it guards the body construction.
export function serializationParity(body, bytes) {
  let sent;
  try {
    sent = own(JSON.parse(body), 'secretValue');
  } catch {
    return false;
  }
  if (typeof sent !== 'string') return false;
  const b = new TextEncoder().encode(sent);
  const same = bytesEqual(b, bytes);
  b.fill(0);
  return same;
}

// Bounded body read. Too large, reset, timed out or otherwise unreadable -> null (never throws).
async function readBounded(res) {
  if (!res.body) return new Uint8Array(0);
  const chunks = [];
  let reader;
  try {
    reader = res.body.getReader();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      chunks.push(value);
      if (n > MAX_RESPONSE_BYTES) throw new Error('too_large');
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  } catch {
    try {
      await reader?.cancel();
    } catch {
      // A failed cancel leaves nothing to read; the caller already gets null.
    }
    return null;
  } finally {
    for (const c of chunks) c.fill(0);
  }
}

// Parse errors are swallowed: a SyntaxError message can quote response text.
function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  } finally {
    bytes.fill(0);
  }
}

async function discard(res) {
  try {
    await res.body?.cancel();
  } catch {
    // The body is dropped either way; a failed cancel changes no verdict.
  }
}

const call = (fetchImpl, path, init) =>
  fetchImpl(`${API_BASE}${path}`, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

async function login(fetchImpl, env, nowMs) {
  let res;
  try {
    res = await call(fetchImpl, '/api/v1/auth/universal-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: env.M65_INFISICAL_CLIENT_ID,
        clientSecret: env[WRITER_SECRET],
      }),
    });
  } catch {
    return { stop: 'login_transport_ambiguous' };
  }
  if (res.status !== 200) {
    await discard(res);
    return { stop: `login_http_${res.status}` };
  }
  const raw = await readBounded(res);
  if (raw === null) return { stop: 'login_response_unreadable' };
  const body = parseJson(raw);
  const token = own(body, 'accessToken');
  const ttl = own(body, 'expiresIn');
  if (typeof token !== 'string' || token.length < 20 || token.length > 8192) {
    return { stop: 'login_response_invalid' };
  }
  const tokenType = own(body, 'tokenType');
  if (
    (tokenType !== undefined && tokenType !== 'Bearer') ||
    typeof ttl !== 'number' ||
    !(ttl > 0) ||
    ttl > ACCESS_TOKEN_TTL_S
  ) {
    return { stop: 'login_token_not_bounded', token };
  }
  return { token, expMs: nowMs + ttl * 1000 };
}

async function createRow(fetchImpl, accessToken, batch, row, value) {
  const out = {
    storable: false,
    referenceFree: false,
    bytesParity: false,
    serializationParity: false,
    created: 'not_attempted',
    echo: null,
  };
  if (infisicalStoredForm(value) !== value) return { out, stop: 'value_not_storable_losslessly' };
  out.storable = true;
  if (INFISICAL_REFERENCE.test(value)) return { out, stop: 'value_contains_infisical_reference' };
  out.referenceFree = true;
  const { ok, bytes } = utf8Parity(value);
  out.bytesParity = ok;
  if (!ok || bytes.length === 0 || bytes.length > MAX_VALUE_BYTES) {
    bytes.fill(0);
    return { out, stop: ok ? 'source_size_out_of_bounds' : 'source_not_well_formed' };
  }
  const body = JSON.stringify({
    projectId: PROJECT_ID,
    environment: batch.environment,
    secretPath: row.secretPath,
    secretValue: value,
    secretComment: `${batch.id}: copied in runtime from Secrets Store binding ${row.binding} (${row.secretName})`,
    type: 'shared',
  });
  out.serializationParity = serializationParity(body, bytes);
  if (!out.serializationParity) {
    bytes.fill(0);
    return { out, stop: 'request_serialization_parity_failed' };
  }
  out.created = 'unknown';
  let res;
  try {
    res = await call(fetchImpl, `/api/v4/secrets/${row.secretKey}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body,
    });
  } catch {
    bytes.fill(0);
    return { out, stop: 'create_transport_ambiguous' };
  }
  if (res.status !== 200) {
    await discard(res);
    bytes.fill(0);
    out.created = res.status >= 400 && res.status < 500 ? 'no' : 'unknown';
    return { out, stop: `create_http_${res.status}` };
  }
  const raw = await readBounded(res);
  const parsed = raw === null ? undefined : parseJson(raw);
  if (parsed === undefined) {
    bytes.fill(0);
    return { out, stop: 'create_response_unreadable' };
  }
  if (own(parsed, 'approval') !== undefined) {
    bytes.fill(0);
    out.created = 'pending';
    return { out, stop: 'approval_request_pending' };
  }
  const s = own(parsed, 'secret');
  const optional = [
    ['type', 'shared'],
    ['environment', batch.environment],
    ['secretPath', row.secretPath],
    ['workspace', PROJECT_ID],
  ];
  if (
    own(s, 'secretKey') !== row.secretKey ||
    own(s, 'version') !== 1 ||
    optional.some(([k, w]) => own(s, k) !== undefined && own(s, k) !== w)
  ) {
    bytes.fill(0);
    return { out, stop: 'create_response_mismatch' };
  }
  out.created = 'yes';
  const echo = own(s, 'secretValue');
  if (typeof echo === 'string') {
    const e = new TextEncoder().encode(echo);
    out.echo = bytesEqual(e, bytes) ? 'equal' : 'differs';
    e.fill(0);
  } else out.echo = 'absent';
  bytes.fill(0);
  return out.echo === 'differs' ? { out, stop: 'stored_echo_mismatch' } : { out, stop: null };
}

// One revoke, then one probe with the same token. With accessTokenNumUsesLimit = 2 (the one create
// and this probe), a revoked token answers 401 and an unrevoked create-only token answers 403.
async function revokeAndProve(fetchImpl, accessToken, batch) {
  const r = { revoked: false, denialProved: false };
  try {
    const res = await call(fetchImpl, '/api/v1/auth/token/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    });
    r.revoked = res.status === 200;
    await discard(res);
  } catch {
    // Transport failure: `revoked` stays false, so the run cannot be complete.
  }
  try {
    const q = new URLSearchParams({
      projectId: PROJECT_ID,
      environment: batch.environment,
      secretPath: batch.rows[0].secretPath,
      viewSecretValue: 'false',
    });
    const res = await call(fetchImpl, `/api/v4/secrets?${q}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    r.denialProved = res.status === 401;
    await discard(res);
  } catch {
    // Transport failure: `denialProved` stays false, so the run cannot be complete.
  }
  return r;
}

function preGate(env, batch, cron) {
  const armed = Object.prototype.hasOwnProperty.call(env, WRITER_SECRET);
  const keys = Object.keys(env).sort();
  const want = expectedEnvKeys(batch, armed);
  const ready = {
    pins:
      RUN_VARS.every(k => PIN_FORMAT[k].test(String(env[k]))) &&
      env.M65_BATCH === batch.sourceScript &&
      windowOf(env) !== null,
    envClosed: keys.length === want.length && keys.every((k, i) => k === want[i]),
    bindings: batch.rows.every(r => typeof env[r.binding]?.get === 'function'),
    gate: typeof env.M65_GATE?.idFromName === 'function',
    cron: cron === CRON,
  };
  return { armed, ready };
}

// open only when both the scheduled time and the current time are inside; closed once either is
// past the end; before otherwise (including a tick scheduled before the window but run inside it).
function windowState(win, scheduledTime, nowMs) {
  if (!win) return 'invalid';
  const inside = t => t >= win.notBefore && t < win.notAfter;
  if (inside(scheduledTime) && inside(nowMs)) return 'open';
  return nowMs >= win.notAfter || scheduledTime >= win.notAfter ? 'closed' : 'before';
}

/** A receipt with every field present; checks.mjs `parseReceipt` accepts exactly these keys. */
export function newReceipt(batchId) {
  return {
    schema: RECEIPT_SCHEMA,
    batch: typeof batchId === 'string' ? batchId : null,
    runId: null,
    versionId: null,
    outcome: 'refused',
    reason: null,
    armed: false,
    window: 'invalid',
    ready: null,
    gate: 'not_attempted',
    prior: null,
    logins: 0,
    reads: 0,
    posts: 0,
    rows: [],
    revoked: false,
    denialProved: false,
  };
}

/**
 * One scheduled tick. Returns the sanitized receipt the Worker logs as one JSON line.
 * `cron` and `scheduledTime` come from the ScheduledController.
 */
export async function runTick({ env, cron, scheduledTime, now, fetchImpl, batch }) {
  const receipt = newReceipt(batch?.id);
  const batchProblem = validateBatch(batch);
  if (batchProblem) return Object.assign(receipt, { reason: batchProblem });
  const { armed, ready } = preGate(env, batch, cron);
  Object.assign(receipt, { armed, ready });
  if (ready.pins) receipt.runId = env.M65_RUN_ID;
  const versionId = own(env.CF_VERSION_METADATA, 'id');
  receipt.versionId =
    typeof versionId === 'string' && VERSION_ID.test(versionId) ? versionId : null;
  const win = ready.pins ? windowOf(env) : null;
  receipt.window = windowState(win, Number(scheduledTime), now());
  const notReady = Object.entries(ready).find(([, ok]) => !ok);
  if (notReady) {
    const flag = notReady[0].replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
    return Object.assign(receipt, { reason: `not_ready_${flag}` });
  }
  if (!armed) return Object.assign(receipt, { outcome: 'unarmed', reason: 'writer_not_installed' });
  const secret = env[WRITER_SECRET];
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 1024) {
    return Object.assign(receipt, { reason: 'writer_credential_malformed' });
  }
  if (receipt.window !== 'open') {
    return Object.assign(receipt, { outcome: 'idle', reason: 'outside_window' });
  }

  const stub = env.M65_GATE.get(env.M65_GATE.idFromName(batch.id));
  let gate;
  try {
    gate = await stub.consume(env.M65_RUN_ID);
  } catch {
    gate = undefined;
  }
  const state = own(gate, 'state');
  receipt.gate = ['consumed_now', 'already_consumed'].includes(state) ? state : 'ambiguous';
  if (receipt.gate === 'already_consumed') {
    const prior = own(gate, 'prior');
    return Object.assign(receipt, {
      outcome: 'idle',
      reason: 'already_consumed',
      prior: OUTCOMES.includes(prior) ? prior : null,
    });
  }
  if (receipt.gate !== 'consumed_now') return Object.assign(receipt, { reason: 'gate_ambiguous' });

  // From here on the gate is spent: every exit keeps the partial rows and revokes a minted token.
  receipt.outcome = 'stopped';
  let lg = {};
  let stop = null;
  try {
    receipt.logins = 1;
    lg = await login(fetchImpl, env, now());
    stop = lg.stop ?? null;
    if (!stop) {
      for (const row of batch.rows) {
        const rr = {
          binding: row.binding,
          sourceSecretName: row.secretName,
          secretPath: row.secretPath,
          secretKey: row.secretKey,
          read: false,
        };
        receipt.rows.push(rr);
        if (!(now() < win.notAfter) || lg.expMs - now() < MIN_TOKEN_LEFT_MS) {
          stop = 'window_closed_before_read';
          break;
        }
        let value;
        try {
          receipt.reads++;
          rr.read = true;
          value = await env[row.binding].get();
        } catch {
          stop = 'source_read_failed';
          break;
        }
        if (typeof value !== 'string' || value.length === 0) {
          value = null;
          stop = 'source_not_string_or_empty';
          break;
        }
        if (lg.expMs - now() < MIN_TOKEN_LEFT_MS) {
          value = null;
          stop = 'token_expiring_before_create';
          break;
        }
        rr.created = 'unknown';
        const counted = (u, i) => {
          receipt.posts++;
          return fetchImpl(u, i);
        };
        const { out, stop: rowStop } = await createRow(counted, lg.token, batch, row, value);
        value = null;
        Object.assign(rr, out);
        if (rowStop) {
          stop = rowStop;
          break;
        }
      }
    }
  } catch {
    stop = stop ?? 'internal_error';
  } finally {
    if (lg.token) Object.assign(receipt, await revokeAndProve(fetchImpl, lg.token, batch));
  }
  receipt.reason = stop;
  const allCreated =
    receipt.rows.length === batch.rows.length && receipt.rows.every(r => r.created === 'yes');
  if (!stop && allCreated) {
    receipt.outcome =
      receipt.revoked && receipt.denialProved ? 'complete' : 'copied_revoke_unproven';
  }
  try {
    await stub.finish(receipt.outcome);
  } catch {
    // The gate row already blocks a replay; a lost final outcome only blanks `prior` later.
  }
  return receipt;
}
