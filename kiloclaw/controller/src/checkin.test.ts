import { describe, expect, it } from 'vitest';
import {
  nextProductTelemetryDeadline,
  parseDfOutput,
  parseNetDevText,
  PRODUCT_TELEMETRY_INTERVAL_MS,
  PRODUCT_TELEMETRY_JITTER_MS,
} from './checkin';

describe('nextProductTelemetryDeadline', () => {
  const now = 1_000_000;

  it('returns ~24h in the future with default random', () => {
    const deadline = nextProductTelemetryDeadline(now);
    const minExpected = now + PRODUCT_TELEMETRY_INTERVAL_MS - PRODUCT_TELEMETRY_JITTER_MS;
    const maxExpected = now + PRODUCT_TELEMETRY_INTERVAL_MS + PRODUCT_TELEMETRY_JITTER_MS;
    expect(deadline).toBeGreaterThanOrEqual(minExpected);
    expect(deadline).toBeLessThanOrEqual(maxExpected);
  });

  it('applies negative jitter when randomFn returns 0', () => {
    const deadline = nextProductTelemetryDeadline(now, () => 0);
    expect(deadline).toBe(now + PRODUCT_TELEMETRY_INTERVAL_MS - PRODUCT_TELEMETRY_JITTER_MS);
  });

  it('applies zero jitter when randomFn returns 0.5', () => {
    const deadline = nextProductTelemetryDeadline(now, () => 0.5);
    expect(deadline).toBe(now + PRODUCT_TELEMETRY_INTERVAL_MS);
  });

  it('applies positive jitter when randomFn returns 1', () => {
    const deadline = nextProductTelemetryDeadline(now, () => 1);
    expect(deadline).toBe(now + PRODUCT_TELEMETRY_INTERVAL_MS + PRODUCT_TELEMETRY_JITTER_MS);
  });
});

describe('parseDfOutput', () => {
  it('parses valid df -B1 --output=avail,size output and derives used from total - avail', () => {
    // avail=5368709120, size=10737418240 → used=5368709120
    const raw = `     Avail 1B-blocks
5368709120 10737418240`;
    expect(parseDfOutput(raw)).toEqual({ usedBytes: 5368709120, totalBytes: 10737418240 });
  });

  it('returns null when the data line does not match the expected format', () => {
    expect(parseDfOutput('Avail 1B-blocks\nnot-numbers here')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parseDfOutput('')).toBeNull();
  });

  it('returns null for output with only a header and no data line', () => {
    expect(parseDfOutput('     Avail 1B-blocks')).toBeNull();
  });

  it('clamps usedBytes to 0 when avail > total', () => {
    // Some filesystems with compression can report avail > size
    const raw = `     Avail 1B-blocks
10737418240 5368709120`;
    expect(parseDfOutput(raw)).toEqual({ usedBytes: 0, totalBytes: 5368709120 });
  });
});

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
