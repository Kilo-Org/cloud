// Synthetic stand-ins for the copier tests: a fake Infisical EU API (single-use client secret,
// create-only token with rows + 1 uses, Create-only store), a gate with M65Gate's semantics, and
// synthetic source values. No real value, credential or provider is involved. Every helper takes
// a batch; the default is the fixture table's Notifications batch.
//
// The fixture table is the one Notifications Expo row (the reviewed source on main, whose name map
// checks.mjs `WORKER_SOURCES.notifications` keeps), so every table-bound path (source check,
// renderer, driver, copier module) runs end to end in CI while the checked-in table's Workers wait
// for their batch PRs (`source_not_on_main`). Functions take it as their `table` argument; the
// workerd tests load it as the copier's table module (`FIXTURE_TABLE_MODULE`).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { COMPATIBILITY_DATE } from './render-config.mjs';
import { PROJECT_ID, RUN_VARS, WRITER_SECRET, copierName, tableOf } from './src/core.mjs';

export const FIXTURE_ROWS = Object.freeze([
  Object.freeze({
    worker: 'notifications',
    binding: 'EXPO_ACCESS_TOKEN',
    storeId: '342a86d9e3a94da698e82d0c6e2a36f0',
    secretName: 'EXPO_ACCESS_TOKEN',
    target: '/workloads/notifications/NOTIFICATIONS_EXPO_ACCESS_TOKEN',
  }),
]);
export const FIXTURE = tableOf(FIXTURE_ROWS);
/** The fixture table as the source of a `table.mjs` module next to the real core.mjs. */
export const FIXTURE_TABLE_MODULE = `import { tableOf } from './core.mjs';\nexport const TABLE = tableOf(${JSON.stringify(FIXTURE_ROWS)});\n`;
export const BATCH = FIXTURE.batches.notifications;
export const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
export const CLIENT_SECRET = `synthetic-client-secret-${randomBytes(12).toString('hex')}`;
export const VERSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const RUN_ID = 'm65-synthetic-run-0001';

/** One synthetic value per batch binding, keyed by binding (non-ASCII included). */
export function syntheticValues(batch = BATCH) {
  return Object.fromEntries(
    batch.rows.map(r => [
      r.binding,
      `synthetic-${r.binding.toLowerCase()}-ünïcødé-${randomBytes(24).toString('base64url')}`,
    ])
  );
}

// Values plus their trimmed, base64, hex and SHA-256 forms, the client secret, and any extra
// strings that must never appear (access tokens, provider ids).
export function leakForms(values, extra = []) {
  const out = [];
  for (const v of Object.values(values)) {
    if (typeof v !== 'string') continue;
    const b = Buffer.from(v, 'utf8');
    out.push(v, v.trim(), b.toString('base64'), b.toString('hex'));
    out.push(createHash('sha256').update(b).digest('hex'));
  }
  out.push(CLIENT_SECRET, ...extra);
  return out.filter(s => typeof s === 'string' && s.length >= 8);
}

export const leaks = (text, values, extra = []) =>
  leakForms(values, extra).filter(f => text.includes(f));

/**
 * Fake Infisical. opts: { ttl, preexisting: ["/path/KEY"], normalize, echo, approval,
 * onCreate(n) -> Response | Promise (rejects for transport) | undefined, loginStatus, loginBody,
 * revokeStatus (non-200 leaves the token live) }. An unrevoked create-only token answers the list
 * probe 403, a revoked or exhausted one 401.
 */
