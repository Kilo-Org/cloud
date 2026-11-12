import { unstable_readConfig } from 'wrangler';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { usageRetryDelaySeconds } from './retry-policy';

it.each([
  [1, 1, 4, 60, 120],
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
        max_concurrency: env === 'staging' ? 200 : 225,
        max_batch_timeout: 0,
        max_batch_size: env === 'staging' ? 2 : 3,
        queue:
          env === 'staging' ? 'usage-ingest-processing-staging-eu' : 'usage-ingest-processing-eu',
        dead_letter_queue:
          env === 'staging'
            ? 'usage-ingest-processing-dlq-staging-eu'
            : 'usage-ingest-processing-dlq-eu',
      }),
    ]);
    expect(config.vars.USAGE_INGEST_PARALLELISM).toBe('2');
  }
);

it.each([
  [0, 1],
  [0.25 - Number.EPSILON, 1],
  [0.25, 2],
  [0.5 - Number.EPSILON, 2],
  [0.5, 3],
  [0.75 - Number.EPSILON, 3],
  [0.75, 4],
  [1 - Number.EPSILON, 4],
])('spreads first admission retry at random %s into bucket %s', (value, expected) => {
  const random = vi.fn(() => value);
  expect(usageRetryDelaySeconds(1, true, random)).toBe(expected);
  expect(random).toHaveBeenCalledTimes(1);
});

it('preserves later attempts and conservative failures with one random draw', () => {
  for (const attempt of [1, 2, 3, 6, 9, 10, 20, 21, Number.MAX_SAFE_INTEGER]) {
    for (const admission of [true, false]) {
      if (attempt === 1 && admission) continue;
      const exponential = Math.min(300, 2 ** Math.min(attempt - 1, 9));
      const base = admission ? exponential : Math.max(60, exponential);
      for (const value of [0, 0.25, 0.5, 0.75, 1 - Number.EPSILON]) {
        const random = vi.fn(() => value);
        expect(usageRetryDelaySeconds(attempt, admission, random)).toBe(
          base + Math.floor(value * (base + 1))
        );
        expect(random).toHaveBeenCalledTimes(1);
      }
    }
  }
});

it.each([undefined, null, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_VALUE])(
  'uses all first admission buckets for invalid metadata %s',
  attempts => {
    for (const [value, expected] of [
      [0, 1],
      [0.25, 2],
      [0.5, 3],
      [0.75, 4],
    ]) {
      const random = vi.fn(() => value);
      expect(usageRetryDelaySeconds(attempts, true, random)).toBe(expected);
      expect(random).toHaveBeenCalledTimes(1);
      const conservativeRandom = vi.fn(() => value);
      expect(usageRetryDelaySeconds(attempts, false, conservativeRandom)).toBe(
        60 + Math.floor(value * 61)
      );
      expect(conservativeRandom).toHaveBeenCalledTimes(1);
    }
  }
);
