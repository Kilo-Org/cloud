import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareQueues } from './provision-queues.mjs';

const execute = promisify(execFile);
const source = 'usage-ingest-processing-staging-eu';
const dlq = 'usage-ingest-processing-dlq-staging-eu';
const globalSource = 'usage-ingest-processing-staging';
const globalDlq = 'usage-ingest-processing-dlq-staging';
const owned = { type: 'worker', script: 'usage-ingest-staging', consumer_id: 'c'.repeat(32) };

async function fixture(t, existing = []) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'eu-queues-')));
  mkdirSync(join(directory, 'scripts'));
  symlinkSync(
    new URL('../node_modules', import.meta.url).pathname,
    join(directory, 'node_modules')
  );
  writeFileSync(
    join(directory, 'scripts/provision-queues.mjs'),
    readFileSync(new URL('./provision-queues.mjs', import.meta.url))
  );
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  writeFileSync(join(directory, 'wrangler.jsonc'), config);
  const queues = new Map();
  const calls = [];
  let nextId = 0;
  const add = name => {
    const queue = {
      queue_name: name,
      queue_id: String(++nextId).padStart(32, '0'),
      jurisdiction: name.endsWith('-eu') ? 'eu' : undefined,
      consumers: [],
    };
    queues.set(name, queue);
    return queue;
  };
  existing.forEach(add);
  const f = {
    rename: () =>
      writeFileSync(
        join(directory, 'wrangler.jsonc'),
        config.replaceAll('usage-ingest-processing-staging-eu', 'usage-ingest-renamed')
      ),
    queues,
    calls,
    fault: undefined,
    global: () =>
      writeFileSync(
        join(directory, 'wrangler.jsonc'),
        config.replaceAll('-staging-eu', '-staging')
      ),
  };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    let text = '';
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url, 'https://api.cloudflare.com');
    calls.push({ method: req.method, name: body?.queue_name, path: url.pathname });
    if (f.fault === 'network') {
      req.socket.destroy();
      return;
    }
    if (['HTTP', 'auth', 'invalid JSON'].includes(f.fault)) {
      res
        .writeHead(f.fault === 'HTTP' ? 503 : f.fault === 'auth' ? 401 : 200)
        .end('private response');
      return;
    }
    let result;
    let result_info;
    if (req.method === 'DELETE') {
      const parts = url.pathname.split('/');
      const queue = [...queues.values()].find(q => q.queue_id === parts.at(-3));
      assert.ok(queue && [source, globalSource].includes(queue.queue_name));
      assert.equal(parts.at(-2), 'consumers');
      assert.equal(parts.at(-1), owned.consumer_id);
      if (f.fault === 'permission') {
        res.writeHead(403).end(JSON.stringify({ success: false }));
        return;
      }
      if (f.fault !== 'still attached') queue.consumers = [];
      if (f.fault === 'lost detach') {
        req.socket.destroy();
        return;
      }
    } else if (req.method === 'POST') {
      assert.deepEqual(body, { queue_name: body.queue_name, jurisdiction: 'eu' });
      assert.ok([dlq, source].includes(body.queue_name) && !queues.has(body.queue_name));
      result = add(body.queue_name);
      if (f.fault === 'ignored jurisdiction') delete result.jurisdiction;
      if (f.fault === 'lost acceptance' && body.queue_name === source) {
        req.socket.destroy();
        return;
      }
    } else {
      assert.equal(req.method, 'GET');
      const name = url.searchParams.get('name');
      if (url.pathname.endsWith('/workers/services/usage-ingest-staging')) {
        result = { default_environment: { environment: 'production' } };
      } else if (name) {
        result = [...queues.values()].filter(q => q.queue_name === name);
        result_info = { total_pages: result.length ? 1 : 0 };
        if (f.fault === 'ambiguous') result = [result[0], result[0]];
        if (f.fault === 'incomplete') result_info = undefined;
      } else result = [...queues.values()].find(q => q.queue_id === url.pathname.split('/').at(-1));
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, result, result_info }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(directory, 'fetch.mjs'),
    `const fetch=globalThis.fetch; globalThis.fetch=(url,options)=>{if(!String(url).startsWith('https://api.cloudflare.com/client/v4/accounts/e115e769bcdd4c3d66af59d3332cb394/')) throw new Error('Unexpected hosted request');return fetch(${JSON.stringify(endpoint)}+new URL(url).pathname+new URL(url).search,options);};`
  );
  f.cli = () =>
    execute(
      process.execPath,
      [
        '--import',
        join(directory, 'fetch.mjs'),
        join(directory, 'scripts/provision-queues.mjs'),
        'staging',
      ],
      {
        timeout: 15000,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: 'synthetic-token',
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
          XDG_CONFIG_HOME: directory,
        },
      }
    );
  return f;
}

