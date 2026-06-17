import { describe, expect, jest, test } from '@jest/globals';
import { TRPCClientError } from '@trpc/client';

import type { AgentConfigListResponse } from '@/lib/kiloclaw/types';
import {
  getClawDiskUsageQueryOptions,
  isAmbiguousAgentMutationError,
  reconcileAmbiguousMutation,
} from './useClawHooks';

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

// Construct a TRPCClientError the way the client surfaces each failure class.
// `upstreamCode` mirrors the controller code the router attaches via
// UpstreamApiError (exposed as data.upstreamCode by the error formatter).
function clientError(code: string | undefined, upstreamCode?: string): unknown {
  if (code === undefined) {
    // A raw transport failure (plain-text edge 504, dropped connection) has no
    // JSON body, so TRPCClientError.from leaves `.data` undefined.
    return TRPCClientError.from(new Error('error code: 504'));
  }
  // A server-originated tRPC error always carries data.code via the formatter.
  return new TRPCClientError('boom', {
    result: {
      error: { code: -32600, message: 'boom', data: { code, upstreamCode, httpStatus: 409 } },
    },
  } as never);
}

function listWith(ids: string[]): AgentConfigListResponse {
  return { etag: 'e', defaults: {}, agents: ids.map(id => ({ id })) } as never;
}

describe('isAmbiguousAgentMutationError', () => {
  test('treats a transport failure with no data.code as ambiguous (the timeout case)', () => {
    expect(isAmbiguousAgentMutationError(clientError(undefined))).toBe(true);
  });

  test('treats an explicit timeout as ambiguous', () => {
    expect(isAmbiguousAgentMutationError(clientError('TIMEOUT'))).toBe(true);
  });

  test('treats a bare INTERNAL_SERVER_ERROR (no upstream code) as ambiguous', () => {
    // An edge/worker 504 with a JSON body but no controller code — may have applied.
    expect(isAmbiguousAgentMutationError(clientError('INTERNAL_SERVER_ERROR'))).toBe(true);
  });

  test('treats INTERNAL_SERVER_ERROR with a genuine timeout upstream code as ambiguous', () => {
    expect(
      isAmbiguousAgentMutationError(clientError('INTERNAL_SERVER_ERROR', 'openclaw_cli_timeout'))
    ).toBe(true);
  });

  test('treats INTERNAL_SERVER_ERROR with an explicit failure upstream code as NOT ambiguous', () => {
    // The CLI reported failure / rollback failed — must never reconcile to success.
    expect(
      isAmbiguousAgentMutationError(clientError('INTERNAL_SERVER_ERROR', 'openclaw_cli_failed'))
    ).toBe(false);
    expect(
      isAmbiguousAgentMutationError(
        clientError('INTERNAL_SERVER_ERROR', 'agent_binding_rollback_failed')
      )
    ).toBe(false);
  });

  test('treats deterministic typed errors as NOT ambiguous', () => {
    expect(isAmbiguousAgentMutationError(clientError('CONFLICT'))).toBe(false);
    expect(isAmbiguousAgentMutationError(clientError('BAD_REQUEST'))).toBe(false);
    expect(isAmbiguousAgentMutationError(clientError('NOT_FOUND'))).toBe(false);
  });

  test('treats a non-tRPC error as ambiguous', () => {
    expect(isAmbiguousAgentMutationError(new Error('network'))).toBe(true);
  });
});

describe('reconcileAmbiguousMutation', () => {
  test('refetches on an ambiguous error and returns whether the end state holds', async () => {
    const refetch = jest.fn(async () => listWith(['agent2']));
    const applied = await reconcileAmbiguousMutation(clientError(undefined), refetch, list =>
      list.agents.some(a => a.id === 'agent2')
    );
    expect(applied).toBe(true);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('does NOT refetch a deterministic error (never a false reconcile)', async () => {
    const refetch = jest.fn(async () => listWith([]));
    const applied = await reconcileAmbiguousMutation(clientError('CONFLICT'), refetch, () => true);
    expect(applied).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
  });

  test('returns false when the intended end state does not hold', async () => {
    const refetch = jest.fn(async () => listWith(['other']));
    const applied = await reconcileAmbiguousMutation(clientError(undefined), refetch, list =>
      list.agents.some(a => a.id === 'agent2')
    );
    expect(applied).toBe(false);
  });

  test('returns false when the refetch itself fails', async () => {
    const refetch = jest.fn(async (): Promise<AgentConfigListResponse> => {
      throw new Error('refetch failed');
    });
    const applied = await reconcileAmbiguousMutation(clientError(undefined), refetch, () => true);
    expect(applied).toBe(false);
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
