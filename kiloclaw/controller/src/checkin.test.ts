import { describe, expect, it } from 'vitest';
import { parseNetDevText } from './checkin';

describe('parseNetDevText', () => {
  it('prefers eth0 when present', () => {
    const raw = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  lo: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0
eth0: 3000 10 0 0 0 0 0 0 4000 12 0 0 0 0 0 0
`;

    expect(parseNetDevText(raw)).toEqual({ bytesIn: 3000, bytesOut: 4000 });
  });

  it('falls back to summing non-loopback interfaces when eth0 is absent', () => {
    const raw = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  lo: 50 1 0 0 0 0 0 0 60 1 0 0 0 0 0 0
ens5: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
eth1: 300 3 0 0 0 0 0 0 700 7 0 0 0 0 0 0
`;

    expect(parseNetDevText(raw)).toEqual({ bytesIn: 1300, bytesOut: 2700 });
  });
});