for (const existing of [[], [dlq], [source], [dlq, source]])
  test(`CLI creates only missing EU queues (${existing.length} existing); rerun reuses them`, async t => {
    const f = await fixture(t, existing);
    await f.cli();
    const created = f.calls.filter(c => c.method === 'POST').map(c => c.name);
    assert.deepEqual(
      created,
      [dlq, source].filter(name => !existing.includes(name))
    );
    assert.equal(f.queues.get(dlq).jurisdiction, 'eu');
    assert.equal(f.queues.get(source).jurisdiction, 'eu');
    await f.cli();
    assert.equal(f.calls.filter(c => c.method === 'POST').length, created.length);
  });

test('wrong or unknown existing jurisdiction stops before creating a missing member', async t => {
  for (const jurisdiction of ['us', undefined]) {
    const f = await fixture(t, [source]);
    f.queues.get(source).jurisdiction = jurisdiction;
    await assert.rejects(f.cli(), error => /not verified EU/.test(error.stderr));
    assert.ok(f.calls.every(c => c.method === 'GET'));
    assert.equal(f.queues.size, 1);
  }
});

test('ambiguous/incomplete lookup and API/network failure stop without writes', async t => {
  for (const fault of ['ambiguous', 'incomplete', 'HTTP', 'auth', 'invalid JSON', 'network']) {
    const f = await fixture(t, [dlq, source]);
    f.fault = fault;
    await assert.rejects(
      f.cli(),
      error =>
        !error.stderr.includes('private response') &&
        !error.stderr.includes('synthetic-token') &&
        (fault !== 'HTTP' || /HTTP 503/.test(error.stderr)) &&
        (fault !== 'auth' || /HTTP 401/.test(error.stderr)) &&
        (fault !== 'invalid JSON' || /invalid JSON \(HTTP 200\)/.test(error.stderr))
    );
    assert.ok(f.calls.every(c => c.method === 'GET'));
  }
});

test('DLQ creation must verify jurisdiction before creating the source', async t => {
  const f = await fixture(t);
  f.fault = 'ignored jurisdiction';
  await assert.rejects(f.cli(), error => /not verified EU/.test(error.stderr));
  assert.deepEqual([...f.queues.keys()], [dlq]);
});

test('lost accepted creation preserves resources and a later run reuses both', async t => {
  const f = await fixture(t);
  f.fault = 'lost acceptance';
  await assert.rejects(f.cli());
  assert.equal(f.queues.size, 2);
  f.fault = undefined;
  await f.cli();
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
});

test('only explicit staging with an injected token can make API calls', async () => {
  let calls = 0;
  const request = () => {
    calls++;
  };
  await assert.rejects(
    prepareQueues('production', { token: 'synthetic-token', request }),
    /staging only/
  );
  await assert.rejects(
    prepareQueues(undefined, { token: 'synthetic-token', request }),
    /staging only/
  );
  await assert.rejects(prepareQueues('staging', { token: '', request }), /TOKEN is required/);
  assert.equal(calls, 0);
});

