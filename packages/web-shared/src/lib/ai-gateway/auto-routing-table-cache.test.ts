import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as Cache from './auto-routing-table-cache';
import type * as AdminClient from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';

const mockGetBenchmarkRoutingTable = jest.fn<typeof AdminClient.getBenchmarkRoutingTable>();

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getBenchmarkRoutingTable: mockGetBenchmarkRoutingTable,
}));

let cache: typeof Cache;

beforeEach(async () => {
  // Each router's cache is module-level, so reload it for a clean state.
  jest.resetModules();
  mockGetBenchmarkRoutingTable.mockReset();
  cache = await import('./auto-routing-table-cache');
});

describe('getCachedRoutingTable', () => {
  it('passes the router and a timeout signal to the routing table fetch', async () => {
    mockGetBenchmarkRoutingTable.mockResolvedValue({
      status: 200,
      body: { table: null, publishedAt: null },
    });

    await expect(cache.getCachedRoutingTable('frontier')).resolves.toBeNull();

    expect(mockGetBenchmarkRoutingTable).toHaveBeenCalledTimes(1);
    expect(mockGetBenchmarkRoutingTable).toHaveBeenCalledWith('frontier', expect.any(AbortSignal));
    const signal = mockGetBenchmarkRoutingTable.mock.calls[0][1];
    expect(signal?.aborted).toBe(false);
  });

  it('resolves to null instead of throwing when the fetch times out', async () => {
    mockGetBenchmarkRoutingTable.mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError')
    );

    await expect(cache.getCachedRoutingTable('efficient')).resolves.toBeNull();
    expect(mockGetBenchmarkRoutingTable).toHaveBeenCalledWith('efficient', expect.any(AbortSignal));
  });
});
