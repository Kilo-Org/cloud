/* eslint-disable promise/prefer-await-to-callbacks -- exercises competing native idle and timer deliveries */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scheduleCacheMaintenance } from './schedule-cache-maintenance';

let idleCallback: (() => void) | undefined = undefined;

function becomeIdle(): void {
  if (!idleCallback) {
    throw new Error('No idle maintenance is queued');
  }
  idleCallback();
}

describe('scheduleCacheMaintenance', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    idleCallback = undefined;
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idleCallback = callback;
      return 1;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('completes maintenance at the deadline and ignores a late idle delivery', async () => {
    let invalidations = 0;
    scheduleCacheMaintenance(() => {
      invalidations += 1;
    });

    await vi.advanceTimersToNextTimerAsync();
    expect(invalidations).toBe(1);

    becomeIdle();
    expect(invalidations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('completes maintenance while idle and releases the deadline', async () => {
    let invalidations = 0;
    scheduleCacheMaintenance(() => {
      invalidations += 1;
    });

    becomeIdle();
    expect(invalidations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.runAllTimersAsync();
    expect(invalidations).toBe(1);
  });
});