for (const global of [false, true])
  test(`deployment detaches only the obsolete owned consumer (${global ? 'EU to global' : 'global to EU'}), retry is a no-op`, async t => {
    const f = await fixture(t, [source, dlq, globalSource, globalDlq]);
    if (global) f.global();
    const obsolete = f.queues.get(global ? source : globalSource);
    const selected = f.queues.get(global ? globalSource : source);
    obsolete.consumers = [{ ...owned }];
    selected.consumers = [{ ...owned }];
    await f.cli();
    assert.deepEqual(obsolete.consumers, []);
    assert.deepEqual(selected.consumers, [owned]);
    assert.equal(f.queues.size, 4);
    assert.deepEqual(
      f.calls.filter(c => c.method === 'DELETE').map(c => c.path),
      [
        `/client/v4/accounts/e115e769bcdd4c3d66af59d3332cb394/queues/${obsolete.queue_id}/consumers/${owned.consumer_id}`,
      ]
    );
    await f.cli();
    assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  });

test('service consumer is removed only in its default environment', async t => {
  const f = await fixture(t, [source, dlq, globalSource]);
  f.queues.get(globalSource).consumers = [
    {
      type: 'worker',
      service: 'usage-ingest-staging',
      environment: 'production',
      consumer_id: owned.consumer_id,
    },
  ];
  await f.cli();
  assert.deepEqual(f.queues.get(globalSource).consumers, []);
});

test('first cutover verifies the new EU pair before detaching, and supports documented script_name', async t => {
  const f = await fixture(t, [globalSource, globalDlq]);
  const original = f.queues.get(globalSource);
  original.consumers = [
    { type: 'worker', script_name: 'usage-ingest-staging', consumer_id: owned.consumer_id },
  ];
  await f.cli();
  assert.deepEqual(
    f.calls.filter(c => c.method !== 'GET').map(c => (c.method === 'POST' ? c.name : c.method)),
    [dlq, source, 'DELETE']
  );
  assert.equal(f.queues.get(globalSource), original);
  assert.equal(f.queues.size, 4);
});

test('unverified or foreign ownership fails before any writes', async t => {
  for (const consumers of [
    undefined,
    [{ ...owned, script: 'other-worker' }],
    [{ ...owned, type: 'http_pull' }],
    [owned, owned],
    [{ ...owned, service: 'other-worker' }],
    [{ ...owned, script_name: 'other-worker' }],
    [{ ...owned, consumer_id: 'invalid' }],
    [
      {
        type: 'worker',
        service: 'usage-ingest-staging',
        environment: 'preview',
        consumer_id: owned.consumer_id,
      },
    ],
  ]) {
    const f = await fixture(t, [globalSource]);
    f.queues.get(globalSource).consumers = consumers;
    await assert.rejects(f.cli(), error => /ownership|environment/.test(error.stderr));
    assert.ok(f.calls.every(c => c.method === 'GET'));
  }
});

test('permission or unconfirmed deletion blocks deployment; lost detach can retry safely', async t => {
  for (const fault of ['permission', 'still attached', 'lost detach']) {
    const f = await fixture(t, [source, dlq, globalSource]);
    f.queues.get(globalSource).consumers = [{ ...owned }];
    f.fault = fault;
    await assert.rejects(
      f.cli(),
      error => fault !== 'permission' || /HTTP 403.*permissions/.test(error.stderr)
    );
    f.fault = undefined;
    await f.cli();
    assert.deepEqual(f.queues.get(globalSource).consumers, []);
    assert.equal(
      f.calls.filter(c => c.method === 'DELETE').length,
      fault === 'lost detach' ? 1 : 2
    );
  }
});

test('rollback refuses missing global resources before detaching EU', async t => {
  const f = await fixture(t, [source, dlq]);
  f.global();
  f.queues.get(source).consumers = [{ ...owned }];
  await assert.rejects(f.cli(), error => /Rollback queue.*missing/.test(error.stderr));
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('renaming EU source without the suffix fails before any API access', async t => {
  const f = await fixture(t);
  f.rename();
  await assert.rejects(f.cli(), error => /Expected matching staging/.test(error.stderr));
  assert.deepEqual(f.calls, []);
});
