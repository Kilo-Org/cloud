import { describe, expect, it } from 'vitest';
import { createPairingConsumption } from './pairing-consumption';

describe('pairing consumption', () => {
  it('forgets a fragment after the TTL', () => {
    let current = 1000;
    const consumption = createPairingConsumption({ now: () => current, ttlMs: 5000 });

    consumption.add('hub|key|ws');
    expect(consumption.has('hub|key|ws')).toBe(true);

    current = 5999;
    expect(consumption.has('hub|key|ws')).toBe(true);

    current = 6000;
    expect(consumption.has('hub|key|ws')).toBe(false);
  });

  it('keeps at most the configured number of entries, oldest first', () => {
    const current = 0;
    const consumption = createPairingConsumption({ maxEntries: 2, now: () => current });

    consumption.add('a');
    consumption.add('b');
    consumption.add('c');

    expect(consumption.has('a')).toBe(false);
    expect(consumption.has('b')).toBe(true);
    expect(consumption.has('c')).toBe(true);
  });

  it('re-adding a fragment refreshes its recency', () => {
    const current = 0;
    const consumption = createPairingConsumption({ maxEntries: 2, now: () => current });

    consumption.add('a');
    consumption.add('b');
    consumption.add('a');
    consumption.add('c');

    expect(consumption.has('a')).toBe(true);
    expect(consumption.has('b')).toBe(false);
    expect(consumption.has('c')).toBe(true);
  });
});
