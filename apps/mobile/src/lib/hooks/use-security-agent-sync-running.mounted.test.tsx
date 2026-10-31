// Mounted wiring tests for `useSecurityAgentSyncRunning`: both scope shapes stay
// mounted with `enabled` gating (no conditional hook call), the poll interval
// follows the run rather than the screen, and only an active sync command counts
// as a sync — a dismissal in flight is a different action.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSecurityAgentSyncRunning } from './use-security-agent-sync-running';

type QueryOptions = {
  queryKey?: unknown;
  enabled?: boolean;
  refetchInterval?: (query: { state: { data?: unknown } }) => unknown;
};

const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
}));

const trpcStub = {
  securityAgent: {
    listActiveCommands: {
      queryOptions: () => ({ queryKey: ['securityAgent', 'listActiveCommands'] }),
    },
  },
  organizations: {
    securityAgent: {
      listActiveCommands: {
        queryOptions: (input: { organizationId: string }) => ({
          queryKey: ['organizations', 'securityAgent', 'listActiveCommands', input],
        }),
      },
    },
  },
};

vi.mock('@/lib/trpc', () => ({ useTRPC: () => trpcStub }));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmd-1',
    commandType: 'sync',
    status: 'running',
    ...overrides,
  };
}

const useQueryOptions: QueryOptions[] = [];
const returned: { syncRunning?: boolean; updatedAt?: number } = {};

function isActiveCommandsKey(key: unknown, scope: 'personal' | 'org'): boolean {
  if (!Array.isArray(key)) {
    return false;
  }
  if (scope === 'personal') {
    return key[0] === 'securityAgent' && key[1] === 'listActiveCommands';
  }
  return (
    key[0] === 'organizations' && key[1] === 'securityAgent' && key[2] === 'listActiveCommands'
  );
}

function activeQueryOptions(scope: 'personal' | 'org'): QueryOptions | undefined {
  return useQueryOptions.findLast(options => isActiveCommandsKey(options.queryKey, scope));
}

let commandFixture: unknown[] | undefined = [];
let updatedAtFixture = 0;

function Probe({ scope, watching }: Readonly<{ scope: string; watching: boolean }>) {
  const state = useSecurityAgentSyncRunning(scope, watching);
  returned.syncRunning = state.syncRunning;
  returned.updatedAt = state.updatedAt;
  return null;
}

function mount(scope: string, watching: boolean): void {
  act(() => {
    TestRenderer.create(createElement(Probe, { scope, watching }));
  });
}

beforeEach(() => {
  useQueryOptions.length = 0;
  returned.syncRunning = undefined;
  returned.updatedAt = undefined;
  commandFixture = [];
  updatedAtFixture = 0;

  useQueryMock.mockImplementation((options: QueryOptions) => {
    useQueryOptions.push(options);
    return { data: commandFixture, dataUpdatedAt: updatedAtFixture };
  });
});

describe('useSecurityAgentSyncRunning (server view of a running sync)', () => {
  it('mounts both scope shapes and enables only the active one', () => {
    mount('personal', false);

    expect(activeQueryOptions('personal')?.enabled).toBe(true);
    expect(activeQueryOptions('org')?.enabled).toBe(false);

    useQueryOptions.length = 0;
    mount(ORG_ID, false);

    expect(activeQueryOptions('personal')?.enabled).toBe(false);
    expect(activeQueryOptions('org')?.enabled).toBe(true);
  });

  it('reports running only for an active sync command', () => {
    commandFixture = [makeCommand()];
    mount('personal', false);
    expect(returned.syncRunning).toBe(true);

    commandFixture = [makeCommand({ status: 'succeeded' })];
    mount('personal', false);
    expect(returned.syncRunning).toBe(false);

    // A dismissal in flight is queued work, not a sync: the control must not
    // claim a running sync because of it.
    commandFixture = [makeCommand({ commandType: 'dismiss_finding', status: 'accepted' })];
    mount('personal', false);
    expect(returned.syncRunning).toBe(false);
  });

  it('polls while watching even with no command listed, and stops once idle', () => {
    mount('personal', true);
    const watching = activeQueryOptions('personal');
    expect(watching?.refetchInterval?.({ state: { data: [] } })).toBe(3000);
    expect(watching?.refetchInterval?.({ state: { data: undefined } })).toBe(3000);

    useQueryOptions.length = 0;
    mount('personal', false);
    const idle = activeQueryOptions('personal');
    expect(idle?.refetchInterval?.({ state: { data: [] } })).toBe(false);
    // A run already listed keeps the poll alive on its own.
    expect(idle?.refetchInterval?.({ state: { data: [makeCommand()] } })).toBe(3000);
    expect(idle?.refetchInterval?.({ state: { data: [makeCommand({ status: 'failed' })] } })).toBe(
      false
    );
  });

  it('exposes the last read timestamp so a caller can tell a fresh answer from a cached one', () => {
    updatedAtFixture = 1234;
    commandFixture = [makeCommand({ status: 'failed' })];
    mount('personal', false);
    expect(returned.updatedAt).toBe(1234);
  });
});
