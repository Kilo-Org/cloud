import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./postgres', () => ({
  reconcileStaleIntervals: vi.fn(),
}));

import { reconcileStaleIntervals } from './postgres';
import { runReconciliation } from './reconciliation';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runReconciliation', () => {
  it('logs completed runs and unconfirmed closes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(reconcileStaleIntervals).mockResolvedValue(3);

    await runReconciliation({} as Cloudflare.Env);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('"outcome":"completed"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"reconciledIntervals":3'));
  });

  it('logs and propagates failed runs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(reconcileStaleIntervals).mockRejectedValue(new Error('postgres unavailable'));

    await expect(runReconciliation({} as Cloudflare.Env)).rejects.toThrow('postgres unavailable');

    expect(error).toHaveBeenCalledWith(expect.stringContaining('"outcome":"failed"'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"errorName":"Error"'));
  });
});
