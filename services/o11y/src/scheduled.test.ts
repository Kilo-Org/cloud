import { describe, expect, it, vi } from 'vitest';
import { runScheduledJobs } from './scheduled';

describe('runScheduledJobs', () => {
  it('runs the summary and rethrows an alerting failure', async () => {
    const order: string[] = [];
    const failure = new Error('alerting down');

    await expect(
      runScheduledJobs(
        async () => {
          order.push('alerts');
          throw failure;
        },
        async () => {
          order.push('summary');
        }
      )
    ).rejects.toBe(failure);

    expect(order).toEqual(['alerts', 'summary']);
  });

  it('runs both when alerting succeeds', async () => {
    const summary = vi.fn(async () => {});
    await runScheduledJobs(async () => {}, summary);
    expect(summary).toHaveBeenCalledTimes(1);
  });
});
