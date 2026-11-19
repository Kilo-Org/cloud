import { afterEach, describe, expect, it, vi } from 'vitest';
import { TunnelDemand, type PreviewTunnelDemandResult } from './tunnel-demand.js';

afterEach(() => {
  vi.useRealTimers();
});

function demandWith(result: () => Promise<PreviewTunnelDemandResult>) {
  const request = vi.fn(result);
  return { request, demand: new TunnelDemand<string>({ request, waitMs: () => 1_000 }) };
}

describe('TunnelDemand', () => {
  it('asks once for parallel requests and gives each the tunnel', async () => {
    const { request, demand } = demandWith(async () => 'requested');
    const first = demand.wait();
    const second = demand.wait();
    await Promise.resolve();
    demand.connected('tunnel-1');
    expect(await first).toEqual({ ok: true, tunnel: 'tunnel-1' });
    expect(await second).toEqual({ ok: true, tunnel: 'tunnel-1' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(demand.waiting).toBe(false);
  });

  it.each(['not_ready', 'outdated'] as const)('ends the wait at once on %s', async result => {
    const { demand } = demandWith(async () => result);
    expect(await demand.wait()).toEqual({ ok: false, reason: result });
  });

  it('ends the wait as unavailable when the request fails', async () => {
    const { demand } = demandWith(async () => {
      throw new Error('rpc failed');
    });
    expect(await demand.wait()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('ends the wait as unavailable after the bound, then asks again', async () => {
    vi.useFakeTimers();
    const { request, demand } = demandWith(async () => 'requested');
    const waiting = demand.wait();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await waiting).toEqual({ ok: false, reason: 'unavailable' });
    void demand.wait();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('ignores a connect when nothing waits', () => {
    const { demand } = demandWith(async () => 'requested');
    demand.connected('tunnel-1');
    expect(demand.waiting).toBe(false);
  });
});
