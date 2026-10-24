import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

it('keeps production receipt-only with its original queue policy', () => {
  const production = unstable_readConfig({ config });
  expect(production.vars.USAGE_INGEST_MODE).toBe('receipt');
  expect(production.vars.USAGE_INGEST_PARALLELISM).toBeUndefined();
  expect(production.queues.consumers).toEqual([
    {
      queue: 'usage-ingest-processing',
      max_batch_size: 1,
      max_batch_timeout: 0,
      max_concurrency: 1,
      max_retries: 3,
      retry_delay: 60,
      dead_letter_queue: 'usage-ingest-processing-dlq',
    },
  ]);
});

it('bounds aggregate staging writer concurrency across every configured queue to 200', () => {
  const staging = unstable_readConfig({ config, env: 'staging' });
  expect(staging.vars.USAGE_INGEST_MODE).toBe('processing');
  expect(staging.vars.USAGE_INGEST_PARALLELISM).toBe('2');
  expect(staging.queues.consumers.length).toBeGreaterThan(0);
  let writerBudget = 0;
  for (const consumer of staging.queues.consumers) {
    // A newly composed queue must have an explicit finite cap and the same batch policy.
    expect(consumer.max_batch_size).toBe(2);
    expect(consumer.max_batch_timeout).toBe(0);
    expect(consumer.max_retries).toBe(3);
    expect(consumer.retry_delay).toBe(60);
    expect(Number.isInteger(consumer.max_concurrency)).toBe(true);
    expect(consumer.max_concurrency).toBeGreaterThan(0);
    if (typeof consumer.max_concurrency !== 'number') throw new Error('Missing queue cap');
    writerBudget += consumer.max_concurrency * 2;
  }
  // EU composition must use legacy 1 + EU 99, rather than retaining EU 199.
  expect(writerBudget).toBeLessThanOrEqual(200);
});
