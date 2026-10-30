import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

it('bounds production EU processing to 600 direct Frankfurt writer calls', () => {
  const production = unstable_readConfig({ config });
  expect(production.services).toEqual([]);
  expect(production.queues.producers).toEqual([
    { binding: 'USAGE_INGEST_QUEUE', queue: 'usage-ingest-processing-eu' },
    { binding: 'USAGE_INGEST_DLQ', queue: 'usage-ingest-processing-dlq-eu' },
  ]);
  expect(production.vars.USAGE_WRITER_URL).toBe('https://app.kilo.ai/api/internal/usage/record');
  expect(production.vars.USAGE_INGEST_PARALLELISM).toBe('3');
  expect(production.vars.USAGE_INGEST_DIAGNOSTICS).toBeUndefined();
  expect(production.vars.USAGE_WRITER_SECRET).toBeUndefined();
  expect(production.queues.consumers).toEqual([
    {
      queue: 'usage-ingest-processing-eu',
      max_batch_size: 6,
      max_batch_timeout: 0,
      max_concurrency: 200,
      max_retries: 20,
      retry_delay: 60,
      dead_letter_queue: 'usage-ingest-processing-dlq-eu',
    },
  ]);
  const cap = production.queues.consumers[0].max_concurrency;
  if (typeof cap !== 'number') throw new Error('Missing production queue cap');
  expect(cap * Number(production.vars.USAGE_INGEST_PARALLELISM)).toBe(600);
});

it('keeps staging on one EU queue with at most 400 concurrent writer calls', () => {
  const staging = unstable_readConfig({ config, env: 'staging' });
  expect(staging.services).toEqual([]);
  expect(staging.vars.USAGE_WRITER_URL).toBe(
    'https://staging-app.kilo.ai/api/internal/usage/record'
  );
  expect(staging.queues.producers).toEqual([
    { binding: 'USAGE_INGEST_QUEUE', queue: 'usage-ingest-processing-staging-eu' },
    { binding: 'USAGE_INGEST_DLQ', queue: 'usage-ingest-processing-dlq-staging-eu' },
  ]);
  expect(staging.vars.USAGE_INGEST_PARALLELISM).toBe('2');
  expect(staging.vars.USAGE_INGEST_DIAGNOSTICS).toBe('all');
  expect(staging.queues.consumers).toHaveLength(1);
  expect(staging.queues.consumers[0].queue).toBe('usage-ingest-processing-staging-eu');
  let writerBudget = 0;
  for (const consumer of staging.queues.consumers) {
    // Keep the deployed queue policy explicit; the parallelism flag does not change batching.
    expect(consumer.max_batch_size).toBe(2);
    expect(consumer.max_batch_timeout).toBe(0);
    expect(consumer.max_retries).toBe(20);
    expect(consumer.retry_delay).toBe(60);
    expect(consumer.dead_letter_queue).toBe('usage-ingest-processing-dlq-staging-eu');
    expect(Number.isInteger(consumer.max_concurrency)).toBe(true);
    expect(consumer.max_concurrency).toBe(200);
    if (typeof consumer.max_concurrency !== 'number') throw new Error('Missing queue cap');
    writerBudget += consumer.max_concurrency * 2;
  }
  expect(writerBudget).toBeLessThanOrEqual(400);
});
