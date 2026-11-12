import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrMaintenance } from './PrMaintenance';

Object.assign(globalThis, { React });

type MutationOptions = { mutationKey: string[]; onError?: (error: Error) => Promise<void> | void };
const mockWatchRefetch = jest.fn(async () => ({ data: null }));
const mockOptionsRefetch = jest.fn(async () => ({ data: null }));
const mockUseMutation = jest.fn((_options: MutationOptions) => ({
  mutate: jest.fn(),
  isPending: false,
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      getPrWatchOptions: { queryOptions: () => ({ queryKey: ['options'] }) },
      getWatchPr: { queryOptions: () => ({ queryKey: ['watch'] }) },
      ...Object.fromEntries(
        ['enable', 'pause', 'resume', 'stop', 'recheck'].map(action => [
          `${action}WatchPr`,
          { mutationOptions: () => ({ mutationKey: [action] }) },
        ])
      ),
    },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useMutation: (options: MutationOptions) => mockUseMutation(options),
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === 'options'
      ? {
          data: {
            canEnable: false,
            unavailableReason: null,
            executionSettings: { environment: null, profile: null },
          },
          refetch: mockOptionsRefetch,
          isPending: false,
        }
      : { data: null, refetch: mockWatchRefetch, isPending: false },
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

it('refreshes current enable options as well as watch state after an enable error', async () => {
  renderToStaticMarkup(
    createElement(PrMaintenance, {
      sessionId: 'ses_example',
      pr: {
        url: 'https://github.com/example/repository/pull/123',
        number: 123,
        state: 'open',
        title: 'Example',
        headSha: null,
        lastSyncedAt: '2026-11-12T12:00:00.000Z',
        reviewDecision: null,
        reviewDecisionPending: false,
        platform: 'github',
        observations: null,
      },
    })
  );
  const enable = mockUseMutation.mock.calls.find(
    ([options]) => options.mutationKey[0] === 'enable'
  )?.[0];
  if (!enable?.onError) throw new Error('Missing actual enable error handler');
  await enable.onError(new Error('Workspace settings changed'));
  expect(mockWatchRefetch).toHaveBeenCalledTimes(1);
  expect(mockOptionsRefetch).toHaveBeenCalledTimes(1);
});
