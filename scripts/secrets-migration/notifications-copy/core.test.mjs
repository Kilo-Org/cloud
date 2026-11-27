// Unit proof of the cron-tick core with synthetic values, a fake Infisical and a fake gate with
// M65Gate's semantics (the real Durable Object runs in workerd.test.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  infisicalStoredForm,
  runTick,
  serializationParity,
  utf8Parity,
  validateBatch,
} from './src/core.mjs';
import { BATCH } from './src/manifest.mjs';
import { parseReceipt } from './checks.mjs';
import {
  fakeGateNamespace,
  fakeInfisical,
  iso,
  leaks,
  makeEnv,
  syntheticValues,
} from './fakes.mjs';

const T0 = Date.parse('2026-11-27T16:00:00Z');
const NOT_BEFORE = iso(T0 - 60_000);
const NOT_AFTER = iso(T0 + 20 * 60_000);
const CRON = '* * * * *';

async function tick(o = {}) {
  const values = o.values ?? syntheticValues();
  const gate = o.gate ?? fakeGateNamespace();
  const fake = o.fake ?? fakeInfisical(o.fakeOpts);
  const readLog = o.readLog ?? [];
  const env =
    o.env ??
    makeEnv({
      values,
      gate,
      notBefore: o.notBefore ?? NOT_BEFORE,
      notAfter: o.notAfter ?? NOT_AFTER,
      armed: o.armed ?? true,
      extra: o.extra,
      readLog,
    });
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = console.error = (...a) => out.push(a.join(' '));
  let receipt;
  try {
    receipt = await runTick({
      env,
      cron: o.cron ?? CRON,
      scheduledTime: o.scheduledTime ?? T0,
      now: o.now ?? (() => T0),
      fetchImpl: o.fetchImpl ?? fake.fetch,
      batch: o.batch ?? BATCH,
    });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const text = JSON.stringify(receipt);
  assert.deepEqual(
    leaks(text + out.join('\n'), values, [...(fake.issued ?? []), ...(fake.providerIds ?? [])]),
    [],
    'no value, encoding, digest, credential or provider id in the receipt or console'
  );
  assert.equal(out.length, 0, 'core writes no console output');
  assert.ok(
    fake.calls.every(c => c.origin === 'https://eu.infisical.com' && c.redirect === 'manual'),
    'only eu.infisical.com, redirects not followed'
  );
  if (!o.batch) {
    const parsed = parseReceipt(text);
    assert.deepEqual(parsed.failures, [], 'the receipt passes the shared parser');
  }
  return { receipt, fake, readLog, gate, values, env };
}

test('first armed in-window tick: one gate, one login, 4 reads, 4 creates, exact bytes, revoke, 401', async () => {
  const { receipt, fake, readLog, values, gate } = await tick();
  assert.deepEqual(
    [receipt.outcome, receipt.reason, receipt.gate, receipt.armed, receipt.window],
    ['complete', null, 'consumed_now', true, 'open']
  );
  assert.deepEqual([receipt.logins, receipt.reads, receipt.posts], [1, 4, 4]);
  assert.deepEqual(
    readLog,
    BATCH.rows.map(r => r.binding)
  );
  for (const [i, r] of receipt.rows.entries()) {
    const row = BATCH.rows[i];
    assert.equal(r.secretKey, row.secretKey);
    assert.deepEqual(
      [r.created, r.bytesParity, r.serializationParity, r.storable, r.referenceFree, r.echo],
      ['yes', true, true, true, true, 'equal']
    );
    assert.equal(fake.store.get(`${row.secretPath}/${row.secretKey}`), values[row.binding]);
  }
  assert.deepEqual([receipt.revoked, receipt.denialProved], [true, true]);
  assert.equal(gate.state.outcome, 'complete', 'final outcome recorded');
  assert.deepEqual(
    fake.calls.map(c => `${c.method} ${c.path}`),
    [
      'POST /api/v1/auth/universal-auth/login',
      'POST /api/v4/secrets/NOTIFICATIONS_APNS_PRIVATE_KEY',
      'POST /api/v4/secrets/NOTIFICATIONS_EXPO_ACCESS_TOKEN',
      'POST /api/v4/secrets/NEXTAUTH_SECRET',
      'POST /api/v4/secrets/INTERNAL_API_SECRET',
      'POST /api/v1/auth/token/revoke',
      'GET /api/v4/secrets',
    ]
  );
});

test('second tick: idle already_consumed with the prior outcome, no login, read or write', async () => {
  const first = await tick();
  const again = await tick({
    env: first.env,
    fake: first.fake,
    readLog: first.readLog,
    values: first.values,
  });
  assert.deepEqual(
    [again.receipt.outcome, again.receipt.reason, again.receipt.prior, again.receipt.logins],
    ['idle', 'already_consumed', 'complete', 0]
  );
  assert.deepEqual([first.fake.calls.length, first.readLog.length], [7, 4]);
});

test('eight racing ticks: exactly one is admitted', async () => {
  const gate = fakeGateNamespace();
  const fake = fakeInfisical();
  const readLog = [];
  const env = makeEnv({
    values: syntheticValues(),
    gate,
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
    readLog,
  });
  const rs = await Promise.all(
    Array.from({ length: 8 }, () =>
      runTick({
        env,
        cron: CRON,
        scheduledTime: T0,
        now: () => T0,
        fetchImpl: fake.fetch,
        batch: BATCH,
      })
    )
  );
  assert.equal(rs.filter(r => r.gate === 'consumed_now').length, 1);
  assert.equal(rs.filter(r => r.reason === 'already_consumed').length, 7);
  assert.deepEqual([readLog.length, fake.creates, fake.clientSecretUses], [4, 4, 1]);
});

test('unarmed tick (writer not installed): readiness receipt only, no gate, auth or read', async () => {
  const { receipt, fake, readLog, gate } = await tick({ armed: false });
  assert.deepEqual(
    [receipt.outcome, receipt.reason, receipt.armed, receipt.gate],
    ['unarmed', 'writer_not_installed', false, 'not_attempted']
  );
  assert.deepEqual(receipt.ready, {
    pins: true,
    envClosed: true,
    bindings: true,
    gate: true,
    cron: true,
  });
  assert.deepEqual([gate.state.calls, fake.calls.length, readLog.length], [0, 0, 0]);
});

test('armed ticks outside the window: idle, no gate, auth or read', async t => {
  const cases = {
    before: { notBefore: iso(T0 + 5 * 60_000), notAfter: iso(T0 + 20 * 60_000) },
    closed: { notBefore: iso(T0 - 20 * 60_000), notAfter: iso(T0 - 60_000) },
    closed_now_late: { now: () => T0 + 25 * 60_000 },
    before_scheduled_early: { scheduledTime: T0 - 120_000 },
  };
  for (const [name, o] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { receipt, fake, readLog, gate } = await tick(o);
      assert.deepEqual([receipt.outcome, receipt.reason], ['idle', 'outside_window']);
      assert.ok(name.startsWith(receipt.window), `${name} -> ${receipt.window}`);
      assert.deepEqual([gate.state.calls, fake.calls.length, readLog.length], [0, 0, 0]);
    });
  }
});

