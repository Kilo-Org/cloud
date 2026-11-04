import { describe, expect, it } from 'vitest';
import { DEFAULT_BILLING_HEARTBEAT_SECONDS } from '@kilocode/container-usage';
import { billingHeartbeatSeconds } from './container-usage.js';

describe('billingHeartbeatSeconds', () => {
  it('uses a positive integer override and the production default otherwise', () => {
    expect(billingHeartbeatSeconds('60')).toBe(60);
    expect(billingHeartbeatSeconds(undefined)).toBe(DEFAULT_BILLING_HEARTBEAT_SECONDS);
    expect(billingHeartbeatSeconds('')).toBe(DEFAULT_BILLING_HEARTBEAT_SECONDS);
    expect(billingHeartbeatSeconds('0')).toBe(DEFAULT_BILLING_HEARTBEAT_SECONDS);
    expect(billingHeartbeatSeconds('-1')).toBe(DEFAULT_BILLING_HEARTBEAT_SECONDS);
    expect(billingHeartbeatSeconds('not-a-number')).toBe(DEFAULT_BILLING_HEARTBEAT_SECONDS);
  });
});
