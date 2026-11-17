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
import test, { describe } from 'node:test';
import { experimental_readRawConfig } from 'wrangler';
import { prepareQueues } from './provision-queues.mjs';

const execute = promisify(execFile);
const maxRetention = 1_209_600;
const defaultSettings = {
  delivery_delay: 0,
  delivery_paused: false,
  message_retention_period: 345_600,
};
const configPath = new URL('../wrangler.jsonc', import.meta.url).pathname;

// The pre-hedge shape (one EU source, its DLQ, one consumer) that historical revisions deploy.
function withoutHedge(queues) {
  return {
    ...queues,
    producers: queues.producers.filter(p => p.binding !== 'USAGE_INGEST_HEDGE_QUEUE'),
    consumers: queues.consumers.filter(c => c.queue.endsWith('-eu')),
  };
}

function writeConfig(path, environment, { hedged, mutate }) {
  const config = structuredClone(experimental_readRawConfig({ config: configPath }).rawConfig);
  for (const selected of [config, config.env.staging]) {
    if (!hedged) selected.queues = withoutHedge(selected.queues);
  }
  mutate?.(environment === 'staging' ? config.env.staging : config);
  const text = JSON.stringify(config, null, 2);
  writeFileSync(path, text);
  return text;
}

async function createFixture(t, existing = [], environment, { hedged = false } = {}) {
  const suffix = environment === 'staging' ? '-staging' : '';
  const globalSource = `usage-ingest-processing${suffix}`;
  const globalDlq = `usage-ingest-processing-dlq${suffix}`;
  const source = `${globalSource}-eu`;
  const dlq = `${globalDlq}-eu`;
  const worker = `usage-ingest${suffix}`;
  const owned = { type: 'worker', script: worker, consumer_id: 'c'.repeat(32) };
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
  const configFile = join(directory, 'wrangler.jsonc');
  const config = writeConfig(configFile, environment, { hedged });
  const queues = new Map();
  const calls = [];
  let nextId = 0;
  const add = (name, settings) => {
    const queue = {
      queue_name: name,
      queue_id: String(++nextId).padStart(32, '0'),
      jurisdiction: name.endsWith('-eu') ? 'eu' : undefined,
      consumers: [],
      settings: { ...defaultSettings, ...settings },
    };
    queues.set(name, queue);
    return queue;
  };
  existing.forEach(add);
  const f = {
    rename: () =>
      writeFileSync(
        join(directory, 'wrangler.jsonc'),
        config.replaceAll(source, 'usage-ingest-renamed')
      ),
    queues,
    calls,
    fault: undefined,
    selectedDlq: dlq,
    hedged,
    mutate: mutate => writeConfig(configFile, environment, { hedged, mutate }),
    global: () => {
      f.selectedDlq = globalDlq;
      writeFileSync(
        join(directory, 'wrangler.jsonc'),
        config.replaceAll(source, globalSource).replaceAll(dlq, globalDlq)
      );
    },
  };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    let text = '';
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url, 'https://api.cloudflare.com');
    calls.push({ method: req.method, name: body?.queue_name, path: url.pathname, body });
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
    } else if (req.method === 'PATCH') {
      const queue = [...queues.values()].find(q => q.queue_id === url.pathname.split('/').at(-1));
      assert.ok(
        queue?.queue_name === f.selectedDlq || (f.hedged && queue?.queue_name === globalDlq),
        'only a selected DLQ is updated'
      );
      assert.deepEqual(Object.keys(body), ['settings']);
      assert.ok(
        body.settings.message_retention_period >= queue.settings.message_retention_period,
        'retention must never be lowered'
      );
      if (f.fault === 'patch rejected') {
        res.writeHead(403).end(JSON.stringify({ success: false }));
        return;
      }
      if (f.fault === 'patch clobbers settings')
        queue.settings = { message_retention_period: body.settings.message_retention_period };
      else if (f.fault !== 'patch ignored') queue.settings = { ...body.settings };
      if (f.fault === 'lost patch') {
        req.socket.destroy();
        return;
      }
      result = queue;
    } else if (req.method === 'POST') {
      const global = [globalDlq, globalSource].includes(body.queue_name);
      const jurisdiction = global ? {} : { jurisdiction: 'eu' };
      assert.deepEqual(
        body,
        [dlq, globalDlq].includes(body.queue_name)
          ? {
              queue_name: body.queue_name,
              ...jurisdiction,
              settings: { message_retention_period: maxRetention },
            }
          : { queue_name: body.queue_name, ...jurisdiction }
      );
      assert.ok(
        (f.hedged ? [dlq, source, globalDlq, globalSource] : [dlq, source]).includes(
          body.queue_name
        ) && !queues.has(body.queue_name)
      );
      if (f.fault === 'unreadable creation' && body.queue_name === globalSource) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, result: {} }));
        return;
      }
      result = add(body.queue_name, f.fault === 'create ignores retention' ? {} : body.settings);
      if (f.fault === 'ignored jurisdiction') delete result.jurisdiction;
      if (
        f.fault === 'created foreign consumer' &&
        [source, globalSource].includes(body.queue_name)
      )
        result.consumers = [{ ...owned, script: 'foreign-worker' }];
      if (f.fault === 'lost acceptance' && body.queue_name === source) {
        req.socket.destroy();
        return;
      }
    } else {
      assert.equal(req.method, 'GET');
      const name = url.searchParams.get('name');
      if (url.pathname.endsWith(`/workers/services/${worker}`)) {
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
        environment,
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

for (const environment of ['staging', 'production'])
  describe(environment, () => {
    const suffix = environment === 'staging' ? '-staging' : '';
    const globalSource = `usage-ingest-processing${suffix}`;
    const globalDlq = `usage-ingest-processing-dlq${suffix}`;
    const source = `${globalSource}-eu`;
    const dlq = `${globalDlq}-eu`;
    const worker = `usage-ingest${suffix}`;
    const owned = { type: 'worker', script: worker, consumer_id: 'c'.repeat(32) };
    const fixture = (t, existing) => createFixture(t, existing, environment);

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
            (fault !== 'invalid JSON' ||
              /invalid JSON \(HTTP 200, SyntaxError\)/.test(error.stderr)) &&
            (fault !== 'network' || /request failed \(TypeError\)/.test(error.stderr))
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

    const patches = f => f.calls.filter(c => c.method === 'PATCH');

    test('missing DLQ is created with maximum retention; the source keeps its default', async t => {
      const f = await fixture(t);
      await f.cli();
      assert.deepEqual(f.queues.get(dlq).settings, {
        ...defaultSettings,
        message_retention_period: maxRetention,
      });
      assert.deepEqual(f.queues.get(source).settings, defaultSettings);
      assert.deepEqual(patches(f), []);
    });

    test('created DLQ that ignored the requested retention is raised before the source is created', async t => {
      const f = await fixture(t);
      f.fault = 'create ignores retention';
      await f.cli();
      assert.deepEqual(
        f.calls.filter(c => c.method !== 'GET').map(c => c.method),
        ['POST', 'PATCH', 'POST']
      );
      assert.equal(f.queues.get(dlq).settings.message_retention_period, maxRetention);
    });

    test('lower DLQ retention is raised, other settings are preserved, and rerun is a no-op', async t => {
      const f = await fixture(t, [dlq, source]);
      const queue = f.queues.get(dlq);
      queue.settings = {
        delivery_delay: 30,
        delivery_paused: true,
        message_retention_period: 86_400,
      };
      f.queues.get(source).settings.message_retention_period = 3_600;
      const sourceBefore = structuredClone(f.queues.get(source));
      const consumersBefore = structuredClone(queue.consumers);
      await f.cli();
      assert.deepEqual(
        patches(f).map(c => [c.path.split('/').at(-1), c.body]),
        [
          [
            queue.queue_id,
            {
              settings: {
                delivery_delay: 30,
                delivery_paused: true,
                message_retention_period: maxRetention,
              },
            },
          ],
        ]
      );
      assert.deepEqual(queue.settings, {
        delivery_delay: 30,
        delivery_paused: true,
        message_retention_period: maxRetention,
      });
      assert.equal(queue.jurisdiction, 'eu');
      assert.deepEqual(queue.consumers, consumersBefore);
      assert.deepEqual(f.queues.get(source), sourceBefore);
      await f.cli();
      assert.equal(patches(f).length, 1);
    });

    test('object-valued settings are preserved and confirmed by value', async t => {
      const f = await fixture(t, [dlq, source]);
      const queue = f.queues.get(dlq);
      queue.settings.future_setting = { mode: 'kept', tags: ['a'] };
      await f.cli();
      assert.deepEqual(queue.settings, {
        ...defaultSettings,
        future_setting: { mode: 'kept', tags: ['a'] },
        message_retention_period: maxRetention,
      });
      assert.ok(f.queues.has(source));
    });

    test('equal or higher DLQ retention makes no update call and is never lowered', async t => {
      for (const retention of [maxRetention, maxRetention + 1]) {
        const f = await fixture(t, [dlq, source]);
        f.queues.get(dlq).settings.message_retention_period = retention;
        await f.cli();
        assert.deepEqual(patches(f), []);
        assert.equal(f.queues.get(dlq).settings.message_retention_period, retention);
      }
    });

    test('unreadable DLQ retention stops before any write', async t => {
      for (const settings of [undefined, null, {}, { message_retention_period: '345600' }]) {
        const f = await fixture(t, [dlq]);
        f.queues.get(dlq).settings = settings;
        await assert.rejects(f.cli(), error => /Cannot read .* retention/.test(error.stderr));
        assert.ok(f.calls.every(c => c.method === 'GET'));
        assert.ok(!f.queues.has(source));
      }
    });

    test('retention readback mismatch stops before creating the source', async t => {
      for (const fault of ['patch ignored', 'patch clobbers settings']) {
        const f = await fixture(t, [dlq]);
        f.fault = fault;
        await assert.rejects(f.cli(), error =>
          /retention update was not confirmed/.test(error.stderr)
        );
        assert.equal(patches(f).length, 1);
        assert.ok(!f.queues.has(source));
        assert.ok(f.calls.every(c => c.method !== 'DELETE'));
      }
    });

    test('retention update API failure fails closed without leaking secrets; lost update can retry', async t => {
      const f = await fixture(t, [dlq, globalSource]);
      f.queues.get(globalSource).consumers = [{ ...owned }];
      f.fault = 'patch rejected';
      await assert.rejects(
        f.cli(),
        error =>
          /HTTP 403/.test(error.stderr) &&
          !error.stderr.includes('synthetic-token') &&
          !error.stderr.includes('Bearer')
      );
      assert.equal(f.queues.get(dlq).settings.message_retention_period, 345_600);
      assert.ok(!f.queues.has(source));
      assert.deepEqual(f.queues.get(globalSource).consumers, [owned]);
      f.fault = 'lost patch';
      await assert.rejects(f.cli());
      f.fault = undefined;
      await f.cli();
      assert.equal(f.queues.get(dlq).settings.message_retention_period, maxRetention);
      assert.equal(patches(f).length, 2);
      assert.deepEqual(f.queues.get(globalSource).consumers, []);
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

    test('only supported environments with an injected token can make API calls', async () => {
      let calls = 0;
      const request = () => {
        calls++;
      };
      await assert.rejects(
        prepareQueues('preview', { token: 'synthetic-token', request }),
        /staging or production/
      );
      await assert.rejects(
        prepareQueues(undefined, { token: 'synthetic-token', request }),
        /staging or production/
      );
      await assert.rejects(prepareQueues(environment, { token: '', request }), /TOKEN is required/);
      assert.equal(calls, 0);
    });

    test('transport and JSON failures keep the original error as the cause without printing it', async () => {
      const transport = new TypeError('private transport detail');
      await assert.rejects(
        prepareQueues(environment, {
          token: 'synthetic-token',
          request: async () => {
            throw transport;
          },
        }),
        error =>
          error.cause === transport &&
          /request failed \(TypeError\)/.test(error.message) &&
          !error.message.includes('private')
      );
      const parse = new SyntaxError('private response');
      await assert.rejects(
        prepareQueues(environment, {
          token: 'synthetic-token',
          request: async () => ({
            ok: true,
            status: 200,
            json: async () => {
              throw parse;
            },
          }),
        }),
        error =>
          error.cause === parse &&
          /invalid JSON \(HTTP 200, SyntaxError\)/.test(error.message) &&
          !error.message.includes('private')
      );
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
        assert.equal(
          f.queues.get(global ? globalDlq : dlq).settings.message_retention_period,
          maxRetention
        );
        assert.deepEqual(f.queues.get(global ? dlq : globalDlq).settings, defaultSettings);
        assert.deepEqual(obsolete.settings, defaultSettings);
        assert.deepEqual(selected.settings, defaultSettings);
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
          service: worker,
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
        { type: 'worker', script_name: worker, consumer_id: owned.consumer_id },
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
        [null],
        ['invalid'],
        [{ ...owned, script: 'other-worker' }],
        [{ ...owned, type: 'http_pull' }],
        [owned, owned],
        [{ ...owned, service: 'other-worker' }],
        [{ ...owned, script_name: 'other-worker' }],
        [{ ...owned, consumer_id: 'invalid' }],
        [
          {
            type: 'worker',
            service: worker,
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
      await assert.rejects(f.cli(), error => /Expected matching/.test(error.stderr));
      assert.deepEqual(f.calls, []);
    });

    test('foreign selected consumer blocks detachment of the old owned consumer', async t => {
      for (const consumers of [undefined, [null], [{ ...owned, script: 'foreign-worker' }]]) {
        const f = await fixture(t, [source, dlq, globalSource]);
        f.queues.get(source).consumers = consumers;
        f.queues.get(globalSource).consumers = [{ ...owned }];
        await assert.rejects(f.cli(), error => /ownership/.test(error.stderr));
        assert.ok(f.calls.every(c => c.method === 'GET'));
        assert.deepEqual(f.queues.get(globalSource).consumers, [owned]);
      }
    });

    test('selected service environment must match before detaching the old consumer', async t => {
      const f = await fixture(t, [source, dlq, globalSource]);
      f.queues.get(source).consumers = [
        { type: 'worker', service: worker, environment: 'preview', consumer_id: owned.consumer_id },
      ];
      f.queues.get(globalSource).consumers = [{ ...owned }];
      await assert.rejects(f.cli(), error => /environment mismatch/.test(error.stderr));
      assert.ok(f.calls.every(c => c.method === 'GET'));
      assert.deepEqual(f.queues.get(globalSource).consumers, [owned]);
    });

    test('unexpected created target owner preserves the old consumer', async t => {
      const f = await fixture(t, [globalSource]);
      f.queues.get(globalSource).consumers = [{ ...owned }];
      f.fault = 'created foreign consumer';
      await assert.rejects(f.cli(), error => /ownership mismatch/.test(error.stderr));
      assert.ok(f.calls.every(c => c.method !== 'DELETE'));
      assert.deepEqual(f.queues.get(globalSource).consumers, [owned]);
    });

    test('only the selected environment namespace can be changed', async t => {
      const otherSource =
        environment === 'production'
          ? 'usage-ingest-processing-staging'
          : 'usage-ingest-processing';
      const f = await fixture(t, [globalSource, otherSource]);
      f.queues.get(globalSource).consumers = [{ ...owned }];
      f.queues.get(otherSource).consumers = [{ ...owned, script: 'other-environment-worker' }];
      const untouched = structuredClone(f.queues.get(otherSource));
      await f.cli();
      assert.deepEqual(f.queues.get(otherSource), untouched);
      assert.deepEqual(f.queues.get(globalSource).consumers, []);
      assert.ok(f.queues.has(source) && f.queues.has(dlq));
    });

    describe('stall hedge configuration', () => {
      const hedged = (t, existing) => createFixture(t, existing, environment, { hedged: true });
      const writes = f => f.calls.filter(c => c.method !== 'GET');

      test('the committed config declares the hedge pair; the legacy fixture does not', async t => {
        const current = await hedged(t, []);
        const legacy = await fixture(t, []);
        assert.equal(current.hedged, true);
        assert.equal(legacy.hedged, false);
        await current.cli();
        await legacy.cli();
        assert.ok(current.queues.has(globalSource) && current.queues.has(globalDlq));
        assert.ok(!legacy.queues.has(globalSource) && !legacy.queues.has(globalDlq));
      });

      for (const existing of [
        [],
        [dlq, source],
        [globalDlq],
        [dlq, source, globalDlq, globalSource],
      ])
        test(`creates only missing queues, global ones without EU jurisdiction (${existing.join(', ') || 'none'} existing)`, async t => {
          const f = await hedged(t, existing);
          await f.cli();
          const created = f.calls.filter(c => c.method === 'POST').map(c => c.name);
          assert.deepEqual(
            created,
            [dlq, source, globalDlq, globalSource].filter(name => !existing.includes(name))
          );
          assert.equal(f.queues.get(source).jurisdiction, 'eu');
          assert.equal(f.queues.get(dlq).jurisdiction, 'eu');
          assert.equal(f.queues.get(globalSource).jurisdiction, undefined);
          assert.equal(f.queues.get(globalDlq).jurisdiction, undefined);
          assert.equal(f.queues.get(globalDlq).settings.message_retention_period, maxRetention);
          assert.equal(f.queues.get(dlq).settings.message_retention_period, maxRetention);
          assert.deepEqual(f.queues.get(globalSource).settings, defaultSettings);
          assert.ok(f.calls.every(c => c.method !== 'DELETE'));
          const before = f.calls.length;
          await f.cli();
          assert.ok(f.calls.slice(before).every(c => c.method === 'GET'));
        });

      test('keeps the owned global consumer attached and never detaches anything', async t => {
        const f = await hedged(t, [source, dlq, globalSource, globalDlq]);
        f.queues.get(source).consumers = [{ ...owned }];
        f.queues.get(globalSource).consumers = [{ ...owned }];
        f.queues.get(globalDlq).settings.message_retention_period = maxRetention;
        f.queues.get(dlq).settings.message_retention_period = maxRetention;
        const before = structuredClone([...f.queues.values()]);
        await f.cli();
        await f.cli();
        assert.deepEqual(writes(f), []);
        assert.deepEqual([...f.queues.values()], before);
      });

      test('a legacy-shaped deployment after hedge activation detaches the hedge consumer regardless of backlog', async t => {
        const f = await fixture(t, [source, dlq, globalSource, globalDlq]);
        const hedgeQueue = f.queues.get(globalSource);
        hedgeQueue.consumers = [{ ...owned }];
        hedgeQueue.backlog = 3;
        await f.cli();
        assert.deepEqual(hedgeQueue.consumers, []);
        assert.equal(hedgeQueue.backlog, 3);
        assert.equal(f.queues.size, 4);
        assert.deepEqual(
          f.calls.filter(c => c.method === 'DELETE').map(c => c.path),
          [
            `/client/v4/accounts/e115e769bcdd4c3d66af59d3332cb394/queues/${hedgeQueue.queue_id}/consumers/${owned.consumer_id}`,
          ]
        );
      });

      test('a service-bound global consumer in the default environment is accepted', async t => {
        const f = await hedged(t, [source, dlq, globalSource, globalDlq]);
        const consumer = {
          type: 'worker',
          service: worker,
          environment: 'production',
          consumer_id: owned.consumer_id,
        };
        f.queues.get(globalSource).consumers = [consumer];
        await f.cli();
        assert.deepEqual(f.queues.get(globalSource).consumers, [consumer]);
        assert.ok(f.calls.every(c => c.method !== 'DELETE'));
      });

      test('raises existing global DLQ retention with readback, keeping other settings', async t => {
        const f = await hedged(t, [source, dlq, globalSource, globalDlq]);
        f.queues.get(dlq).settings.message_retention_period = maxRetention;
        f.queues.get(globalDlq).settings = { ...defaultSettings, delivery_delay: 5 };
        await f.cli();
        assert.deepEqual(
          patches(f).map(c => [c.path.split('/').at(-1), c.body]),
          [
            [
              f.queues.get(globalDlq).queue_id,
              {
                settings: {
                  ...defaultSettings,
                  delivery_delay: 5,
                  message_retention_period: maxRetention,
                },
              },
            ],
          ]
        );
        assert.equal(f.queues.get(globalDlq).settings.message_retention_period, maxRetention);
      });

      test('unconfirmed or unreadable global DLQ retention stops deployment', async t => {
        for (const fault of ['patch ignored', 'patch clobbers settings']) {
          const f = await hedged(t, [source, dlq, globalSource, globalDlq]);
          f.queues.get(dlq).settings.message_retention_period = maxRetention;
          f.fault = fault;
          await assert.rejects(f.cli(), error =>
            new RegExp(`${globalDlq} retention update was not confirmed`).test(error.stderr)
          );
        }
        const f = await hedged(t, [source, dlq, globalSource, globalDlq]);
        f.queues.get(globalDlq).settings = {};
        await assert.rejects(f.cli(), error =>
          new RegExp(`Cannot read ${globalDlq} message retention`).test(error.stderr)
        );
      });

      test('foreign or unverifiable hedge consumer stops before any write', async t => {
        for (const consumers of [
          undefined,
          [null],
          [{ ...owned, script: 'foreign-worker' }],
          [{ ...owned, type: 'http_pull' }],
          [owned, owned],
          [{ ...owned, consumer_id: 'invalid' }],
          [
            {
              type: 'worker',
              service: worker,
              environment: 'preview',
              consumer_id: owned.consumer_id,
            },
          ],
        ]) {
          const f = await hedged(t, [globalSource]);
          f.queues.get(globalSource).consumers = consumers;
          await assert.rejects(f.cli(), error => /ownership|environment/.test(error.stderr));
          assert.ok(f.calls.every(c => c.method === 'GET'));
          assert.deepEqual(f.queues.get(globalSource).consumers, consumers);
          assert.equal(f.queues.size, 1);
        }
      });

      test('a created hedge queue with a foreign consumer stops deployment', async t => {
        const f = await hedged(t, [source, dlq, globalDlq]);
        f.fault = 'created foreign consumer';
        await assert.rejects(f.cli(), error => /ownership mismatch/.test(error.stderr));
        assert.ok(f.calls.every(c => c.method !== 'DELETE'));
      });

      test('a created hedge queue that cannot be read back stops deployment', async t => {
        const f = await hedged(t, [source, dlq, globalDlq]);
        f.fault = 'unreadable creation';
        await assert.rejects(f.cli(), error =>
          new RegExp(`Created queue ${globalSource} was not read back`).test(error.stderr)
        );
      });

      test('a foreign main consumer still stops before any hedge write', async t => {
        const f = await hedged(t, [source]);
        f.queues.get(source).consumers = [{ ...owned, script: 'foreign-worker' }];
        await assert.rejects(f.cli(), error => /ownership/.test(error.stderr));
        assert.ok(f.calls.every(c => c.method === 'GET'));
      });

      const hedgeProducer = selected =>
        selected.queues.producers.find(p => p.binding === 'USAGE_INGEST_HEDGE_QUEUE');
      const otherGlobal =
        environment === 'production'
          ? 'usage-ingest-processing-staging'
          : 'usage-ingest-processing';
      for (const [name, mutate] of [
        ['hedge producer without its consumer', s => s.queues.consumers.pop()],
        [
          'hedge consumer without its producer',
          s => {
            s.queues.producers = s.queues.producers.filter(p => p !== hedgeProducer(s));
          },
        ],
        [
          'hedge producer on another queue',
          s => {
            hedgeProducer(s).queue = `${globalSource}-other`;
          },
        ],
        [
          "hedge producer on the other environment's queue",
          s => {
            hedgeProducer(s).queue = otherGlobal;
            s.queues.consumers[1].queue = otherGlobal;
          },
        ],
        [
          'hedge consumer on another queue',
          s => {
            s.queues.consumers[1].queue = `${globalSource}-other`;
          },
        ],
        [
          'hedge consumer dead-lettering into the EU DLQ',
          s => {
            s.queues.consumers[1].dead_letter_queue = dlq;
          },
        ],
        [
          'two hedge producers',
          s => {
            s.queues.producers.push({ ...hedgeProducer(s) });
          },
        ],
        [
          'hedge with a global main source',
          s => {
            s.queues.producers[0].queue = globalSource;
            s.queues.producers[1].queue = globalDlq;
            s.queues.consumers[0].queue = globalSource;
            s.queues.consumers[0].dead_letter_queue = globalDlq;
          },
        ],
      ])
        test(`malformed hedge config is rejected before API access: ${name}`, async t => {
          const f = await hedged(t, [source, dlq, globalSource, globalDlq]);
          f.mutate(mutate);
          await assert.rejects(f.cli(), error => /Expected matching/.test(error.stderr));
          assert.deepEqual(f.calls, []);
        });
    });
  });
