/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// P1-G-51b mounted wiring tests for `useSecurityAgentCommands`: both batch
// query shapes stay mounted unconditionally with `enabled` gating, the batch
// carries the first 100 ids with the overflow going to per-command queries,
// the batch keeps React Query's reconnect/mount refetch defaults, and the
// old-server fallback engages only on the procedure-missing signature.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetBatchProcedureAvailabilityForTests,
  useSecurityAgentCommands,
} from './use-security-agent-commands';

type QueryOptions = {
  queryKey?: unknown;
  enabled?: boolean;
  refetchInterval?: (query: { state: { data?: unknown } }) => unknown;
  refetchOnReconnect?: unknown;
  refetchOnMount?: unknown;
};

const useQueryMock = vi.hoisted(() => vi.fn());
const useQueriesMock = vi.hoisted(() => vi.fn());
const queryClientMock = vi.hoisted(() => ({
  getQueryData: vi.fn(() => []),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
  useQueries: useQueriesMock,
  useQueryClient: () => queryClientMock,
}));

const trpcStub = {
  securityAgent: {
    listActiveCommands: {
      queryOptions: () => ({ queryKey: ['securityAgent', 'listActiveCommands'] }),
    },
    getCommandStatus: {
      queryOptions: (input: { commandId: string }) => ({
        queryKey: ['securityAgent', 'getCommandStatus', input],
      }),
    },
    getCommandStatuses: {
      queryOptions: (input: { commandIds: string[] }) => ({
        queryKey: ['securityAgent', 'getCommandStatuses', input],
      }),
    },
  },
  organizations: {
    securityAgent: {
      listActiveCommands: {
        queryOptions: (input: { organizationId: string }) => ({
          queryKey: ['organizations', 'securityAgent', 'listActiveCommands', input],
        }),
      },
      getCommandStatus: {
        queryOptions: (input: { organizationId: string; commandId: string }) => ({
          queryKey: ['organizations', 'securityAgent', 'getCommandStatus', input],
        }),
      },
      getCommandStatuses: {
        queryOptions: (input: { organizationId: string; commandIds: string[] }) => ({
          queryKey: ['organizations', 'securityAgent', 'getCommandStatuses', input],
        }),
      },
    },
  },
};

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => trpcStub,
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
}));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let trackedIdsFixture: string[] = [];
let batchErrorFixture: unknown = null;
const useQueryOptions: QueryOptions[] = [];
const useQueriesOptions: { queries: QueryOptions[] }[] = [];

function makeIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `id-${i}`);
}

function isTrackedIdsKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === 'security-agent-command-ids';
}

function isBatchKey(key: unknown, scope: 'personal' | 'org'): boolean {
  if (!Array.isArray(key)) {
    return false;
  }
  if (scope === 'personal') {
    return key[0] === 'securityAgent' && key[1] === 'getCommandStatuses';
  }
  return (
    key[0] === 'organizations' && key[1] === 'securityAgent' && key[2] === 'getCommandStatuses'
  );
}

function batchQueryOptions(scope: 'personal' | 'org'): QueryOptions | undefined {
  const matches = useQueryOptions.filter(opts => isBatchKey(opts.queryKey, scope));
  return matches.at(-1);
}

function Probe({ scope }: Readonly<{ scope: string }>) {
  useSecurityAgentCommands(scope);
  return null;
}

function mount(scope: string): void {
  act(() => {
    TestRenderer.create(createElement(Probe, { scope }));
  });
}

