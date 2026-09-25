import type * as ReactQuery from '@tanstack/react-query';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearUserSessionTitles,
  namedSessionTitle,
} from '@/components/agents/session-detail-rename-state';
import {
  makeTestQueryClient,
  seedMutationSessions,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';
import { useSessionMutations } from './use-session-mutations';

type Input = { session_id: string; title?: string };
type MutationOptions = ReactQuery.MutationOptions<unknown, Error, Input>;
let client = makeTestQueryClient();
const rpc = { rename: vi.fn(), delete: vi.fn() };
let renameMutationFn: MutationOptions['mutationFn'] = rpc.rename;
const messages: string[] = [];
const settled: (() => void)[] = [];
const listKey = [['cliSessionsV2', 'list'], { type: 'infinite' }] as const;
const activeFilter = { queryKey: [['activeSessions', 'list']] };

// Execute the real rename mutation so the hook's optimistic write and its
// recording of the user's title both run.
vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQueryClient: () => client,
    useMutation: (options: MutationOptions) => {
      const owner = client;
      return {
        mutateAsync: async (input: Input) => {
          const result = await owner.getMutationCache().build(owner, options).execute(input);
          return result;
        },
      };
    },
  };
});
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      list: { infiniteQueryKey: () => listKey },
      rename: {
        mutationOptions: (options: MutationOptions) => ({
          ...options,
          mutationFn: renameMutationFn,
        }),
      },
      delete: {
        mutationOptions: (options: MutationOptions) => ({ ...options, mutationFn: rpc.delete }),
      },
    },
    activeSessions: { list: { pathFilter: () => activeFilter } },
  }),
}));
vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries: async (owner: ReactQuery.QueryClient) => {
    await owner.invalidateQueries();
  },
}));
vi.mock('@/lib/query/schedule-cache-maintenance', () => ({
  scheduleCacheMaintenance: (run: () => void) => {
    settled.push(run);
  },
}));
vi.mock('@/lib/a11y/announcing-toast', () => {
  const record = (message: string) => {
    messages.push(message);
  };
  return { announcingToast: { error: record, success: record } };
});

afterAll(
  setTrpcUnauthorizedHandler(() => {
    setSignOutActive(true);
  })
);
beforeEach(() => {
  setSignOutActive(false);
  client = makeTestQueryClient();
  renameMutationFn = rpc.rename.mockReset().mockResolvedValue(undefined);
  rpc.delete.mockReset().mockResolvedValue(undefined);
  messages.length = 0;
  settled.length = 0;
  seedMutationSessions(client, listKey);
});
afterEach(() => {
  client.clear();
  setSignOutActive(false);
  clearUserSessionTitles();
});

describe('useSessionMutations user rename titles', () => {
  it('does not hide a user-chosen title that matches the backend placeholder', async () => {
    // The rename API accepts any nonblank title, so the user may pick one that
    // matches the backend's placeholder shape. The rename records it, so the
    // header and rows show it instead of the localized unnamed label.
    const chosen = 'New session - 2026-09-22T02:05:22.778Z';
    await useSessionMutations().renameSessionAsync('s1', chosen);
    expect(namedSessionTitle(chosen, 's1')).toBe(chosen);
    expect(namedSessionTitle(chosen, 's2')).toBeUndefined();
  });
});
