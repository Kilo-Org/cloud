import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';

const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const retention = 345600;

export function stagingWriterCeiling(consumers) {
  let total = 0;
  for (const consumer of consumers) {
    const { max_concurrency, max_batch_size } = consumer;
    if (
      !Number.isInteger(max_concurrency) ||
      max_concurrency < 1 ||
      !Number.isInteger(max_batch_size) ||
      max_batch_size < 1
    ) {
      throw new Error('Staging queues need explicit positive batch and concurrency bounds.');
    }
    total += max_concurrency * max_batch_size;
  }
  if (total > 200) throw new Error('Combined staging writer-call ceiling exceeds 200.');
  return total;
}

export function queuePlan(
  environment,
  config = experimental_readRawConfig({ config: configPath }).rawConfig
) {
  if (environment !== 'staging') {
    throw new Error('Only staging is supported; production queues are outside this setup.');
  }
  const selected = config.env?.staging;
  const oldSource = 'usage-ingest-processing-staging';
  const oldDlq = 'usage-ingest-processing-dlq-staging';
  const source = `${oldSource}-eu`;
  const dlq = `${oldDlq}-eu`;
  const producers = selected?.queues?.producers;
  const consumers = selected?.queues?.consumers;
  const producerSource = producers?.find(p => p.binding === 'USAGE_INGEST_QUEUE')?.queue;
  const producerDlq = producers?.find(p => p.binding === 'USAGE_INGEST_DLQ')?.queue;
  // A rollback changes only this pair, keeping both consumers draining.
  const coherentDestination =
    (producerSource === source && producerDlq === dlq) ||
    (producerSource === oldSource && producerDlq === oldDlq);
  if (
    config.account_id !== 'e115e769bcdd4c3d66af59d3332cb394' ||
    selected?.name !== 'usage-ingest-staging' ||
    producers?.length !== 2 ||
    !coherentDestination ||
    consumers?.length !== 2 ||
    selected.services?.find(s => s.binding === 'USAGE_WRITER_RELAY')?.service !==
      'usage-writer-relay-staging' ||
    consumers.find(c => c.queue === source)?.dead_letter_queue !== dlq ||
    consumers.find(c => c.queue === oldSource)?.dead_letter_queue !== oldDlq
  ) {
    throw new Error('Unexpected usage queue bindings; refusing resource operations.');
  }
  stagingWriterCeiling(consumers);
  return { account: config.account_id, worker: selected.name, source, dlq, oldSource, oldDlq };
}

