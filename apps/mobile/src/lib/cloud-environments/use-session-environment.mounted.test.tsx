import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestRenderer } from '@/test/renderer';
import { createTestQueryClient } from '@/test/render-with-providers';
import { QueryClientProvider } from '@tanstack/react-query';
import { type EnvironmentSummaryRow } from '@/lib/cloud-environments/environment-selection';

import { useSessionEnvironment } from './use-session-environment';

vi.mock('react-native', () => ({ Text: 'Text' }));

const ENVIRONMENT: EnvironmentSummaryRow = {
  id: 'env-1',
  name: 'Mobile parity lab',
  createdAt: '2026-01-01 00:00:00+00',
  updatedAt: '2026-01-01 00:00:00+00',
  plainVarCount: 0,
  secretCount: 0,
  commandCount: 1,
  configurationRevision: 1,
  sandboxAllocation: null,
  repositories: [{ platform: 'github', repoFullName: 'picker-lab/private-repo' }],
};

const KEY = 'personal|github|picker-lab/private-repo';
const REPOSITORY = {
  platform: 'github',
  fullName: 'picker-lab/private-repo',
  isPrivate: true,
} as const;

const state = vi.hoisted(() => ({
  stored: {} as Record<string, string>,
  forget: vi.fn<(key: string) => void>(),
  /** The environments the list answers with; `null` keeps the answer pending. */
  environments: null as EnvironmentSummaryRow[] | null,
}));

vi.mock('@/lib/hooks/environment-choice', () => ({
  usePersistedEnvironmentChoice: () => ({ stored: state.stored, saveEnvironmentChoice: vi.fn() }),
  forgetEnvironmentChoice: state.forget,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cloudEnvironments: {
      list: {
        queryOptions: (input: unknown, options: { enabled: boolean }) => {
          const queryKey = ['cloudEnvironments', 'list', input];
          const listed = state.environments;
          if (listed === null) {
            return {
              queryKey,
              queryFn: () => new Promise<EnvironmentSummaryRow[]>(() => {}),
              enabled: options.enabled,
            };
          }
          return {
            queryKey,
            queryFn: () => Promise.resolve(listed),
            initialData: listed,
            enabled: options.enabled,
          };
        },
      },
      buildStatus: {
        queryOptions: (input: unknown) => ({
          queryKey: ['cloudEnvironments', 'buildStatus', input],
          queryFn: () => Promise.resolve(undefined),
        }),
      },
    },
  }),
}));

function SessionEnvironmentProbe() {
  useSessionEnvironment({ organizationId: undefined, repository: REPOSITORY });
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  state.stored = {};
  state.forget.mockClear();
  state.environments = null;
});

function mountProbe() {
  const element = (
    <QueryClientProvider client={createTestQueryClient()}>
      <SessionEnvironmentProbe />
    </QueryClientProvider>
  );
  TestRenderer.act(() => {
    renderer = TestRenderer.create(element);
  });
}

describe('useSessionEnvironment stored choice', () => {
  it('drops a stored pick whose environment is no longer listed', () => {
    state.stored = { [KEY]: 'env-gone' };
    state.environments = [ENVIRONMENT];

    mountProbe();

    expect(state.forget).toHaveBeenCalledTimes(1);
    expect(state.forget).toHaveBeenCalledWith(KEY);
  });

  it('keeps a stored pick the list still offers', () => {
    state.stored = { [KEY]: ENVIRONMENT.id };
    state.environments = [ENVIRONMENT];

    mountProbe();

    expect(state.forget).not.toHaveBeenCalled();
  });

  it('keeps the pick while the list has not answered', () => {
    state.stored = { [KEY]: 'env-gone' };

    mountProbe();

    expect(state.forget).not.toHaveBeenCalled();
  });
});
