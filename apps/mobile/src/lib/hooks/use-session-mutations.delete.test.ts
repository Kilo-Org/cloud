import type * as ReactQuery from '@tanstack/react-query';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mutationActiveTitle as activeTitle,
  deferred,
  makeTestQueryClient,
  seedMutationSessions,
  mutationStoredTitles as titles,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { useSessionMutations } from './use-session-mutations';

// The delete outcomes of useSessionMutations. Account fencing and rename
// sequencing are covered in use-session-mutations.test.ts.

type Input = { session_id: string };
type MutationOptions = ReactQuery.MutationOptions<unknown, Error, Input>;
let client = makeTestQueryClient();
const deleteRpc = vi.fn();
const messages: string[] = [];
const listKey = [['cliSessionsV2', 'list'], { type: 'infinite' }] as const;

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return { ...actual, useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn };
});
vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQueryClient: () => client,
    useMutation: (options: MutationOptions) => ({
      mutateAsync: async (input: Input) => {
        const result = await client.getMutationCache().build(client, options).execute(input);
        return result;
      },
    }),
  };
});
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      list: { infiniteQueryKey: () => listKey },
      rename: { mutationOptions: (options: MutationOptions) => options },
      delete: {
        mutationOptions: (options: MutationOptions) => ({ ...options, mutationFn: deleteRpc }),
      },
    },
    activeSessions: { list: { pathFilter: () => ({ queryKey: [['activeSessions', 'list']] }) } },
  }),
}));
vi.mock('@/lib/query/schedule-cache-maintenance', () => ({ scheduleCacheMaintenance: vi.fn() }));
vi.mock('@/lib/a11y/announcing-toast', () => {
  const record = (message: string) => {
    messages.push(message);
  };
  return { announcingToast: { error: record, success: record } };
});

beforeEach(() => {
  setSignOutActive(false);
  client = makeTestQueryClient();
  deleteRpc.mockReset();
  messages.length = 0;
  seedMutationSessions(client, listKey);
});
afterEach(() => {
  client.clear();
});

describe('useSessionMutations deleteSession', () => {
  it('deletes only stored rows and moves focus after server confirmation', async () => {
    const request = deferred<undefined>();
    deleteRpc.mockReturnValue(request.promise);
    let focused = 'row';
    useSessionMutations().deleteSession('s1', () => {
      focused = 'list';
    });
    await vi.waitFor(() => {
      expect(titles(client, listKey)).toEqual(['Other']);
    });
    expect(activeTitle(client)).toBe('Old');
    expect(focused).toBe('row');
    request.resolve(undefined);
    await vi.waitFor(() => {
      expect(focused).toBe('list');
    });
    expect(messages).toEqual(['Session deleted']);
    expect(deleteRpc.mock.calls[0]?.[0]).toEqual({ session_id: 's1' });
  });

  it('treats a NOT_FOUND delete as an already deleted session', async () => {
    deleteRpc.mockRejectedValue(
      Object.assign(new Error('Session not found'), { data: { code: 'NOT_FOUND' } })
    );
    let focused = 'row';
    useSessionMutations().deleteSession('s1', () => {
      focused = 'list';
    });
    await vi.waitFor(() => {
      expect(focused).toBe('list');
    });
    expect(titles(client, listKey)).toEqual(['Other']);
    expect(messages).toEqual(['Session deleted']);
  });

  it('rolls back and reports a delete that fails for another reason', async () => {
    deleteRpc.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { data: { code: 'FORBIDDEN' } })
    );
    useSessionMutations().deleteSession('s1');
    await vi.waitFor(() => {
      expect(messages).toEqual(['Forbidden']);
    });
    expect(titles(client, listKey)).toEqual(['Old', 'Other']);
  });
});
