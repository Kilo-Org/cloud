import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PrefetchedCloudSidebar as PrefetchedCloudSidebarComponent } from './PrefetchedCloudSidebar';

Object.assign(globalThis, { React });

const worktreeIds = Array.from(
  { length: 3 },
  (_, index) => `worktree_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
);
const mockList = jest.fn<() => Promise<{ cliSessions: unknown[] }>>();
const mockWorkspaces = jest.fn<() => Promise<unknown>>();
const mockPreferences = jest.fn<() => Promise<unknown>>();
const mockDetails =
  jest.fn<(input: { worktreeIds: string[]; organizationId?: string | null }) => Promise<unknown>>();

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/trpc/init', () => ({
  createTRPCContext: async () => ({}),
}));
jest.mock('@/routers/root-router', () => ({ rootRouter: {} }));
jest.mock('@trpc/tanstack-react-query', () => ({
  createTRPCOptionsProxy: () => ({
    cliSessionsV2: {
      list: {
        queryOptions: () => ({
          queryKey: ['list'],
          queryFn: () => mockList(),
        }),
      },
      listWorkspaces: {
        infiniteQueryOptions: () => ({
          queryKey: ['workspaces'],
          queryFn: () => mockWorkspaces(),
          initialPageParam: undefined,
        }),
      },
      worktreeDetails: {
        queryOptions: (input: { worktreeIds: string[] }) => ({
          queryKey: ['details', input],
          queryFn: () => mockDetails(input),
        }),
      },
    },
    cloudAgentSettings: {
      getWorkspaceOrder: {
        queryOptions: () => ({
          queryKey: ['preferences'],
          queryFn: () => mockPreferences(),
        }),
      },
    },
    workspaceFolders: {
      list: {
        queryOptions: () => ({
          queryKey: ['folders'],
          queryFn: async () => ({ folders: [] }),
        }),
      },
    },
  }),
}));

let PrefetchedCloudSidebar: typeof PrefetchedCloudSidebarComponent;

beforeAll(async () => {
  ({ PrefetchedCloudSidebar } = await import('./PrefetchedCloudSidebar'));
});

const scope = {
  userId: 'oauth/test',
  organizationId: null,
  updatedSince: '2026-10-20T00:00:00.000Z',
  preferences: null,
  children: null,
};

function session(index: number) {
  return {
    cloud_agent_worktree_id: worktreeIds[index],
    cloud_agent_session_id: null,
    associatedPr: null,
    session_id: `ses_${index}`,
  };
}

describe('sidebar server prefetch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockList.mockReset();
    mockWorkspaces.mockReset();
    mockPreferences.mockReset();
    mockDetails.mockReset();
    mockList.mockResolvedValue({ cliSessions: [session(0), session(1), session(2)] });
    mockWorkspaces.mockResolvedValue({
      workspaces: [],
      nextCursor: null,
      truncated: false,
    });
    mockPreferences.mockResolvedValue({ workspaceOrder: 'manual' });
    mockDetails.mockResolvedValue({ worktrees: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('prefetches the workspace rows and preferences alongside the chat list', async () => {
    const page = PrefetchedCloudSidebar(scope);
    await jest.advanceTimersByTimeAsync(100);
    await page;

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockWorkspaces).toHaveBeenCalledTimes(1);
    expect(mockPreferences).toHaveBeenCalledTimes(1);
    expect(mockDetails).toHaveBeenCalledWith({ worktreeIds, organizationId: null });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns at the deadline without starting worktree details', async () => {
    mockList.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1600));
      return { cliSessions: [session(0)] };
    });

    const page = PrefetchedCloudSidebar(scope);
    await jest.advanceTimersByTimeAsync(1500);
    await page;

    expect(mockDetails).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(200);
    expect(jest.getTimerCount()).toBe(0);
  });
});