test('refusals before the gate: no gate, auth or read', async t => {
  const cases = {
    not_ready_cron: { cron: '*/5 * * * *' },
    not_ready_pins_unset: { extra: { M65_RUN_ID: 'unset' } },
    not_ready_pins_long: { notAfter: iso(T0 + 31 * 60_000) },
    not_ready_pins_short: { notAfter: iso(T0 + 3 * 60_000) },
    not_ready_env_closed: { extra: { EXTRA_SERVICE: {} } },
    writer_credential_malformed: { extra: { M65_INFISICAL_CLIENT_SECRET: 'short' } },
  };
  for (const [name, o] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { receipt, fake, readLog, gate } = await tick(o);
      assert.equal(receipt.outcome, 'refused');
      assert.ok(name.startsWith(receipt.reason), `${name} -> ${receipt.reason}`);
      assert.deepEqual([gate.state.calls, fake.calls.length, readLog.length], [0, 0, 0]);
    });
  }
});

test('batch closure: secret_text rows and other batch shapes are refused before anything', async () => {
  const withRow = patch => ({
    ...BATCH,
    rows: BATCH.rows.map((r, i) => (i === 0 ? { ...r, ...patch } : r)),
  });
  assert.equal(validateBatch(withRow({ kind: 'secret_text' })), 'secret_text_not_cross_script');
  assert.equal(validateBatch(withRow({ storeId: '0'.repeat(32) })), 'row_store_not_allowed');
  assert.equal(validateBatch(withRow({ secretPath: '/ci' })), 'row_path_not_allowed');
  assert.equal(
    validateBatch(withRow({ secretKey: 'APNS_PRIVATE_KEY_PROD' })),
    'row_target_is_store_name'
  );
  assert.equal(
    validateBatch(withRow({ secretKey: 'NOTIFICATIONS_APNS_PRIVATE_KEY_DEV' })),
    'row_target_environment_suffix'
  );
  assert.equal(validateBatch(withRow({ secretKey: 'NEXTAUTH_SECRET' })), 'row_duplicate');
  assert.equal(validateBatch(withRow({ binding: 'M65_GATE' })), 'row_binding_invalid');
  assert.equal(validateBatch({ ...BATCH, id: 'other' }), 'batch_not_reviewed');
  assert.equal(validateBatch({ ...BATCH, rows: BATCH.rows.slice(1) }), 'batch_row_count');
  const { receipt, readLog, fake } = await tick({ batch: withRow({ kind: 'secret_text' }) });
  assert.deepEqual(
    [receipt.reason, readLog.length, fake.calls.length],
    ['secret_text_not_cross_script', 0, 0]
  );
});