beforeEach(() => {
  _resetBatchProcedureAvailabilityForTests();
  trackedIdsFixture = [];
  batchErrorFixture = null;
  useQueryOptions.length = 0;
  useQueriesOptions.length = 0;
  queryClientMock.getQueryData.mockReturnValue([]);
  queryClientMock.setQueryData.mockClear();
  queryClientMock.invalidateQueries.mockClear();

  useQueryMock.mockImplementation((options: QueryOptions) => {
    useQueryOptions.push(options);
    const key = options.queryKey;
    if (isTrackedIdsKey(key)) {
      return {
        data: trackedIdsFixture,
        error: null,
        isError: false,
        state: { data: trackedIdsFixture },
      };
    }
    if (isBatchKey(key, 'personal') || isBatchKey(key, 'org')) {
      return {
        data: undefined,
        error: batchErrorFixture,
        isError: batchErrorFixture !== null,
        state: { data: undefined },
      };
    }
    return { data: undefined, error: null, isError: false, state: { data: undefined } };
  });

  useQueriesMock.mockImplementation((options: { queries: QueryOptions[] }) => {
    useQueriesOptions.push(options);
    return options.queries.map(() => ({
      data: undefined,
      error: null,
      isError: false,
      state: { data: undefined },
    }));
  });
});

describe('useSecurityAgentCommands (batch observer wiring)', () => {
  it('mounts both batch query shapes with enabled gating (no conditional hook call)', () => {
    trackedIdsFixture = makeIds(3);
    mount('personal');

    expect(batchQueryOptions('personal')?.enabled).toBe(true);
    expect(batchQueryOptions('org')?.enabled).toBe(false);
  });

  it('enables the organization batch shape for an org scope', () => {
    trackedIdsFixture = makeIds(2);
    mount(ORG_ID);

    expect(batchQueryOptions('personal')?.enabled).toBe(false);
    expect(batchQueryOptions('org')?.enabled).toBe(true);
  });

  it('keeps React Query reconnect/mount refetch defaults on the batch query', () => {
    trackedIdsFixture = makeIds(2);
    mount('personal');

    const batch = batchQueryOptions('personal');
    expect(batch?.refetchOnReconnect).not.toBe(false);
    expect(batch?.refetchOnMount).not.toBe(false);
  });

  it('polls the batch only while a returned command is active', () => {
    trackedIdsFixture = makeIds(1);
    mount('personal');

    const refetchInterval = batchQueryOptions('personal')?.refetchInterval;
    expect(refetchInterval?.({ state: { data: [] } })).toBe(false);
    expect(refetchInterval?.({ state: { data: undefined } })).toBe(false);
    expect(refetchInterval?.({ state: { data: [{ status: 'accepted' }] } })).toBe(3000);
  });

  it('sends 100 ids to the batch and the overflow to per-command queries', () => {
    trackedIdsFixture = makeIds(150);
    mount('personal');

    const batch = batchQueryOptions('personal');
    const batchKey = batch?.queryKey as [string, string, { commandIds: string[] }];
    expect(batchKey[2].commandIds).toHaveLength(100);

    const lastQueries = useQueriesOptions.at(-1);
    expect(lastQueries?.queries).toHaveLength(50);
  });

  it('disables the batch and runs no per-command queries with no tracked ids', () => {
    trackedIdsFixture = [];
    mount('personal');

    expect(batchQueryOptions('personal')?.enabled).toBe(false);
    const lastQueries = useQueriesOptions.at(-1);
    expect(lastQueries?.queries).toHaveLength(0);
  });

  it('engages the per-command fallback only on the procedure-missing signature', () => {
    trackedIdsFixture = makeIds(3);
    batchErrorFixture = {
      message: 'No "query"-procedure on path "securityAgent.getCommandStatuses"',
      data: { code: 'NOT_FOUND' },
    };
    mount('personal');

    // The fallback effect flushes inside the mount act: the batch disables and
    // the per-command queries cover every tracked id.
    expect(batchQueryOptions('personal')?.enabled).toBe(false);
    const lastQueries = useQueriesOptions.at(-1);
    expect(lastQueries?.queries).toHaveLength(3);
  });

  it('does not engage the fallback on a bare NOT_FOUND', () => {
    trackedIdsFixture = makeIds(3);
    batchErrorFixture = {
      message: 'Security Agent command not found',
      data: { code: 'NOT_FOUND' },
    };
    mount('personal');

    expect(batchQueryOptions('personal')?.enabled).toBe(true);
    const lastQueries = useQueriesOptions.at(-1);
    expect(lastQueries?.queries).toHaveLength(0);
  });
});