export function queueApi(account, token, request = fetch) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required; no local credentials are loaded.');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/queues`;
  return async (suffix = '', method = 'GET', body) => {
    let response;
    try {
      response = await request(`${base}${suffix}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error('Queue API request failed; preserve all resources and rerun verification.');
    }
    if (!response.ok)
      throw new Error(`Queue API HTTP ${response.status}; no cleanup was attempted.`);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Invalid Queue API JSON; no cleanup was attempted.');
    }
    if (
      data?.success !== true ||
      (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length))
    ) {
      throw new Error('Queue API did not confirm success; no cleanup was attempted.');
    }
    return data;
  };
}

async function findQueue(api, name) {
  // Wrangler uses this same name filter. Still match exactly and follow pagination.
  const matches = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`?name=${encodeURIComponent(name)}&page=${page}`);
    if (!Array.isArray(data.result)) throw new Error('Invalid Queue API list.');
    matches.push(...data.result.filter(q => q?.queue_name === name));
    const pages = data.result_info?.total_pages;
    if (page === 1 && pages === 0 && data.result.length === 0) break;
    if (!Number.isInteger(pages) || pages < page || pages > 100) {
      throw new Error('Queue API pagination is missing or invalid; refusing to assume absence.');
    }
    if (page === pages) break;
  }
  if (matches.length > 1) throw new Error(`Ambiguous queue name: ${name}.`);
  if (!matches.length) return undefined;
  if (!/^[a-f0-9]{32}$/.test(matches[0].queue_id ?? ''))
    throw new Error(`Invalid queue ID: ${name}.`);
  const { result } = await api(`/${matches[0].queue_id}`);
  if (result?.queue_name !== name || result.queue_id !== matches[0].queue_id) {
    throw new Error(`Queue readback identity mismatch: ${name}.`);
  }
  return result;
}

function checkQueue(queue, name, worker, dlq, eu) {
  if (!queue)
    throw new Error(`Missing queue ${name}; explicitly create EU resources before deployment.`);
  if (eu && queue.jurisdiction !== 'eu')
    throw new Error(`Queue ${name} is not verified EU; never delete/recreate it.`);
  if (eu && queue.settings?.message_retention_period !== retention) {
    throw new Error(`Queue ${name} must retain messages for ${retention} seconds.`);
  }
  if (!Array.isArray(queue.consumers) || queue.consumers_total_count !== queue.consumers.length) {
    throw new Error(`Incomplete consumer metadata: ${name}.`);
  }
  if (dlq === undefined) {
    if (queue.consumers.length) throw new Error(`DLQ ${name} must have no consumer.`);
  } else if (
    queue.consumers.some(
      c => c.type !== 'worker' || c.script_name !== worker || c.dead_letter_queue !== dlq
    )
  ) {
    throw new Error(`Unexpected consumer type, owner, or DLQ: ${name}.`);
  }
}

export async function prepareQueues(plan, api, create = false) {
  const desired = [plan.dlq, plan.source];
  const existing = new Map();
  // Inspect every existing resource before any create, including the retained old pair.
  for (const name of [...desired, plan.oldDlq, plan.oldSource]) {
    const queue = await findQueue(api, name);
    if (queue || !create || !desired.includes(name)) {
      checkQueue(
        queue,
        name,
        plan.worker,
        name === plan.source ? plan.dlq : name === plan.oldSource ? plan.oldDlq : undefined,
        desired.includes(name)
      );
    }
    existing.set(name, queue);
  }
  if (existing.get(plan.oldSource)?.jurisdiction !== existing.get(plan.oldDlq)?.jurisdiction) {
    throw new Error('Original source/DLQ jurisdictions differ; preserve them and investigate.');
  }
  const verified = [];
  for (const name of desired) {
    if (create && !existing.get(name)) {
      // Never patch jurisdiction, update a consumer, or delete anything. Ambiguous failures
      // leave resources intact; a later invocation discovers them through readback.
      await api('', 'POST', {
        queue_name: name,
        jurisdiction: 'eu',
        settings: { message_retention_period: retention },
      });
    }
    const queue = await findQueue(api, name);
    checkQueue(queue, name, plan.worker, name === plan.source ? plan.dlq : undefined, true);
    verified.push({
      queue_name: name,
      queue_id: queue.queue_id,
      jurisdiction: queue.jurisdiction,
      message_retention_period: queue.settings.message_retention_period,
    });
  }
  return verified;
}

export async function run(
  command,
  environment,
  { token = process.env.CLOUDFLARE_API_TOKEN, request = fetch, deploy = spawnSync } = {}
) {
  if (!['verify', 'create', 'deploy'].includes(command))
    throw new Error('Use verify, create, or deploy followed by staging.');
  const plan = queuePlan(environment);
  const verified = await prepareQueues(
    plan,
    queueApi(plan.account, token, request),
    command === 'create'
  );
  if (command === 'deploy') {
    // Keep the merged CI deployment order in the guarded direct path too.
    for (const args of [
      ['exec', 'wrangler', 'deploy', '--config', 'wrangler.writer-relay.jsonc'],
      ['exec', 'wrangler', 'deploy', '--experimental-provision=false', '--env', 'staging'],
    ]) {
      const result = deploy('pnpm', args, {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: 'inherit',
      });
      if (result.error || result.status !== 0) {
        throw new Error(
          'Worker deployment did not confirm success; inspect the deployed version and both queue pairs. No cleanup was attempted.'
        );
      }
    }
  }
  return verified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4)
      throw new Error('Usage: node scripts/eu-queues.mjs <verify|create|deploy> <staging>');
    console.log(JSON.stringify(await run(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Queue setup failed.');
    process.exitCode = 1;
  }
}
