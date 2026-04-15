import { describe, expect, jest, test } from '@jest/globals';
import { getClawDiskUsageQueryOptions } from './useClawHooks';

describe('getClawDiskUsageQueryOptions', () => {
  test('routes disk usage to the personal query without an organization', () => {
    const trpc = createDiskUsageTrpc();

    const options = getClawDiskUsageQueryOptions(trpc, undefined, true);

    expect(trpc.kiloclaw.getDiskUsage.queryOptions).toHaveBeenCalledWith(undefined, {
      refetchInterval: 60_000,
    });
    expect(trpc.organizations.kiloclaw.getDiskUsage.queryOptions).toHaveBeenCalledWith(
      { organizationId: '' },
      { refetchInterval: 60_000 }
    );
    expect(options.active.queryKey).toEqual(['personalDiskUsage']);
    expect(options.personal.enabled).toBe(true);
    expect(options.org.enabled).toBe(false);
  });

  test('routes disk usage to the org query with the organization id', () => {
    const trpc = createDiskUsageTrpc();

    const options = getClawDiskUsageQueryOptions(trpc, 'org_123', true);

    expect(trpc.organizations.kiloclaw.getDiskUsage.queryOptions).toHaveBeenCalledWith(
      { organizationId: 'org_123' },
      { refetchInterval: 60_000 }
    );
    expect(options.active.queryKey).toEqual(['orgDiskUsage', 'org_123']);
    expect(options.personal.enabled).toBe(false);
    expect(options.org.enabled).toBe(true);
  });
});

type DiskUsageTrpc = Parameters<typeof getClawDiskUsageQueryOptions>[0];

function createDiskUsageTrpc() {
  const personalQueryOptions = jest.fn(
    (_input: undefined, options: { refetchInterval: number }) => ({
      queryKey: ['personalDiskUsage'] as const,
      ...options,
    })
  );
  const orgQueryOptions = jest.fn(
    (input: { organizationId: string }, options: { refetchInterval: number }) => ({
      queryKey: ['orgDiskUsage', input.organizationId] as const,
      ...options,
    })
  );

  return {
    kiloclaw: { getDiskUsage: { queryOptions: personalQueryOptions } },
    organizations: { kiloclaw: { getDiskUsage: { queryOptions: orgQueryOptions } } },
  } as unknown as DiskUsageTrpc;
}
