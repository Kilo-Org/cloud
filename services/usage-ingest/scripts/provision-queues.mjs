import { pathToFileURL } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';

export async function prepareQueues(
  environment,
  { token = process.env.CLOUDFLARE_API_TOKEN, request = fetch } = {}
) {
  if (environment !== 'staging') throw new Error('EU queue preparation supports staging only.');
  const { rawConfig: config } = experimental_readRawConfig({
    config: new URL('../wrangler.jsonc', import.meta.url).pathname,
  });
  const queues = config.env?.staging?.queues;
  const source = queues?.producers?.find(p => p.binding === 'USAGE_INGEST_QUEUE')?.queue;
  const dlq = queues?.producers?.find(p => p.binding === 'USAGE_INGEST_DLQ')?.queue;
  if (
    source !== 'usage-ingest-processing-staging-eu' ||
    dlq !== 'usage-ingest-processing-dlq-staging-eu' ||
    queues.producers.length !== 2 ||
    queues.consumers?.length !== 1 ||
    queues.consumers[0].queue !== source ||
    queues.consumers[0].dead_letter_queue !== dlq ||
    !/^[a-f0-9]{32}$/.test(config.account_id)
  ) {
    throw new Error('Expected matching staging source/DLQ bindings and EU jurisdiction.');
  }
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required.');
  const api = async (path, body) => {
    let response, data;
    try {
      response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/queues${path}`,
        {
          method: body ? 'POST' : 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }
      );
      data = await response.json();
    } catch {
      throw new Error('Queue API request failed; rerun preparation without deleting resources.');
    }
    if (!response.ok || data?.success !== true)
      throw new Error(`Queue API failed (HTTP ${response.status}).`);
    return data;
  };
  const find = async name => {
    const matches = [];
    for (let page = 1; page <= 100; page++) {
      const { result, result_info } = await api(`?name=${encodeURIComponent(name)}&page=${page}`);
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
    const { result } = await api(`/${id}`);
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
    if (queue) verify(queue, name);
    existing.push(queue);
  }
  for (const [index, name] of names.entries()) {
    if (!existing[index]) {
      await api('', { queue_name: name, jurisdiction: 'eu' });
      verify(await find(name), name);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareQueues(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
