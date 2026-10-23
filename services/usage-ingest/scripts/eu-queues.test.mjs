import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { experimental_readRawConfig } from 'wrangler';
import { queueApi, queuePlan, prepareQueues, run, stagingWriterCeiling } from './eu-queues.mjs';

function fixture(environment = 'staging', eu = true) {
  const plan = queuePlan(environment);
  const queues = new Map();
  const calls = [];
  let nextQueueId = 0;
  function add(name, jurisdiction) {
    const queue = {
      queue_id: (++nextQueueId).toString(16).padStart(32, '0'),
      queue_name: name,
      consumers: [],
      consumers_total_count: 0,
      settings: { message_retention_period: 345600 },
      ...(jurisdiction ? { jurisdiction } : {}),
    };
    queues.set(name, queue);
    return queue;
  }
  add(plan.oldSource);
  add(plan.oldDlq);
  queues.get(plan.oldSource).consumers = [
    { type: 'worker', script_name: plan.worker, dead_letter_queue: plan.oldDlq },
  ];
  queues.get(plan.oldSource).consumers_total_count = 1;
  if (eu) {
    add(plan.dlq, 'eu');
    add(plan.source, 'eu');
  }
  async function request(input, options) {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method, url, body });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
    let result;
    let result_info;
    if (options.method === 'POST') {
      assert.equal(url.pathname, `/client/v4/accounts/${plan.account}/queues`);
      assert.equal(body.jurisdiction, 'eu');
      assert.ok([plan.source, plan.dlq].includes(body.queue_name));
      assert.ok(!queues.has(body.queue_name));
      result = add(body.queue_name, body.jurisdiction);
      result.settings = body.settings;
    } else {
      assert.equal(options.method, 'GET');
      if (url.searchParams.has('name')) {
        result = [...queues.values()].filter(q => q.queue_name === url.searchParams.get('name'));
        result_info = { page: 1, total_pages: result.length ? 1 : 0 };
      } else {
        result = [...queues.values()].find(q => q.queue_id === url.pathname.split('/').at(-1));
      }
    }
    return Response.json({ success: true, result, result_info });
  }
  return {
    plan,
    queues,
    calls,
    request,
    api: queueApi(plan.account, 'synthetic-test-token', request),
  };
}

// Synthetic GET contracts: pinned Wrangler reads script/service; public API
// examples use script_name. These fixtures do not assert an observed live shape.
const ownerAliases = ['script', 'service', 'script_name'];
for (let mask = 1; mask < 8; mask++) {
  const aliases = ownerAliases.filter((_, index) => mask & (1 << index));
  test(`matching consumer owner aliases ${aliases.join('+')} verify and reuse without writes`, async () => {
    const f = fixture();
    for (const [name, dlq] of [
      [f.plan.oldSource, f.plan.oldDlq],
      [f.plan.source, f.plan.dlq],
    ]) {
      Object.assign(f.queues.get(name), {
        consumers: [
          {
            type: 'worker',
            consumer_id: 'a'.repeat(32),
            ...Object.fromEntries(aliases.map(key => [key, f.plan.worker])),
            dead_letter_queue: dlq,
            settings: { batch_size: 1, max_concurrency: 1 },
          },
        ],
        consumers_total_count: 1,
      });
    }
    const before = structuredClone([...f.queues]);
    await prepareQueues(f.plan, f.api);
    await prepareQueues(f.plan, f.api, true);
    assert.ok(f.calls.every(c => c.method === 'GET'));
    assert.deepEqual([...f.queues], before);
  });
}

