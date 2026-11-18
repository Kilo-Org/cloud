import React from 'react';
import { QueryClient, hydrate } from '@tanstack/react-query';
import { PrefetchedCloudSidebar } from './PrefetchedCloudSidebar';

Object.assign(globalThis, { React });
const mockList = jest.fn<Promise<unknown>, [unknown]>();
const mockWorkspaces = jest.fn<Promise<unknown>, [unknown]>();
const mockDetails = jest.fn();
const mockPreferences = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/trpc/init', () => ({ createTRPCContext: async () => ({}) }));
jest.mock('@/routers/root-router', () => ({ rootRouter: {} }));
jest.mock('@trpc/tanstack-react-query', () => ({
  createTRPCOptionsProxy: () => ({
    cliSessionsV2: {
      list: {
        queryOptions: (input: unknown) => ({ queryKey: ['list'], queryFn: () => mockList(input) }),
      },
      listWorkspaces: {
        infiniteQueryOptions: (input: unknown) => ({
          queryKey: ['workspaces'],
          initialPageParam: undefined,
          queryFn: () => mockWorkspaces(input),
        }),
      },
      worktreeDetails: { queryOptions: mockDetails },
    },
    cloudAgentSettings: { getWorkspaceOrder: { queryOptions: mockPreferences } },
    workspaceFolders: {
      list: {
        queryOptions: () => ({ queryKey: ['folders'], queryFn: async () => ({ folders: [] }) }),
      },
    },
  }),
}));

const scope = {
  userId: 'synthetic-user',
  organizationId: null,
  updatedSince: '2026-11-01T00:00:00.000Z',
  preferences: null,
  children: null,
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockList.mockResolvedValue({ cliSessions: [] });
  mockWorkspaces.mockResolvedValue({
    workspaces: [
      {
        worktreeId: 'worktree_synthetic',
        openChatCount: 0,
        closedChatCount: 1,
      },
    ],
    workspaceOrder: 'manual',
    nextCursor: null,
    truncated: false,
    destinationTotals: {},
  });
});
afterEach(() => jest.useRealTimers());

it('hydrates workspace counts and standalone sessions without details or a separate order request', async () => {
  const page = await PrefetchedCloudSidebar(scope);
  const client = new QueryClient();
  hydrate(client, page.props.state);
  expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ standaloneOnly: true }));
  expect(client.getQueryData(['workspaces'])).toMatchObject({
    pages: [{ workspaces: [{ openChatCount: 0, closedChatCount: 1 }] }],
  });
  expect(client.getQueryData(['list'])).toEqual({ cliSessions: [] });
  expect(mockDetails).not.toHaveBeenCalled();
  expect(mockPreferences).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  client.clear();
});

it('keeps sibling prefetch results when workspace summaries fail', async () => {
  mockWorkspaces.mockRejectedValue(new Error('Workspace list unavailable'));
  const page = await PrefetchedCloudSidebar(scope);
  const client = new QueryClient();
  hydrate(client, page.props.state);
  expect(client.getQueryData(['list'])).toEqual({ cliSessions: [] });
  expect(mockDetails).not.toHaveBeenCalled();
  client.clear();
});

it('returns at the deadline without adding per-workspace requests', async () => {
  mockWorkspaces.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 1_600));
    return { workspaces: [] };
  });
  const promise = PrefetchedCloudSidebar(scope);
  await jest.advanceTimersByTimeAsync(1_500);
  await promise;
  expect(mockDetails).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(100);
  expect(jest.getTimerCount()).toBe(0);
});
