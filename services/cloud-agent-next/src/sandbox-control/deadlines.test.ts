import { describe, expect, it } from 'vitest';
import { DEADLINE_MS, leaseAtLeastMs } from './deadlines.js';

describe('deadlines', () => {
  it('derives leaseAtLeastMs from idle-stop plus margin', () => {
    expect(leaseAtLeastMs()).toBe(DEADLINE_MS.idleStop + DEADLINE_MS.idleStopLeaseMargin);
  });
});