for (const alias of ownerAliases) {
  test(`${alias} rejects foreign, malformed and conflicting ownership before any create`, async () => {
    for (const source of ['source', 'oldSource']) {
      for (const value of ['other-worker', '', ' usage-ingest-staging ', null, 1, true, {}, []]) {
        // Also reject a malformed/foreign alias beside another valid alias;
        // choosing the first non-null owner would hide contradictory metadata.
        for (const includeValidAlias of [false, true]) {
          const f = fixture();
          const otherAlias = ownerAliases.find(key => key !== alias);
          Object.assign(f.queues.get(f.plan[source]), {
            consumers: [
              {
                type: 'worker',
                ...(includeValidAlias ? { [otherAlias]: f.plan.worker } : {}),
                [alias]: value,
                dead_letter_queue: source === 'source' ? f.plan.dlq : f.plan.oldDlq,
              },
            ],
            consumers_total_count: 1,
          });
          // One absent EU resource must not be created before inspecting all owners.
          f.queues.delete(f.plan.dlq);
          const before = structuredClone([...f.queues]);
          await assert.rejects(prepareQueues(f.plan, f.api, true), /Unexpected consumer/);
          assert.ok(f.calls.every(c => c.method === 'GET'));
          assert.deepEqual([...f.queues], before);
        }
      }
    }
  });
}

test('missing or unknown owner fields and malformed consumer entries fail closed', async () => {
  for (const source of ['source', 'oldSource']) {
    for (const consumer of [null, [], 'worker', 1, {}, { owner: 'usage-ingest-staging' }]) {
      const f = fixture();
      const metadata =
        consumer && typeof consumer === 'object' && !Array.isArray(consumer)
          ? {
              type: 'worker',
              dead_letter_queue: source === 'source' ? f.plan.dlq : f.plan.oldDlq,
              ...consumer,
            }
          : consumer;
      Object.assign(f.queues.get(f.plan[source]), {
        consumers: [metadata],
        consumers_total_count: 1,
      });
      f.queues.delete(f.plan.dlq);
      const before = structuredClone([...f.queues]);
      await assert.rejects(prepareQueues(f.plan, f.api, true), /Unexpected consumer/);
      assert.ok(f.calls.every(c => c.method === 'GET'));
      assert.deepEqual([...f.queues], before);
    }
  }
});

for (const environment of ['staging']) {
  test(`${environment}: create EU DLQ before source, read back, then reuse without writes`, async () => {
    const f = fixture(environment, false);
    const originals = structuredClone([...f.queues]);
    const result = await prepareQueues(f.plan, f.api, true);
    assert.deepEqual(
      result.map(q => q.queue_name),
      [f.plan.dlq, f.plan.source]
    );
    const writes = f.calls.filter(c => c.method !== 'GET');
    assert.deepEqual(
      writes.map(c => c.body),
      [f.plan.dlq, f.plan.source].map(queue_name => ({
        queue_name,
        jurisdiction: 'eu',
        settings: { message_retention_period: 345600 },
      }))
    );
    const firstCreate = f.calls.indexOf(writes[0]);
    assert.equal(
      f.calls
        .slice(0, firstCreate)
        .filter(c => c.url.pathname.endsWith(f.queues.get(f.plan.oldSource).queue_id)).length,
      1
    );
    const dlqRead = f.calls.findIndex(
      (c, i) => i > firstCreate && c.url.pathname.endsWith(f.queues.get(f.plan.dlq).queue_id)
    );
    assert.ok(dlqRead > firstCreate && dlqRead < f.calls.indexOf(writes[1]));
    await prepareQueues(f.plan, f.api, true);
    assert.equal(f.calls.filter(c => c.method !== 'GET').length, 2);
    assert.deepEqual([...f.queues].slice(0, 2), originals);
  });
}