test('byte and serialization parity: true and false paths', () => {
  assert.equal(utf8Parity('plain-ascii-ünï').ok, true);
  assert.equal(utf8Parity('lone-\uD800-surrogate').ok, false);
  const v = 'value-ünï';
  const bytes = new TextEncoder().encode(v);
  assert.equal(serializationParity(JSON.stringify({ secretValue: v }), bytes), true);
  assert.equal(serializationParity(JSON.stringify({ secretValue: `${v} ` }), bytes), false);
  assert.equal(
    serializationParity(JSON.stringify({ secretValue: v.normalize('NFD') }), bytes),
    false
  );
  assert.equal(serializationParity('{', bytes), false);
  assert.equal(serializationParity(JSON.stringify({}), bytes), false);
});

test('values Infisical would change stop before their POST', async t => {
  const cases = {
    value_not_storable_losslessly_leading: ' x-synthetic-1234',
    value_not_storable_losslessly_trailing: 'x-synthetic-1234 ',
    value_not_storable_losslessly_crlf: 'x-synthetic-1234\r\n',
    value_not_storable_losslessly_doublelf: 'x-synthetic-1234\n\n',
    value_not_storable_losslessly_tab: '\tx-synthetic-1234',
    value_contains_infisical_reference: 'synthetic-${other.KEY}-value',
    source_not_well_formed: 'synthetic-\uDC00-value',
  };
  for (const [name, v] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { receipt, fake } = await tick({
        values: { ...syntheticValues(), APNS_PRIVATE_KEY: v },
      });
      assert.ok(name.startsWith(receipt.reason), `${name} -> ${receipt.reason}`);
      assert.deepEqual([receipt.reads, receipt.posts, fake.creates], [1, 0, 0]);
      assert.deepEqual([receipt.revoked, receipt.denialProved], [true, true]);
    });
  }
  assert.equal(
    infisicalStoredForm('x-synthetic\n'),
    'x-synthetic\n',
    'a single final LF is storable'
  );
});

test('existing target: 400, created=no, no overwrite, no further row', async () => {
  const { receipt, fake } = await tick({ fakeOpts: { preexisting: ['/shared/NEXTAUTH_SECRET'] } });
  assert.equal(receipt.reason, 'create_http_400');
  assert.deepEqual(
    receipt.rows.map(r => r.created),
    ['yes', 'yes', 'no']
  );
  assert.equal(fake.store.get('/shared/NEXTAUTH_SECRET'), 'pre-existing-synthetic');
  assert.equal(fake.store.has('/shared/INTERNAL_API_SECRET'), false);
  assert.deepEqual([receipt.reads, receipt.posts, receipt.outcome], [3, 3, 'stopped']);
});

test('stored echo differs: stop and report, no further row', async () => {
  const { receipt } = await tick({ fakeOpts: { normalize: v => v.toUpperCase() } });
  assert.deepEqual(
    [receipt.reason, receipt.rows.length, receipt.rows[0].echo],
    ['stored_echo_mismatch', 1, 'differs']
  );
});

const erroringBody = () => new ReadableStream({ pull: c => c.error(new Error('synthetic reset')) });

test('create-side stops: one POST each, no retry, revoke still runs', async t => {
  const cases = {
    approval_request_pending: { approval: true },
    create_transport_ambiguous: { onCreate: () => Promise.reject(new Error('net')) },
    create_http_503: { onCreate: () => new Response(null, { status: 503 }) },
    create_http_307: {
      onCreate: () =>
        new Response(null, { status: 307, headers: { location: 'https://elsewhere.invalid/' } }),
    },
    create_response_unreadable: {
      onCreate: () => new Response('x'.repeat(1_100_000), { status: 200 }),
    },
    create_response_unreadable_reset: {
      onCreate: () => new Response(erroringBody(), { status: 200 }),
    },
    create_response_mismatch: {
      onCreate: () => Response.json({ secret: { secretKey: 'OTHER_KEY', version: 1 } }),
    },
  };
  for (const [name, fakeOpts] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { receipt, fake } = await tick({ fakeOpts });
      assert.ok(name.startsWith(receipt.reason), `${name} -> ${receipt.reason}`);
      assert.deepEqual([receipt.posts, fake.creates, receipt.reads], [1, 1, 1]);
      assert.notEqual(receipt.rows[0].created, 'yes');
      assert.deepEqual(
        [receipt.revoked, receipt.denialProved, receipt.outcome],
        [true, true, 'stopped']
      );
    });
  }
});

