import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { run } from './provision-queues.mjs';

const exec = promisify(execFile);
const source = 'usage-ingest-processing-staging-eu';
const dlq = 'usage-ingest-processing-dlq-staging-eu';
const account = 'e115e769bcdd4c3d66af59d3332cb394';
const worker = 'usage-ingest-staging';

async function fixture(t, names = []) {
  const directory = mkdtempSync(join(tmpdir(), 'usage-eu-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queues = new Map();
  const calls = [];
  let nextId = 0;
  const f = { queues, calls, fault: undefined };
  function add(name) {
    const queue = {
      queue_name: name,
      queue_id: (++nextId).toString(16).padStart(32, '0'),
      jurisdiction: 'eu',
      settings: { message_retention_period: 345600 },
      consumers: [],
      consumers_total_count: 0,
    };
    queues.set(name, queue);
    return queue;
  }
  for (const name of names) add(name);
  const server = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = input ? JSON.parse(input) : undefined;
    const url = new URL(req.url, 'https://api.cloudflare.com');
    assert.equal(req.headers.authorization, 'Bearer synthetic-queue-token');
    assert.ok(url.pathname.startsWith(`/client/v4/accounts/${account}/queues`));
    calls.push({ method: req.method, url, body });
    if (f.fault === 'network') {
      req.socket.destroy();
      return;
    }
    if (f.fault === 'HTTP') {
      res.writeHead(403).end('synthetic-private-response');
      return;
    }
    if (f.fault === 'invalid JSON') {
      res.end('synthetic-private-response');
      return;
    }
    if (f.fault === 'unsuccessful envelope') {
      res.end(
        JSON.stringify({ success: false, errors: [{ message: 'synthetic-private-response' }] })
      );
      return;
    }
    let result;
    let result_info;
    if (req.method === 'POST') {
      assert.ok([source, dlq].includes(body.queue_name));
      assert.equal(body.jurisdiction, 'eu');
      assert.deepEqual(body.settings, { message_retention_period: 345600 });
      assert.ok(!queues.has(body.queue_name));
      result = add(body.queue_name);
      if (f.fault === 'lost accepted source' && body.queue_name === source) {
        req.socket.destroy();
        return;
      }
      if (f.fault === 'ignored jurisdiction') delete result.jurisdiction;
    } else {
      assert.equal(req.method, 'GET');
      if (url.searchParams.has('name')) {
        result = [...queues.values()].filter(q => q.queue_name === url.searchParams.get('name'));
        result_info = { total_pages: result.length ? 1 : 0 };
        if (f.fault === 'ambiguous') {
          result = [result[0], result[0]];
          result_info.total_pages = 1;
        }
        if (f.fault === 'unknown pagination') result_info = undefined;
        if (f.fault === 'paged') {
          result_info = { total_pages: 2 };
          if (url.searchParams.get('page') === '1')
            result = [{ queue_name: url.searchParams.get('name') + '-other' }];
        }
      } else {
        result = [...queues.values()].find(q => q.queue_id === url.pathname.split('/').at(-1));
        if (f.fault === 'wrong identity') result = { ...result, queue_name: 'wrong' };
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, result, result_info }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;
  f.request = (url, options) =>
    fetch(endpoint + new URL(url).pathname + new URL(url).search, options);
  writeFileSync(
    join(directory, 'fetch.mjs'),
    `const original=globalThis.fetch; globalThis.fetch=(url, options)=>{if(!String(url).startsWith('https://api.cloudflare.com/client/v4/accounts/${account}/queues')) throw new Error('Unexpected hosted request'); return original(${JSON.stringify(endpoint)}+new URL(url).pathname+new URL(url).search, options);};`
  );
  f.cli = async (command = 'prepare') =>
    exec(
      process.execPath,
      [
        '--import',
        join(directory, 'fetch.mjs'),
        new URL('./provision-queues.mjs', import.meta.url).pathname,
        command,
        'staging',
      ],
      {
        timeout: 20000,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: 'synthetic-queue-token',
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
          XDG_CONFIG_HOME: directory,
        },
      }
    );
  return f;
}

for (const [name, existing] of [
  ['fresh pair', []],
  ['both existing', [source, dlq]],
  ['source missing', [dlq]],
  ['DLQ missing', [source]],
]) {
  test(`real CLI ${name}: create only absent EU resources, read back DLQ before source, redeploy reuses`, async t => {
    const f = await fixture(t, existing);
    await f.cli();
    const writes = f.calls.filter(c => c.method === 'POST');
    assert.deepEqual(
      writes.map(c => c.body.queue_name),
      [dlq, source].filter(n => !existing.includes(n))
    );
    const sourcePost = f.calls.findIndex(c => c.method === 'POST' && c.body.queue_name === source);
    if (sourcePost >= 0)
      assert.ok(
        f.calls.slice(0, sourcePost).some(c => c.url.pathname.endsWith(f.queues.get(dlq).queue_id))
      );
    await f.cli();
    assert.equal(f.calls.filter(c => c.method === 'POST').length, writes.length);
    assert.equal(f.queues.size, 2);
  });
}

test('incompatible existing source blocks creation of missing DLQ', async t => {
  const f = await fixture(t, [source]);
  f.queues.get(source).jurisdiction = 'us';
  await assert.rejects(
    run('prepare', 'staging', {
      token: 'synthetic-queue-token',
      request: f.request,
    }),
    /jurisdiction\/retention/
  );
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal(f.queues.size, 1);
});

for (const [name, mutate, expected] of [
  ['unknown jurisdiction', q => delete q.jurisdiction, /jurisdiction\/retention/],
  ['wrong retention', q => (q.settings.message_retention_period = 60), /jurisdiction\/retention/],
  ['malformed consumers', q => (q.consumers = null), /Incomplete consumer/],
  ['truncated consumers', q => (q.consumers_total_count = 1), /Incomplete consumer/],
  [
    'foreign owner',
    q => {
      q.consumers = [{ type: 'worker', script: 'foreign', dead_letter_queue: dlq }];
      q.consumers_total_count = 1;
    },
    /Unexpected consumer/,
  ],
  [
    'conflicting aliases',
    q => {
      q.consumers = [
        { type: 'worker', script: worker, service: 'foreign', dead_letter_queue: dlq },
      ];
      q.consumers_total_count = 1;
    },
    /Unexpected consumer/,
  ],
  [
    'malformed alias',
    q => {
      q.consumers = [{ type: 'worker', script: worker, script_name: null, dead_letter_queue: dlq }];
      q.consumers_total_count = 1;
    },
    /Unexpected consumer/,
  ],
  [
    'unknown owner',
    q => {
      q.consumers = [{ type: 'worker', owner: worker, dead_letter_queue: dlq }];
      q.consumers_total_count = 1;
    },
    /Unexpected consumer/,
  ],
  [
    'wrong consumer DLQ',
    q => {
      q.consumers = [{ type: 'worker', service: worker, dead_letter_queue: 'other' }];
      q.consumers_total_count = 1;
    },
    /Unexpected consumer/,
  ],
  [
    'pull consumer',
    q => {
      q.consumers = [{ type: 'http_pull' }];
      q.consumers_total_count = 1;
    },
    /Unexpected consumer/,
  ],
])
  test(`real CLI rejects ${name} without mutation`, async t => {
    const f = await fixture(t, [source, dlq]);
    mutate(f.queues.get(source));
    const before = structuredClone([...f.queues]);
    await assert.rejects(f.cli(), error => expected.test(error.stderr));
    assert.ok(f.calls.every(c => c.method === 'GET'));
    assert.deepEqual([...f.queues], before);
  });

test('matching script/service/script_name owner aliases reuse the attached source; DLQ consumer rejected', async t => {
  const f = await fixture(t, [source, dlq]);
  const q = f.queues.get(source);
  for (const aliases of [
    ['script'],
    ['service'],
    ['script_name'],
    ['script', 'service', 'script_name'],
  ]) {
    q.consumers = [
      {
        type: 'worker',
        ...Object.fromEntries(aliases.map(a => [a, worker])),
        dead_letter_queue: dlq,
      },
    ];
    q.consumers_total_count = 1;
    await run('prepare', 'staging', { token: 'synthetic-queue-token', request: f.request });
  }
  Object.assign(f.queues.get(dlq), { consumers: [{}], consumers_total_count: 1 });
  await assert.rejects(f.cli(), error => /must have no consumer/.test(error.stderr));
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

for (const fault of [
  'ambiguous',
  'unknown pagination',
  'wrong identity',
  'network',
  'HTTP',
  'invalid JSON',
  'unsuccessful envelope',
])
  test(`real CLI ${fault} stops without writes or leaking API body`, async t => {
    const f = await fixture(t, [source, dlq]);
    f.fault = fault;
    await assert.rejects(
      f.cli(),
      error =>
        !error.stderr.includes('synthetic-private-response') &&
        !error.stderr.includes('synthetic-queue-token')
    );
    assert.ok(f.calls.every(c => c.method === 'GET'));
  });

test('pagination follows every page and ignores approximate names', async t => {
  const f = await fixture(t, [source, dlq]);
  f.fault = 'paged';
  await f.cli();
  assert.ok(f.calls.some(c => c.url.searchParams.get('page') === '2'));
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('lost accepted source creation preserves both resources; next CLI run verifies without duplicate writes', async t => {
  const f = await fixture(t);
  f.fault = 'lost accepted source';
  await assert.rejects(f.cli(), error => /request failed/.test(error.stderr));
  assert.equal(f.queues.size, 2);
  f.fault = undefined;
  await f.cli();
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
});

test('creation ignoring jurisdiction stops before creating source; existing DLQ is preserved', async t => {
  const f = await fixture(t);
  f.fault = 'ignored jurisdiction';
  await assert.rejects(f.cli(), error => /jurisdiction\/retention/.test(error.stderr));
  assert.deepEqual([...f.queues.keys()], [dlq]);
});

test('explicit staging and injected token are required before any network operation', async () => {
  let operations = 0;
  const options = {
    token: '',
    request: () => {
      operations++;
    },
  };
  await assert.rejects(run('prepare', 'production', options), /staging only/);
  await assert.rejects(run('prepare', undefined, options), /staging only/);
  await assert.rejects(run('prepare', 'staging', options), /no local credentials/);
  assert.equal(operations, 0);
  const result = spawnSync(
    process.execPath,
    [new URL('./provision-queues.mjs', import.meta.url).pathname, 'prepare'],
    { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Use prepare/);
  assert.equal(
    JSON.parse(readFileSync(new URL('../queues.staging.json', import.meta.url))).jurisdiction,
    'eu'
  );
});