test('verify never creates missing resources and blocks deployment', async () => {
  const f = fixture('staging', false);
  let deployments = 0;
  await assert.rejects(
    run('deploy', 'staging', {
      token: 'synthetic-test-token',
      request: f.request,
      deploy: () => {
        deployments++;
        return { status: 0 };
      },
    }),
    /Missing queue/
  );
  assert.equal(deployments, 0);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('nonzero deployment reports uncertainty and does not attempt queue cleanup', async () => {
  const f = fixture();
  let deployments = 0;
  await assert.rejects(
    run('deploy', 'staging', {
      token: 'synthetic-test-token',
      request: f.request,
      deploy: () => {
        deployments++;
        return { status: 1 };
      },
    }),
    /did not confirm success; inspect the deployed version and both queue pairs/
  );
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal(deployments, 1, 'A failed relay must stop before the consumer deploy.');
});

for (const [name, mutate, expected] of [
  [
    'global EU-named source',
    f => {
      delete f.queues.get(f.plan.source).jurisdiction;
    },
    /not verified EU/,
  ],
  [
    'wrong jurisdiction DLQ',
    f => {
      f.queues.get(f.plan.dlq).jurisdiction = 'us';
    },
    /not verified EU/,
  ],
  [
    'unexpected pull consumer',
    f => {
      Object.assign(f.queues.get(f.plan.source), {
        consumers: [{ type: 'http_pull' }],
        consumers_total_count: 1,
      });
    },
    /Unexpected consumer/,
  ],
  [
    'foreign Worker owner',
    f => {
      Object.assign(f.queues.get(f.plan.source), {
        consumers: [{ type: 'worker', script_name: 'other', dead_letter_queue: f.plan.dlq }],
        consumers_total_count: 1,
      });
    },
    /Unexpected consumer/,
  ],
  [
    'wrong consumer DLQ',
    f => {
      Object.assign(f.queues.get(f.plan.source), {
        consumers: [
          { type: 'worker', script_name: f.plan.worker, dead_letter_queue: f.plan.oldDlq },
        ],
        consumers_total_count: 1,
      });
    },
    /Unexpected consumer/,
  ],
  [
    'DLQ being consumed',
    f => {
      Object.assign(f.queues.get(f.plan.dlq), { consumers: [{}], consumers_total_count: 1 });
    },
    /must have no consumer/,
  ],
  [
    'truncated consumer list',
    f => {
      f.queues.get(f.plan.source).consumers_total_count = 1;
    },
    /Incomplete consumer/,
  ],
  [
    'wrong retention',
    f => {
      f.queues.get(f.plan.dlq).settings.message_retention_period = 60;
    },
    /must retain/,
  ],
  [
    'missing old source',
    f => {
      f.queues.delete(f.plan.oldSource);
    },
    /Missing queue/,
  ],
  [
    'old jurisdiction mismatch',
    f => {
      f.queues.get(f.plan.oldDlq).jurisdiction = 'eu';
    },
    /Original source\/DLQ/,
  ],
]) {
  test(`${name} fails closed without any mutations`, async () => {
    const f = fixture();
    mutate(f);
    const before = structuredClone([...f.queues]);
    await assert.rejects(prepareQueues(f.plan, f.api, true), expected);
    assert.ok(f.calls.every(c => c.method === 'GET'));
    assert.deepEqual([...f.queues], before);
  });
}

test('one missing EU resource does not get created when the other already has wrong jurisdiction', async () => {
  const f = fixture();
  f.queues.delete(f.plan.dlq);
  f.queues.get(f.plan.source).jurisdiction = 'us';
  await assert.rejects(prepareQueues(f.plan, f.api, true), /not verified EU/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('failed/ambiguous source creation preserves the already-created DLQ and originals; rerun reuses it', async () => {
  const f = fixture('staging', false);
  const request = async (url, options) => {
    if (options.method === 'POST' && JSON.parse(options.body).queue_name === f.plan.source)
      throw new Error('synthetic lost response');
    return f.request(url, options);
  };
  await assert.rejects(
    prepareQueues(f.plan, queueApi(f.plan.account, 'synthetic-test-token', request), true),
    /request failed/
  );
  assert.equal(f.queues.get(f.plan.dlq).jurisdiction, 'eu');
  assert.ok(f.queues.has(f.plan.oldSource) && f.queues.has(f.plan.oldDlq));
  await prepareQueues(f.plan, f.api, true);
  assert.equal(
    f.calls.filter(c => c.method === 'POST' && c.body.queue_name === f.plan.dlq).length,
    1
  );
});

test('API silently ignoring jurisdiction is rejected before source creation', async () => {
  const f = fixture('staging', false);
  const request = async (url, options) => {
    const response = await f.request(url, options);
    if (options.method === 'POST') delete f.queues.get(f.plan.dlq).jurisdiction;
    return response;
  };
  await assert.rejects(
    prepareQueues(f.plan, queueApi(f.plan.account, 'synthetic-test-token', request), true),
    /not verified EU/
  );
  assert.ok(!f.queues.has(f.plan.source));
  assert.ok(f.queues.has(f.plan.dlq));
});

test('pagination checks all pages and exact names, then verifies resource identity', async () => {
  const f = fixture();
  const request = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('page') === '1')
      return Response.json({
        success: true,
        result: [{ queue_name: `${parsed.searchParams.get('name')}-unrelated` }],
        result_info: { total_pages: 2 },
      });
    const data = await (await f.request(url, options)).json();
    if (parsed.searchParams.has('page')) data.result_info = { total_pages: 2 };
    return Response.json(data);
  };
  await prepareQueues(f.plan, queueApi(f.plan.account, 'synthetic-test-token', request));
  const bad = async (url, options) => {
    const response = await f.request(url, options);
    const data = await response.json();
    if (!new URL(url).search) data.result.queue_name = 'wrong-identity';
    return Response.json(data);
  };
  await assert.rejects(
    prepareQueues(f.plan, queueApi(f.plan.account, 'synthetic-test-token', bad)),
    /identity mismatch/
  );
});

test('unknown pagination, duplicate identities, HTTP errors, invalid JSON and unsuccessful envelopes abort', async () => {
  for (const response of [
    Response.json({ success: true, result: [] }),
    Response.json({
      success: true,
      result: [{ queue_name: queuePlan('staging').dlq }, { queue_name: queuePlan('staging').dlq }],
      result_info: { total_pages: 1 },
    }),
    new Response('synthetic private response body', { status: 403 }),
    new Response('invalid JSON'),
    Response.json({ success: false, errors: [{ message: 'synthetic private API message' }] }),
  ]) {
    await assert.rejects(
      prepareQueues(
        queuePlan('staging'),
        queueApi('a'.repeat(32), 'synthetic-test-token', async () => response.clone())
      ),
      error => !error.message.includes('private')
    );
  }
});

test('real local HTTP metadata verification completes before deployment; provisioning is disabled', async t => {
  const f = fixture();
  const server = createServer(async (req, res) => {
    const response = await f.request(`https://api.cloudflare.com${req.url}`, {
      method: req.method,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: req.headers.authorization },
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(await response.text());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  const request = (url, options) =>
    fetch(
      `http://127.0.0.1:${address.port}${new URL(url).pathname}${new URL(url).search}`,
      options
    );
  let deployments = 0;
  await run('deploy', 'staging', {
    token: 'synthetic-test-token',
    request,
    deploy: (binary, args) => {
      assert.equal(binary, 'pnpm');
      assert.deepEqual(
        args,
        deployments === 0
          ? ['exec', 'wrangler', 'deploy', '--config', 'wrangler.writer-relay.jsonc']
          : ['exec', 'wrangler', 'deploy', '--experimental-provision=false', '--env', 'staging']
      );
      assert.ok(
        f.calls.filter(c => c.url.pathname.endsWith(f.queues.get(f.plan.source).queue_id)).length >=
          2
      );
      assert.ok(f.calls.every(c => c.method === 'GET'));
      deployments++;
      return { status: 0 };
    },
  });
  assert.equal(deployments, 2);
});

test('requires explicit environment/token and rejects config drift before any API/deploy operation', async () => {
  assert.throws(() => queuePlan(), /Only staging/);
  assert.throws(() => queuePlan('production'), /Only staging/);
  assert.throws(() => queuePlan('preview'), /Only staging/);
  assert.throws(() => queueApi('a'.repeat(32), ''), /no local credentials/);
  const { rawConfig } = experimental_readRawConfig({
    config: new URL('../wrangler.jsonc', import.meta.url).pathname,
  });
  rawConfig.env.staging.queues.producers[0].queue = 'unexpected';
  assert.throws(() => queuePlan('staging', rawConfig), /Unexpected usage/);
  rawConfig.account_id = 'a'.repeat(32);
  assert.throws(() => queuePlan('staging', rawConfig), /Unexpected usage/);
});

test('rollback accepts the coherent old producer pair while verifying and retaining both queue pairs', async () => {
  const f = fixture();
  const { rawConfig } = experimental_readRawConfig({
    config: new URL('../wrangler.jsonc', import.meta.url).pathname,
  });
  const producers = rawConfig.env.staging.queues.producers;
  producers[0].queue = f.plan.oldSource;
  assert.throws(() => queuePlan('staging', rawConfig), /Unexpected usage/);
  producers[1].queue = f.plan.oldDlq;
  const plan = queuePlan('staging', rawConfig);
  await prepareQueues(plan, f.api);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal(rawConfig.env.staging.queues.consumers.length, 2);
});

test('lost create response after acceptance is safely reusable without duplicate creation', async () => {
  const f = fixture('staging', false);
  const request = async (url, options) => {
    const response = await f.request(url, options);
    if (options.method === 'POST' && JSON.parse(options.body).queue_name === f.plan.source)
      throw new Error('synthetic response lost after acceptance');
    return response;
  };
  await assert.rejects(
    prepareQueues(f.plan, queueApi(f.plan.account, 'synthetic-test-token', request), true),
    /request failed/
  );
  assert.ok(f.queues.has(f.plan.source));
  await prepareQueues(f.plan, f.api, true);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
});

test('production queue policy stays unchanged and standalone or planned staging config has exactly 200 writer calls', () => {
  const { rawConfig: config } = experimental_readRawConfig({
    config: new URL('../wrangler.jsonc', import.meta.url).pathname,
  });
  const { rawConfig: base } = experimental_readRawConfig({
    config: new URL('../test/fixtures/pre-eu/wrangler.jsonc', import.meta.url).pathname,
  });
  const { env: configEnv, ...production } = config;
  const { env: baseEnv, ...baseProduction } = base;
  assert.deepEqual(production.queues, baseProduction.queues);
  assert.equal(production.vars.USAGE_INGEST_MODE, baseProduction.vars.USAGE_INGEST_MODE);
  const { queues, ...stagingRest } = configEnv.staging;
  const { queues: baseQueues, ...baseStagingRest } = baseEnv.staging;
  const { vars, ...structure } = stagingRest;
  const { vars: baseVars, ...baseStructure } = baseStagingRest;
  assert.deepEqual(structure, baseStructure);
  for (const [key, value] of Object.entries(baseVars)) assert.equal(vars[key], value);
  const batchSize = vars.USAGE_INGEST_PARALLELISM === '2' ? 2 : 1;
  assert.deepEqual(queues.consumers[0], {
    ...baseQueues.consumers[0],
    max_concurrency: 1,
    max_batch_size: batchSize,
  });
  assert.deepEqual(queues.consumers[1], {
    ...baseQueues.consumers[0],
    max_concurrency: batchSize === 2 ? 99 : 199,
    max_batch_size: batchSize,
    queue: 'usage-ingest-processing-staging-eu',
    dead_letter_queue: 'usage-ingest-processing-dlq-staging-eu',
  });
  assert.equal(stagingWriterCeiling(queues.consumers), 200);
});

test('planned batch2/parallel2 composition needs legacy1 plus EU99; cap100 on both or EU100 is rejected', () => {
  const { rawConfig } = experimental_readRawConfig({
    config: new URL('../wrangler.jsonc', import.meta.url).pathname,
  });
  const consumers = rawConfig.env.staging.queues.consumers;
  rawConfig.env.staging.vars.USAGE_INGEST_PARALLELISM = '2';
  for (const consumer of consumers) consumer.max_batch_size = 2;
  consumers[0].max_concurrency = 1;
  consumers[1].max_concurrency = 199;
  assert.throws(() => stagingWriterCeiling(consumers), /exceeds 200/);
  consumers[1].max_concurrency = 99;
  assert.equal(stagingWriterCeiling(consumers), 200);
  assert.doesNotThrow(() => queuePlan('staging', rawConfig));
  consumers[1].max_concurrency = 100;
  assert.throws(() => stagingWriterCeiling(consumers), /exceeds 200/);
  consumers[0].max_concurrency = 100;
  assert.throws(() => stagingWriterCeiling(consumers), /exceeds 200/);
  consumers[0].max_concurrency = null;
  assert.throws(() => stagingWriterCeiling(consumers), /explicit positive/);
});

test('production setup is rejected before any HTTP or deployment operation', async () => {
  let calls = 0;
  await assert.rejects(
    run('create', 'production', {
      token: 'synthetic-test-token',
      request: () => {
        calls++;
      },
    }),
    /Only staging/
  );
  assert.equal(calls, 0);
});
