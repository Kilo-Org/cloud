import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestRenderer } from '@/test/renderer';

import { SessionSandboxSection } from './session-sandbox-section';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn<() => void>(), dialog: null }),
}));
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn<() => void>(), success: vi.fn<() => void>() },
}));

type CapturedQueryOptions = {
  queryKey: readonly unknown[];
  refetchInterval?: (query: { state: { data?: unknown } }) => number | false;
};

const captured = vi.hoisted(() => ({ queries: [] as CapturedQueryOptions[] }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: CapturedQueryOptions) => {
    captured.queries.push(options);
    return {
      data: undefined,
      isError: false,
      isFetching: false,
      isSuccess: false,
      refetch: vi.fn<() => void>(),
    };
  },
  useMutation: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn<() => Promise<void>>() }),
}));

vi.mock('@/lib/trpc', () => {
  const queries = {
    getSandboxStatus: {
      queryOptions: (input: unknown, options: CapturedQueryOptions): CapturedQueryOptions => ({
        ...options,
        queryKey: ['getSandboxStatus', input],
      }),
    },
    getWorkspaceSnapshotRecovery: {
      queryOptions: (input: unknown, options: CapturedQueryOptions): CapturedQueryOptions => ({
        ...options,
        queryKey: ['getWorkspaceSnapshotRecovery', input],
      }),
      queryKey: () => ['getWorkspaceSnapshotRecovery'],
    },
  };
  return {
    useTRPC: () => ({ cloudAgentNext: queries, organizations: { cloudAgentNext: queries } }),
    trpcClient: {
      cloudAgentNext: { removeWorkspaceSnapshot: { mutate: () => Promise.resolve({}) } },
      organizations: {
        cloudAgentNext: { removeWorkspaceSnapshot: { mutate: () => Promise.resolve({}) } },
      },
    },
  };
});

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  captured.queries.length = 0;
});

function renderSection(organizationId: string | undefined) {
  const element = (
    <SessionSandboxSection
      cloudAgentSessionId="workspace_session"
      organizationId={organizationId}
      startFailed={false}
    />
  );
  TestRenderer.act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  const sandboxQuery = captured.queries.find(options => options.queryKey[0] === 'getSandboxStatus');
  if (!sandboxQuery?.refetchInterval) {
    throw new Error('the sandbox read did not register a polling interval');
  }
  return sandboxQuery.refetchInterval;
}

describe('SessionSandboxSection polling', () => {
  it('polls while the sandbox can still change', () => {
    const interval = renderSection(undefined);

    for (const status of ['active', 'starting', 'stopping', 'unreachable', 'unknown'] as const) {
      expect(interval({ state: { data: { status } } })).toBe(15_000);
    }
  });

  it('stops polling once the status settles', () => {
    const interval = renderSection(undefined);

    for (const status of ['sleeping', 'error'] as const) {
      expect(interval({ state: { data: { status } } })).toBe(false);
    }
  });

  it('polls before the first answer arrives', () => {
    const interval = renderSection(undefined);

    expect(interval({ state: {} })).toBe(15_000);
  });

  it('applies the same rule to the organization-scoped read', () => {
    const interval = renderSection('org-a');

    expect(interval({ state: { data: { status: 'active' } } })).toBe(15_000);
    expect(interval({ state: { data: { status: 'error' } } })).toBe(false);
  });
});
