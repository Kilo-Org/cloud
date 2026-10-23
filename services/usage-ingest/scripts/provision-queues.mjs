import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';

const directory = fileURLToPath(new URL('../', import.meta.url));

function readPlan(environment) {
  if (environment !== 'staging') throw new Error('Queue provisioning supports staging only.');
  const { rawConfig: config } = experimental_readRawConfig({
    config: `${directory}wrangler.jsonc`,
  });
  const staging = config.env?.staging;
  const { producers, consumers } = staging?.queues ?? {};
  const source = producers?.find(p => p.binding === 'USAGE_INGEST_QUEUE')?.queue;
  const dlq = producers?.find(p => p.binding === 'USAGE_INGEST_DLQ')?.queue;
  if (
    config.account_id !== 'e115e769bcdd4c3d66af59d3332cb394' ||
    staging?.name !== 'usage-ingest-staging' ||
    producers?.length !== 2 ||
    consumers?.length !== 1 ||
    consumers[0].queue !== source ||
    consumers[0].dead_letter_queue !== dlq
  )
    throw new Error('Unexpected staging queue bindings; refusing resource operations.');
  const policy = JSON.parse(readFileSync(`${directory}queues.staging.json`, 'utf8'));
  if (
    source !== 'usage-ingest-processing-staging-eu' ||
    dlq !== 'usage-ingest-processing-dlq-staging-eu' ||
    policy?.jurisdiction !== 'eu' ||
    policy.message_retention_period !== 345600
  )
    throw new Error('Expected the versioned staging EU queue policy and matching bindings.');
  return {
    account: config.account_id,
    worker: staging.name,
    source,
    dlq,
    jurisdiction: policy.jurisdiction,
    message_retention_period: policy.message_retention_period,
  };
}

function queueApi(account, token, request) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required; no local credentials are loaded.');
  return async (suffix = '', method = 'GET', body) => {
    let response;
    try {
      response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${account}/queues${suffix}`,
        {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }
      );
    } catch {
      throw new Error('Queue API request failed; preserve resources and rerun preparation.');
    }
    if (!response.ok) throw new Error(`Queue API HTTP ${response.status}; no cleanup attempted.`);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Invalid Queue API JSON.');
    }
    if (
      data?.success !== true ||
      (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length))
    ) {
      throw new Error('Queue API did not confirm success.');
    }
    return data;
  };
}

async function findQueue(api, name) {
  const matches = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`?name=${encodeURIComponent(name)}&page=${page}`);
    if (!Array.isArray(data.result)) throw new Error('Invalid Queue API list.');
    matches.push(...data.result.filter(q => q?.queue_name === name));
    const pages = data.result_info?.total_pages;
    if (page === 1 && pages === 0 && data.result.length === 0) break;
    if (!Number.isInteger(pages) || pages < page || pages > 100) {
      throw new Error('Incomplete Queue API pagination; refusing to assume absence.');
    }
    if (page === pages) break;
  }
  if (matches.length > 1) throw new Error(`Ambiguous queue name: ${name}.`);
  if (!matches.length) return;
  if (!/^[a-f0-9]{32}$/.test(matches[0].queue_id ?? ''))
    throw new Error(`Invalid queue ID: ${name}.`);
  const { result } = await api(`/${matches[0].queue_id}`);
  if (result?.queue_name !== name || result.queue_id !== matches[0].queue_id) {
    throw new Error(`Queue readback identity mismatch: ${name}.`);
  }
  return result;
}

function verifyQueue(queue, name, plan) {
  if (
    queue.jurisdiction !== plan.jurisdiction ||
    queue.settings?.message_retention_period !== plan.message_retention_period
  ) {
    throw new Error(
      `Queue ${name} does not match the EU jurisdiction/retention policy; preserve it.`
    );
  }
  if (!Array.isArray(queue.consumers) || queue.consumers_total_count !== queue.consumers.length) {
    throw new Error(`Incomplete consumer metadata: ${name}.`);
  }
  if (name === plan.dlq) {
    if (queue.consumers.length) throw new Error(`DLQ ${name} must have no consumer.`);
  } else if (
    queue.consumers.length > 1 ||
    queue.consumers.some(consumer => {
      if (!consumer || typeof consumer !== 'object' || Array.isArray(consumer)) return true;
      // Pinned Wrangler reads script/service; API examples also use script_name.
      const aliases = ['script', 'service', 'script_name'].filter(key =>
        Object.hasOwn(consumer, key)
      );
      return (
        consumer.type !== 'worker' ||
        aliases.length === 0 ||
        aliases.some(key => typeof consumer[key] !== 'string' || consumer[key] !== plan.worker) ||
        consumer.dead_letter_queue !== plan.dlq
      );
    })
  )
    throw new Error(`Unexpected consumer owner, type or DLQ: ${name}.`);
}

async function prepare(plan, api) {
  const names = [plan.dlq, plan.source];
  // Reject any incompatible existing member before creating the missing member.
  for (const name of names) {
    const queue = await findQueue(api, name);
    if (queue) verifyQueue(queue, name, plan);
  }
  for (const name of names) {
    // Recheck immediately before POST so a concurrent successful create is reused.
    let queue = await findQueue(api, name);
    if (!queue) {
      await api('', 'POST', {
        queue_name: name,
        jurisdiction: plan.jurisdiction,
        settings: { message_retention_period: plan.message_retention_period },
      });
      queue = await findQueue(api, name);
    }
    if (!queue)
      throw new Error(`Queue ${name} missing after creation; preserve resources and rerun.`);
    verifyQueue(queue, name, plan);
  }
}

export async function run(
  command,
  environment,
  { token = process.env.CLOUDFLARE_API_TOKEN, request = fetch } = {}
) {
  if (command !== 'prepare') throw new Error('Use prepare staging.');
  const plan = readPlan(environment);
  await prepare(plan, queueApi(plan.account, token, request));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Use prepare staging.');
    await run(process.argv[2], process.argv[3]);
    console.log('Staging queue preparation complete.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
