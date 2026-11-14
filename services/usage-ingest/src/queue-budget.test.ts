import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

it('bounds production EU processing to 450 direct Frankfurt writer calls, 500 with the hedge consumer', () => {
  const production = unstable_readConfig({ config });
  expect(production.services).toEqual([]);
  expect(production.queues.producers).toEqual([
    { binding: 'USAGE_INGEST_QUEUE', queue: 'usage-ingest-processing-eu' },
    { binding: 'USAGE_INGEST_DLQ', queue: 'usage-ingest-processing-dlq-eu' },
    { binding: 'USAGE_INGEST_HEDGE_QUEUE', queue: 'usage-ingest-processing' },
  ]);
  expect(production.vars.USAGE_WRITER_URL).toBe('https://app.kilo.ai/api/internal/usage/record');
  expect(production.vars.USAGE_INGEST_PARALLELISM).toBe('2');
  expect(production.vars.USAGE_INGEST_HEDGE_MODE).toBe('off');
  expect(production.vars.USAGE_INGEST_HEDGE_DELAY_MS).toBe('1000');
  expect(production.vars.USAGE_INGEST_HEDGE_PERCENT).toBe('50');
  expect(production.vars).not.toHaveProperty('USAGE_INGEST_DIAGNOSTICS');
  expect(production.vars.USAGE_WRITER_SECRET).toBeUndefined();
  expect(production.queues.consumers).toEqual([
    {
      queue: 'usage-ingest-processing-eu',
      max_batch_size: 6,
      max_batch_timeout: 0,
      max_concurrency: 225,
      max_retries: 20,
      retry_delay: 60,
      dead_letter_queue: 'usage-ingest-processing-dlq-eu',
    },
    {
      queue: 'usage-ingest-processing',
      max_batch_size: 6,
      max_batch_timeout: 0,
      max_concurrency: 25,
      max_retries: 20,
      retry_delay: 60,
      dead_letter_queue: 'usage-ingest-processing-dlq',
    },
  ]);
  const [main, hedge] = production.queues.consumers;
  if (typeof main?.max_concurrency !== 'number' || typeof hedge?.max_concurrency !== 'number')
    throw new Error('Missing production queue cap');
  const parallelism = Number(production.vars.USAGE_INGEST_PARALLELISM);
  expect(main.max_concurrency * parallelism).toBe(450);
  expect((main.max_concurrency + hedge.max_concurrency) * parallelism).toBe(500);
});

it('keeps staging on one EU queue plus the hedge queue with at most 450 concurrent writer calls', () => {
  const staging = unstable_readConfig({ config, env: 'staging' });
  expect(staging.services).toEqual([]);
  expect(staging.vars.USAGE_WRITER_URL).toBe(
    'https://staging-app.kilo.ai/api/internal/usage/record'
  );
  expect(staging.queues.producers).toEqual([
    { binding: 'USAGE_INGEST_QUEUE', queue: 'usage-ingest-processing-staging-eu' },
    { binding: 'USAGE_INGEST_DLQ', queue: 'usage-ingest-processing-dlq-staging-eu' },
    { binding: 'USAGE_INGEST_HEDGE_QUEUE', queue: 'usage-ingest-processing-staging' },
  ]);
  expect(staging.vars.USAGE_INGEST_PARALLELISM).toBe('2');
  expect(staging.vars.USAGE_INGEST_HEDGE_MODE).toBe('on');
  expect(staging.vars.USAGE_INGEST_HEDGE_DELAY_MS).toBe('1000');
  expect(staging.vars.USAGE_INGEST_HEDGE_PERCENT).toBe('100');
  expect(staging.vars).not.toHaveProperty('USAGE_INGEST_DIAGNOSTICS');
  expect(staging.queues.consumers).toMatchObject([
    {
      queue: 'usage-ingest-processing-staging-eu',
      dead_letter_queue: 'usage-ingest-processing-dlq-staging-eu',
      max_concurrency: 200,
    },
    {
      queue: 'usage-ingest-processing-staging',
      dead_letter_queue: 'usage-ingest-processing-dlq-staging',
      max_concurrency: 25,
    },
  ]);
  expect(staging.queues.consumers).toHaveLength(2);
  let writerBudget = 0;
  for (const consumer of staging.queues.consumers) {
    // Keep the deployed queue policy explicit; the parallelism flag does not change batching.
    expect(consumer.max_batch_size).toBe(2);
    expect(consumer.max_batch_timeout).toBe(0);
    expect(consumer.max_retries).toBe(20);
    expect(consumer.retry_delay).toBe(60);
    expect(Number.isInteger(consumer.max_concurrency)).toBe(true);
    if (typeof consumer.max_concurrency !== 'number') throw new Error('Missing queue cap');
    writerBudget += consumer.max_concurrency * 2;
  }
  expect(writerBudget).toBe(450);
});