export function fakeInfisical(opts = {}) {
  const batch = opts.batch ?? BATCH;
  const s = {
    calls: [],
    store: new Map(),
    clientSecretUses: 0,
    tokens: new Map(),
    issued: [],
    providerIds: [],
    creates: 0,
  };
  for (const k of opts.preexisting ?? []) s.store.set(k, 'pre-existing-synthetic');
  const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const bearer = h => {
    const m = /^Bearer (.+)$/.exec(h ?? '');
    const t = m && s.tokens.get(m[1]);
    if (!t || t.revoked || t.uses >= t.limit) return null;
    t.uses++;
    return t;
  };
  s.fetch = async (input, init = {}) => {
    const req =
      typeof input === 'string' || input instanceof URL ? new Request(input, init) : input;
    const u = new URL(req.url);
    s.calls.push({
      origin: u.origin,
      method: req.method,
      path: u.pathname,
      search: u.search,
      redirect: init.redirect ?? req.redirect,
    });
    if (u.origin !== 'https://eu.infisical.com') return new Response(null, { status: 599 });
    const auth = req.headers.get('authorization');
    if (req.method === 'POST' && u.pathname === '/api/v1/auth/universal-auth/login') {
      const b = await req.json();
      if (opts.loginStatus) return json({ message: 'synthetic' }, opts.loginStatus);
      if (opts.loginBody) return json(opts.loginBody);
      if (b.clientId !== CLIENT_ID || b.clientSecret !== CLIENT_SECRET || s.clientSecretUses >= 1) {
        return json({ message: 'Invalid credentials' }, 401);
      }
      s.clientSecretUses++;
      const accessToken = `synthetic-access-${randomBytes(24).toString('hex')}`;
      s.tokens.set(accessToken, { uses: 0, limit: batch.rows.length + 1, revoked: false });
      s.issued.push(accessToken);
      const ttl = opts.ttl ?? 300;
      return json({ accessToken, expiresIn: ttl, accessTokenMaxTTL: ttl, tokenType: 'Bearer' });
    }
    if (req.method === 'POST' && u.pathname === '/api/v1/auth/token/revoke') {
      const b = await req.json();
      const t = s.tokens.get(b.accessToken);
      if (t && !opts.revokeStatus) t.revoked = true;
      return json({ message: 'revoked' }, opts.revokeStatus ?? (t ? 200 : 400));
    }
    if (req.method === 'GET' && u.pathname === '/api/v4/secrets') {
      if (!bearer(auth)) return json({ message: 'Unauthorized' }, 401);
      return json({ message: 'Permission denied' }, 403);
    }
    if (req.method === 'POST' && u.pathname.startsWith('/api/v4/secrets/')) {
      s.creates++;
      const hook = opts.onCreate?.(s.creates);
      if (hook) return hook;
      if (!bearer(auth)) return json({ message: 'Unauthorized' }, 401);
      const b = await req.json();
      const key = decodeURIComponent(u.pathname.slice('/api/v4/secrets/'.length));
      const id = `${b.secretPath}/${key}`;
      if (b.projectId !== PROJECT_ID || b.environment !== 'production') {
        return json({ message: 'bad scope' }, 403);
      }
      if (s.store.has(id)) return json({ message: 'Secret already exist' }, 400);
      const providerId = randomUUID();
      s.providerIds.push(providerId);
      if (opts.approval) return json({ approval: { id: providerId, status: 'open' } });
      const stored = opts.normalize ? opts.normalize(b.secretValue) : b.secretValue;
      s.store.set(id, stored);
      const secret = {
        id: providerId,
        secretKey: key,
        version: 1,
        type: 'shared',
        environment: b.environment,
        secretPath: b.secretPath,
        workspace: PROJECT_ID,
      };
      if (opts.echo !== false) secret.secretValue = stored;
      return json({ secret });
    }
    return json({ message: 'not found' }, 404);
  };
  return s;
}

/** Same admission semantics as M65Gate (single consume, final outcome kept) for Node tests. */
export function fakeGateNamespace() {
  const state = { consumed: false, outcome: null, calls: 0 };
  const stub = {
    async consume() {
      state.calls++;
      if (state.consumed) return { state: 'already_consumed', prior: state.outcome };
      state.consumed = true;
      return { state: 'consumed_now' };
    },
    async finish(outcome) {
      if (state.outcome === null) state.outcome = outcome;
      return true;
    },
  };
  return { state, ns: { idFromName: n => n, get: () => stub } };
}

export function makeEnv({
  values,
  gate,
  notBefore,
  notAfter,
  armed = true,
  extra = {},
  readLog = [],
  batch = BATCH,
}) {
  const env = {};
  for (const r of batch.rows) {
    env[r.binding] = {
      get: async () => {
        readLog.push(r.binding);
        const v = values[r.binding];
        if (v instanceof Error) throw v;
        return v;
      },
    };
  }
  Object.assign(env, {
    M65_GATE: gate.ns,
    CF_VERSION_METADATA: { id: VERSION_ID, tag: '', timestamp: '2026-11-27T00:00:00.000Z' },
    M65_RUN_ID: RUN_ID,
    M65_BATCH: batch.sourceScript,
    M65_NOT_BEFORE: notBefore,
    M65_NOT_AFTER: notAfter,
    M65_INFISICAL_CLIENT_ID: CLIENT_ID,
    ...(armed ? { [WRITER_SECRET]: CLIENT_SECRET } : {}),
    ...extra,
  });
  return env;
}

export const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * A realistic raw `GET /workers/scripts/<copier>/settings` result for the closed copier, as
 * Cloudflare fills it in (logs.enabled, persist, sampling, empty destinations, tail_consumers null).
 * The preflight accepts it.
 */
export function copierSettingsResult() {
  return {
    annotations: { 'workers/triggered_by': 'upload' },
    bindings: [{ name: 'CF_VERSION_METADATA', type: 'version_metadata' }],
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: [],
    limits: { cpu_ms: 30_000 },
    logpush: false,
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: false,
        persist: true,
        destinations: [],
      },
      traces: { enabled: false, head_sampling_rate: 1, persist: true, destinations: [] },
    },
    tags: [],
    tail_consumers: null,
    usage_model: 'standard',
  };
}

/**
 * The unarmed copier version's `resources.bindings` as `GET .../versions/<id>` returns them,
 * including the gate binding's own script_name and namespace_id. The preflight accepts them.
 */
export function unarmedCopierBindings(pins, namespaceId, batch = BATCH) {
  return [
    ...batch.rows.map(r => ({
      name: r.binding,
      type: 'secrets_store_secret',
      store_id: r.storeId,
      secret_name: r.secretName,
    })),
    {
      name: 'M65_GATE',
      type: 'durable_object_namespace',
      class_name: 'M65Gate',
      script_name: copierName(batch.sourceScript),
      namespace_id: namespaceId,
    },
    { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
    ...RUN_VARS.map(name => ({ name, type: 'plain_text', text: pins[name] })),
  ];
}

/** The armed version's bindings: the unarmed ones plus exactly the writer secret (no value). */
export const armedCopierBindings = (pins, namespaceId, batch = BATCH) => [
  ...unarmedCopierBindings(pins, namespaceId, batch),
  { name: WRITER_SECRET, type: 'secret_text' },
];
