import { unstable_readConfig } from 'wrangler';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { usageRetryDelaySeconds } from './retry-policy';

it.each([
  [1, 1, 2, 60, 120],
  [6, 32, 64, 60, 120],
  [9, 256, 512, 256, 512],
  [10, 300, 600, 300, 600],
  [20, 300, 600, 300, 600],
  [21, 300, 600, 300, 600],
])(
  'uses bounded integer jitter at native attempt %s',
  (attempt, admissionMin, admissionMax, otherMin, otherMax) => {
    expect(usageRetryDelaySeconds(attempt, true, () => 0)).toBe(admissionMin);
    expect(usageRetryDelaySeconds(attempt, true, () => 1 - Number.EPSILON)).toBe(admissionMax);
    expect(usageRetryDelaySeconds(attempt, false, () => 0)).toBe(otherMin);
    expect(usageRetryDelaySeconds(attempt, false, () => 1 - Number.EPSILON)).toBe(otherMax);
  }
);

it.each([undefined, null, '20', 0, -1, 1.5, NaN, Infinity, Number.MAX_VALUE])(
  'uses initial attempt for invalid metadata %s',
  attempts => {
    expect(usageRetryDelaySeconds(attempts, true, () => 0)).toBe(1);
    expect(usageRetryDelaySeconds(attempts, false, () => 0)).toBe(60);
  }
);

it('clamps large safe attempts before exponentiation and never resets count when classification changes', () => {
  expect(usageRetryDelaySeconds(Number.MAX_SAFE_INTEGER, true, () => 0.5)).toBe(450);
  expect(usageRetryDelaySeconds(9, false, () => 0)).toBe(256);
  expect(usageRetryDelaySeconds(10, true, () => 0)).toBe(300);
});

it.each([undefined, 'staging'])(
  'commits20 native retries without changing capacity/default delay (%s)',
  env => {
    const config = unstable_readConfig({
      config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
      ...(env ? { env } : {}),
    });
    expect(config.queues.consumers).toEqual([
      expect.objectContaining({
        max_retries: 20,
        retry_delay: 60,
        max_concurrency: 200,
        max_batch_timeout: 0,
        max_batch_size: env === 'staging' ? 2 : 6,
        queue:
          env === 'staging' ? 'usage-ingest-processing-staging-eu' : 'usage-ingest-processing-eu',
        dead_letter_queue:
          env === 'staging'
            ? 'usage-ingest-processing-dlq-staging-eu'
            : 'usage-ingest-processing-dlq-eu',
      }),
    ]);
    expect(config.vars.USAGE_INGEST_PARALLELISM).toBe(env === 'staging' ? '2' : '3');
  }
);
