import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PrefetchedCloudSidebar as PrefetchedCloudSidebarComponent } from './PrefetchedCloudSidebar';

Object.assign(globalThis, { React });

const worktreeIds = Array.from(
  { length: 20 },
  (_, index) => `worktree_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
);
const mockList = jest.fn<(input: { worktreeId?: string }) => Promise<{ cliSessions: [] }>>();

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/trpc/init', () => ({
  createTRPCContext: async () => ({}),
}));
jest.mock('@/routers/root-router', () => ({ rootRouter: {} }));
jest.mock('@trpc/tanstack-react-query', () => ({
  createTRPCOptionsProxy: () => ({
    cliSessionsV2: {
      list: {
        queryOptions: (input: { worktreeId?: string }) => ({
          queryKey: ['list', input],
          queryFn: () => mockList(input),
        }),
      },
    },
    workspaceFolders: {
      list: {
        queryOptions: () => ({
          queryKey: ['folders', {}],
          queryFn: async () => ({ folders: [{ worktreeIds }] }),
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

describe('sidebar server prefetch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockList.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs at most four folder queries at once', async () => {
    let active = 0;
    let peak = 0;
    mockList.mockImplementation(async input => {
      if (input.worktreeId) {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
      }
      return { cliSessions: [] };
    });

    const page = PrefetchedCloudSidebar(scope);
    await jest.advanceTimersByTimeAsync(100);
    await page;

    expect(peak).toBe(4);
    expect(mockList.mock.calls.filter(([input]) => input.worktreeId)).toHaveLength(20);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns at the deadline and never starts queued queries afterwards', async () => {
    mockList.mockImplementation(async input => {
      if (input.worktreeId) await new Promise(resolve => setTimeout(resolve, 1600));
      return { cliSessions: [] };
    });

    const page = PrefetchedCloudSidebar(scope);
    await jest.advanceTimersByTimeAsync(1500);
    await page;
    expect(mockList.mock.calls.filter(([input]) => input.worktreeId)).toHaveLength(4);

    await jest.advanceTimersByTimeAsync(200);
    expect(mockList.mock.calls.filter(([input]) => input.worktreeId)).toHaveLength(4);
    expect(jest.getTimerCount()).toBe(0);
  });
});