test('login refusals read nothing', async () => {
  const used = await tick({ fakeOpts: { loginStatus: 401 } });
  assert.deepEqual(
    [used.receipt.reason, used.receipt.reads, used.receipt.revoked],
    ['login_http_401', 0, false]
  );
  const long = await tick({ fakeOpts: { ttl: 600 } });
  assert.deepEqual(
    [long.receipt.reason, long.receipt.reads, long.receipt.revoked, long.receipt.denialProved],
    ['login_token_not_bounded', 0, true, true]
  );
  const invalid = await tick({ fakeOpts: { loginBody: { expiresIn: 300 } } });
  assert.deepEqual([invalid.receipt.reason, invalid.receipt.reads], ['login_response_invalid', 0]);
  const fake = fakeInfisical();
  const reset = await tick({
    fake,
    fetchImpl: (u, i) =>
      String(u).endsWith('/universal-auth/login')
        ? Promise.resolve(new Response(erroringBody(), { status: 200 }))
        : fake.fetch(u, i),
  });
  assert.deepEqual([reset.receipt.reason, reset.receipt.reads], ['login_response_unreadable', 0]);
  const amb = await tick({ fetchImpl: () => Promise.reject(new Error('net')) });
  assert.deepEqual([amb.receipt.reason, amb.receipt.reads], ['login_transport_ambiguous', 0]);
});

test('failed revoke: the unrevoked create-only token answers 403, so the run is not complete', async () => {
  const { receipt } = await tick({ fakeOpts: { revokeStatus: 500 } });
  assert.deepEqual(
    [receipt.outcome, receipt.revoked, receipt.denialProved],
    ['copied_revoke_unproven', false, false]
  );
  assert.ok(receipt.rows.every(r => r.created === 'yes'));
});

test('ambiguous gate refuses with no login or read', async () => {
  const broken = {
    state: { calls: 0 },
    ns: {
      idFromName: n => n,
      get: () => ({ consume: () => Promise.reject(new Error('rpc')), finish: async () => true }),
    },
  };
  const { receipt, fake, readLog } = await tick({ gate: broken });
  assert.deepEqual(
    [receipt.reason, receipt.logins, readLog.length, fake.calls.length],
    ['gate_ambiguous', 0, 0, 0]
  );
});

test('restart with a fresh gate after a consumed run: the one-use client secret stops it before any read', async () => {
  const first = await tick();
  const readLog = [];
  const env = makeEnv({
    values: first.values,
    gate: fakeGateNamespace(),
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
    readLog,
  });
  const r = await runTick({
    env,
    cron: CRON,
    scheduledTime: T0,
    now: () => T0,
    fetchImpl: first.fake.fetch,
    batch: BATCH,
  });
  assert.deepEqual([r.reason, readLog.length, first.fake.creates], ['login_http_401', 0, 4]);
});

// Clock that returns the queued instants in order, then repeats the last one.
const clock =
  (...ts) =>
  () =>
    ts.length > 1 ? ts.shift() : ts[0];

test('mid-run stops before that row write: read failure, window end, token expiry, unexpected error', async () => {
  const rf = await tick({
    values: { ...syntheticValues(), EXPO_ACCESS_TOKEN: new Error('synthetic read failure') },
  });
  assert.deepEqual(
    [rf.receipt.reason, rf.receipt.reads, rf.fake.creates],
    ['source_read_failed', 2, 1]
  );

  const end = Date.parse(NOT_AFTER);
  const late = await tick({ now: clock(T0, T0, end) });
  assert.deepEqual(
    [late.receipt.reason, late.receipt.reads, late.receipt.posts, late.receipt.revoked],
    ['window_closed_before_read', 0, 0, true]
  );

  const exp = await tick({ now: clock(T0, T0, T0, T0, T0 + 295_000) });
  assert.deepEqual(
    [exp.receipt.reason, exp.receipt.reads, exp.receipt.posts, exp.receipt.revoked],
    ['token_expiring_before_create', 1, 0, true]
  );

  let n = 0;
  const boom = await tick({
    now: () => {
      if (++n === 6) throw new Error('synthetic internal failure');
      return T0;
    },
  });
  assert.equal(boom.receipt.reason, 'internal_error');
  assert.equal(boom.receipt.rows[0].created, 'yes', 'partial rows kept');
  assert.deepEqual(
    [boom.receipt.revoked, boom.receipt.denialProved, boom.receipt.outcome],
    [true, true, 'stopped']
  );
  assert.equal(boom.gate.state.outcome, 'stopped');
});
