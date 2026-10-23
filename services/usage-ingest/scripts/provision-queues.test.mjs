import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareQueues } from './provision-queues.mjs';

const execute = promisify(execFile);
const source = 'usage-ingest-processing-staging-eu';
const dlq = 'usage-ingest-processing-dlq-staging-eu';

async function fixture(t, existing = []) {
  const directory = mkdtempSync(join(tmpdir(), 'eu-queues-'));
  const queues = new Map();
  const calls = [];
  let nextId = 0;
  const add = name => {
    const queue = {
      queue_name: name,
      queue_id: String(++nextId).padStart(32, '0'),
      jurisdiction: 'eu',
    };
    queues.set(name, queue);
    return queue;
  };
  existing.forEach(add);
  const f = { queues, calls, fault: undefined };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    let text = '';
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url, 'https://api.cloudflare.com');
    calls.push({ method: req.method, name: body?.queue_name });
    if (f.fault === 'network') {
      req.socket.destroy();
      return;
    }
    if (f.fault === 'HTTP') {
      res.writeHead(503).end('private response');
      return;
    }
    let result;
    let result_info;
    if (req.method === 'POST') {
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
      if (name) {
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
    `const fetch=globalThis.fetch; globalThis.fetch=(url,options)=>{if(!String(url).startsWith('https://api.cloudflare.com/client/v4/accounts/e115e769bcdd4c3d66af59d3332cb394/queues')) throw new Error('Unexpected hosted request');return fetch(${JSON.stringify(endpoint)}+new URL(url).pathname+new URL(url).search,options);};`
  );
  f.cli = () =>
    execute(
      process.execPath,
      [
        '--import',
        join(directory, 'fetch.mjs'),
        new URL('./provision-queues.mjs', import.meta.url).pathname,
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
  for (const fault of ['ambiguous', 'incomplete', 'HTTP', 'network']) {
    const f = await fixture(t, [dlq, source]);
    f.fault = fault;
    await assert.rejects(
      f.cli(),
      error =>
        !error.stderr.includes('private response') && !error.stderr.includes('synthetic-token')
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
