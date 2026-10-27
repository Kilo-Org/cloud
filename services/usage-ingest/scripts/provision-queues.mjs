import { pathToFileURL } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';

export async function prepareQueues(
  environment,
  { token = process.env.CLOUDFLARE_API_TOKEN, request = fetch } = {}
) {
  if (environment !== 'staging') throw new Error('Queue preparation supports staging only.');
  const { rawConfig: config } = experimental_readRawConfig({
    config: new URL('../wrangler.jsonc', import.meta.url).pathname,
  });
  const queues = config.env?.staging?.queues;
  const source = queues?.producers?.find(p => p.binding === 'USAGE_INGEST_QUEUE')?.queue;
  const dlq = queues?.producers?.find(p => p.binding === 'USAGE_INGEST_DLQ')?.queue;
  const eu = source === 'usage-ingest-processing-staging-eu';
  const worker = config.env?.staging?.name;
  if (
    source !== (eu ? 'usage-ingest-processing-staging-eu' : 'usage-ingest-processing-staging') ||
    dlq !==
      (eu ? 'usage-ingest-processing-dlq-staging-eu' : 'usage-ingest-processing-dlq-staging') ||
    worker !== 'usage-ingest-staging' ||
    queues.producers.length !== 2 ||
    queues.consumers?.length !== 1 ||
    queues.consumers[0].queue !== source ||
    queues.consumers[0].dead_letter_queue !== dlq ||
    !/^[a-f0-9]{32}$/.test(config.account_id)
  ) {
    throw new Error('Expected matching staging source/DLQ bindings and Worker name.');
  }
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required.');
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    let response, data;
    try {
      response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${config.account_id}${path}`,
        {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }
      );
    } catch {
      throw new Error('Queue API request failed; rerun preparation without deleting resources.');
    }
    if (!response.ok)
      throw new Error(`Queue API failed (HTTP ${response.status}); check CI token permissions.`);
    try {
      data = await response.json();
    } catch {
      throw new Error(`Queue API returned invalid JSON (HTTP ${response.status}).`);
    }
    if (data?.success !== true) throw new Error(`Queue API failed (HTTP ${response.status}).`);
    return data;
  };
  const find = async name => {
    const matches = [];
    for (let page = 1; page <= 100; page++) {
      const { result, result_info } = await api(
        `/queues?name=${encodeURIComponent(name)}&page=${page}`
      );
      if (!Array.isArray(result)) throw new Error('Invalid queue lookup response.');
      matches.push(...result.filter(queue => queue?.queue_name === name));
      const pages = result_info?.total_pages;
      if (page === 1 && pages === 0 && result.length === 0) break;
      if (!Number.isInteger(pages) || pages < page || pages > 100)
        throw new Error('Incomplete queue lookup.');
      if (page === pages) break;
    }
    if (matches.length > 1) throw new Error(`Ambiguous queue name: ${name}.`);
    if (!matches.length) return;
    const id = matches[0].queue_id;
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error(`Invalid queue ID: ${name}.`);
    const { result } = await api(`/queues/${id}`);
    if (result?.queue_name !== name || result.queue_id !== id)
      throw new Error(`Queue identity mismatch: ${name}.`);
    return result;
  };
  const names = [dlq, source];
  const existing = [];
  const verify = (queue, name) => {
    if (queue?.jurisdiction !== 'eu')
      throw new Error(`Queue ${name} is not verified EU; preserve it.`);
  };
  // Inspect both before creating either; then create/read back the DLQ first.
  for (const name of names) {
    const queue = await find(name);
    if (queue && eu) verify(queue, name);
    if (!queue && !eu) throw new Error(`Rollback queue ${name} is missing; preserve resources.`);
    existing.push(queue);
  }
  const obsolete = await find(
    eu ? 'usage-ingest-processing-staging' : 'usage-ingest-processing-staging-eu'
  );
  const consumers = obsolete?.consumers ?? (obsolete ? undefined : []);
  if (!Array.isArray(consumers) || consumers.length > 1)
    throw new Error('Cannot verify obsolete staging consumer ownership.');
  const consumer = consumers[0];
  if (consumer) {
    const owners = [consumer.script_name, consumer.script, consumer.service].filter(
      value => value !== undefined
    );
    if (
      consumer.type !== 'worker' ||
      !owners.length ||
      owners.some(owner => owner !== worker) ||
      !/^[a-f0-9]{32}$/.test(consumer.consumer_id)
    )
      throw new Error('Obsolete staging consumer ownership mismatch; nothing detached.');
    if (consumer.service) {
      const { result } = await api(`/workers/services/${worker}`);
      if (
        !result?.default_environment?.environment ||
        consumer.environment !== result.default_environment.environment
      )
        throw new Error('Obsolete staging consumer environment mismatch; nothing detached.');
    }
  }
  for (const [index, name] of names.entries()) {
    if (!existing[index]) {
      await api('/queues', { queue_name: name, jurisdiction: 'eu' });
      verify(await find(name), name);
    }
  }
  // Traffic must already be paused/drained. This detaches, never deletes a queue.
  if (consumer) {
    await api(
      `/queues/${obsolete.queue_id}/consumers/${consumer.consumer_id}`,
      undefined,
      'DELETE'
    );
    const detached = await find(obsolete.queue_name);
    if (!Array.isArray(detached?.consumers) || detached.consumers.length)
      throw new Error('Obsolete consumer detachment was not confirmed; stop deployment.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareQueues(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
