import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { experimental_readRawConfig } from 'wrangler';

export const supportedEnvironments = ['staging', 'production'];

// Cloudflare's maximum queue message retention (14 days):
// https://developers.cloudflare.com/queues/configuration/configure-queues/#queue-configuration
export const DLQ_MESSAGE_RETENTION_SECONDS = 1_209_600;

// Cloudflare's default source retention (four days), far beyond the 21-delivery retry window.
export const SOURCE_MESSAGE_RETENTION_SECONDS = 345_600;

export async function prepareQueues(
  environment,
  { token = process.env.CLOUDFLARE_API_TOKEN, request = fetch } = {}
) {
  if (!supportedEnvironments.includes(environment))
    throw new Error('Queue preparation requires staging or production.');
  const { rawConfig: config } = experimental_readRawConfig({
    config: new URL('../wrangler.jsonc', import.meta.url).pathname,
  });
  const selected = environment === 'production' ? config : config.env?.staging;
  const suffix = environment === 'staging' ? '-staging' : '';
  const globalSource = `usage-ingest-processing${suffix}`;
  const globalDlq = `usage-ingest-processing-dlq${suffix}`;
  const euSource = `${globalSource}-eu`;
  const euDlq = `${globalDlq}-eu`;
  // The dedicated tagged pair carries Enkrypt usage and Exa fallback usage; its names and
  // bindings predate Exa joining it.
  const enkryptSource = `usage-ingest-enkrypt${suffix}-eu`;
  const enkryptDlq = `usage-ingest-enkrypt-dlq${suffix}-eu`;
  const worker = selected?.name;
  const producers = selected?.queues?.producers;
  const consumers = selected?.queues?.consumers;
  const configError = () =>
    new Error(`Expected matching ${environment} source/DLQ bindings and Worker name.`);
  if (!Array.isArray(producers) || !Array.isArray(consumers)) throw configError();

  // The declared topology selects which pairs are expected; exact membership then rejects
  // missing, extra, duplicate, malformed or mismatched entries in either list.
  const source = producers.find(p => p?.binding === 'USAGE_INGEST_QUEUE')?.queue;
  const eu = source === euSource;
  const hedged =
    producers.some(p => p?.binding === 'USAGE_INGEST_HEDGE_QUEUE') ||
    (eu && consumers.some(c => c?.queue === globalSource));
  const dlq = eu ? euDlq : globalDlq;
  const expectedProducers = [
    { binding: 'USAGE_INGEST_QUEUE', queue: eu ? euSource : globalSource },
    { binding: 'USAGE_INGEST_DLQ', queue: dlq },
    ...(hedged ? [{ binding: 'USAGE_INGEST_HEDGE_QUEUE', queue: globalSource }] : []),
    { binding: 'USAGE_INGEST_ENKRYPT_QUEUE', queue: enkryptSource },
    { binding: 'USAGE_INGEST_ENKRYPT_DLQ', queue: enkryptDlq },
  ];
  // This revision's tagged ingress publishes to the dedicated EU pair whenever its cutover switch
  // is on, and the pair's consumer must keep draining after the switch is turned off, so every
  // supported topology, including a global routing rollback, keeps it. Earlier revisions deploy
  // with their own copy of this helper.
  const expectedConsumers = [
    { queue: eu ? euSource : globalSource, dead_letter_queue: dlq },
    ...(hedged ? [{ queue: globalSource, dead_letter_queue: globalDlq }] : []),
    { queue: enkryptSource, dead_letter_queue: enkryptDlq },
  ];
  const sameMembers = (actual, expected, key) => {
    const keys = actual.map(key);
    return (
      new Set(keys).size === keys.length &&
      isDeepStrictEqual(keys.toSorted(), expected.map(key).toSorted())
    );
  };
  if (
    // The stall hedge targets the global pair, so it requires the EU shared pair.
    (hedged && !eu) ||
    // JSON keys keep field types, so an array or number never matches an expected string.
    !sameMembers(producers, expectedProducers, p => JSON.stringify([p?.binding, p?.queue])) ||
    !sameMembers(consumers, expectedConsumers, c =>
      JSON.stringify([c?.queue, c?.dead_letter_queue])
    ) ||
    worker !== `usage-ingest${suffix}` ||
    !/^[a-f0-9]{32}$/.test(config.account_id)
  )
    throw configError();
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
    } catch (error) {
      // Only the error name is printed: messages can quote request or response content.
      throw new Error(
        `Queue API request failed (${error?.name}); rerun preparation without deleting resources.`,
        { cause: error }
      );
    }
    if (!response.ok)
      throw new Error(`Queue API failed (HTTP ${response.status}); check CI token permissions.`);
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(
        `Queue API returned invalid JSON (HTTP ${response.status}, ${error?.name}).`,
        { cause: error }
      );
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
  // The stall hedge keeps the global pair attached as a second source with its own DLQ.
  const hedgeNames = hedged ? [globalDlq, globalSource] : [];
  const hedgeExisting = [];
  // Inspect every queue before creating any; then create/read back each DLQ first.
  for (const name of names) {
    const queue = await find(name);
    if (queue && eu) verify(queue, name);
    if (!queue && !eu) throw new Error(`Rollback queue ${name} is missing; preserve resources.`);
    existing.push(queue);
  }
  for (const name of hedgeNames) hedgeExisting.push(await find(name));
  // The dedicated Enkrypt pair is only ever created or retained, never detached. Its DLQ must
  // stay unconsumed so failed records remain visible, and its source must keep at least the
  // default retention so records outlive the retry budget.
  const enkryptNames = [enkryptDlq, enkryptSource];
  const verifyEnkrypt = (queue, name) => {
    verify(queue, name);
    if (name === enkryptDlq && (!Array.isArray(queue.consumers) || queue.consumers.length))
      throw new Error(`${name} has or may have a consumer; nothing detached, stop deployment.`);
    if (name === enkryptDlq && !Number.isFinite(queue.settings?.message_retention_period))
      throw new Error(`Cannot read ${name} message retention; stop deployment.`);
    const retention = queue.settings?.message_retention_period;
    if (
      name === enkryptSource &&
      (!Number.isFinite(retention) || retention < SOURCE_MESSAGE_RETENTION_SECONDS)
    )
      throw new Error(`Cannot confirm ${name} keeps four-day retention; stop deployment.`);
    // Get Queue may omit this optional boolean; omission is not proof of active delivery.
    if (
      name === enkryptSource &&
      Object.hasOwn(queue.settings, 'delivery_paused') &&
      queue.settings.delivery_paused !== false
    )
      throw new Error(`Cannot confirm ${name} delivery is unpaused; stop deployment.`);
  };
  const enkryptExisting = [];
  for (const name of enkryptNames) {
    const queue = await find(name);
    if (queue) verifyEnkrypt(queue, name);
    enkryptExisting.push(queue);
  }
  const verifyConsumer = async queue => {
    if (!queue) return;
    if (!Array.isArray(queue.consumers) || queue.consumers.length > 1)
      throw new Error(`Cannot verify ${environment} consumer ownership.`);
    if (!queue.consumers.length) return;
    const consumer = queue.consumers[0];
    if (!consumer || typeof consumer !== 'object')
      throw new Error(`Cannot verify ${environment} consumer ownership.`);
    const owners = [consumer.script_name, consumer.script, consumer.service].filter(
      value => value !== undefined
    );
    if (
      consumer.type !== 'worker' ||
      !owners.length ||
      owners.some(owner => owner !== worker) ||
      !/^[a-f0-9]{32}$/.test(consumer.consumer_id)
    )
      throw new Error(`${environment} consumer ownership mismatch; nothing detached.`);
    if (consumer.service) {
      const { result } = await api(`/workers/services/${worker}`);
      if (
        !result?.default_environment?.environment ||
        consumer.environment !== result.default_environment.environment
      )
        throw new Error(`${environment} consumer environment mismatch; nothing detached.`);
    }
    return consumer;
  };
  // Validate the selected slot before changing the old attachment.
  await verifyConsumer(existing[1]);
  if (hedged) await verifyConsumer(hedgeExisting[1]);
  await verifyConsumer(enkryptExisting[1]);
  const obsolete = hedged ? undefined : await find(eu ? globalSource : `${globalSource}-eu`);
  const consumer = await verifyConsumer(obsolete);
  // The API does not document whether PATCH keeps omitted settings, so resend them all.
  const retainDlqMessages = async (queue, name) => {
    const settings = queue.settings;
    if (!Number.isFinite(settings?.message_retention_period))
      throw new Error(`Cannot read ${name} message retention; stop deployment.`);
    if (settings.message_retention_period >= DLQ_MESSAGE_RETENTION_SECONDS) return;
    const expected = { ...settings, message_retention_period: DLQ_MESSAGE_RETENTION_SECONDS };
    await api(`/queues/${queue.queue_id}`, { settings: expected }, 'PATCH');
    const updated = await find(name);
    if (
      !updated ||
      updated.jurisdiction !== queue.jurisdiction ||
      Object.entries(expected).some(
        ([key, value]) => !isDeepStrictEqual(updated.settings?.[key], value)
      )
    )
      throw new Error(`${name} retention update was not confirmed; stop deployment.`);
  };
  for (const [index, name] of names.entries()) {
    let queue = existing[index];
    if (!queue) {
      await api('/queues', {
        queue_name: name,
        jurisdiction: 'eu',
        ...(name === dlq
          ? { settings: { message_retention_period: DLQ_MESSAGE_RETENTION_SECONDS } }
          : {}),
      });
      queue = await find(name);
      verify(queue, name);
      if (name === source) await verifyConsumer(queue);
    }
    if (name === dlq) await retainDlqMessages(queue, name);
  }
  for (const [index, name] of hedgeNames.entries()) {
    let queue = hedgeExisting[index];
    if (!queue) {
      await api('/queues', {
        queue_name: name,
        ...(name === globalDlq
          ? { settings: { message_retention_period: DLQ_MESSAGE_RETENTION_SECONDS } }
          : {}),
      });
      queue = await find(name);
      if (!queue) throw new Error(`Created queue ${name} was not read back; stop deployment.`);
      if (name === globalSource) await verifyConsumer(queue);
    }
    if (name === globalDlq) await retainDlqMessages(queue, name);
  }
  for (const [index, name] of enkryptNames.entries()) {
    let queue = enkryptExisting[index];
    if (!queue) {
      await api('/queues', {
        queue_name: name,
        jurisdiction: 'eu',
        ...(name === enkryptDlq
          ? { settings: { message_retention_period: DLQ_MESSAGE_RETENTION_SECONDS } }
          : {}),
      });
      queue = await find(name);
      verifyEnkrypt(queue, name);
      if (name === enkryptSource) await verifyConsumer(queue);
    }
    if (name === enkryptDlq) await retainDlqMessages(queue, name);
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
