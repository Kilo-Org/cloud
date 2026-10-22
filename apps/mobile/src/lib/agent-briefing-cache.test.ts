import { type BriefingPreferences, type BriefingReport } from '@kilocode/app-shared/agent-briefing';
import { QueryClient } from '@tanstack/react-query';
import { persistQueryClientRestore } from '@tanstack/react-query-persist-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { purgeInaccessibleBriefingCache } from './agent-briefing-cache';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { createReadCachePersister, readCacheScope } from '@/lib/persist/read-cache';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (scope: string, key: string) => {
      await Promise.resolve();
      return values.get(`${scope}/${key}`) ?? null;
    }),
    setItem: vi.fn(async (scope: string, key: string, value: string) => {
      values.set(`${scope}/${key}`, value);
      await Promise.resolve();
    }),
    removeItem: vi.fn(async (scope: string, key: string) => {
      values.delete(`${scope}/${key}`);
      await Promise.resolve();
    }),
  };
});
vi.mock('@/lib/persist/encrypted-kv', () => storage);
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => {
    await Promise.resolve();
    return null;
  }),
  setItemAsync: vi.fn(async () => {
    await Promise.resolve();
  }),
  deleteItemAsync: vi.fn(async () => {
    await Promise.resolve();
  }),
}));

const userKey = [['user', 'getMe'], { type: 'query' }] as const;
const repositoriesKey = [['cliSessionsV2', 'recentRepositories'], { type: 'query' }] as const;
const listKey = [
  ['agentBriefing', 'list'],
  { type: 'query', input: { scope: 'all', currentOnly: true, limit: 30 } },
] as const;
const historyKey = [
  ['agentBriefing', 'list'],
  { type: 'infinite', input: { scope: 'all', currentOnly: false, limit: 30 } },
] as const;
const preferencesKey = [
  ['agentBriefing', 'preferences'],
  { type: 'query', input: { timezone: 'UTC' } },
] as const;
const deniedListKey = [
  ['agentBriefing', 'list'],
  {
    type: 'query',
    input: { scope: 'organization', organizationId: 'denied', currentOnly: true, limit: 1 },
  },
] as const;

function report(id: string, organizationId: string | null): BriefingReport {
  return {
    id,
    kind: 'scheduled',
    createdAt: '2026-10-15T08:00:00Z',
    timezone: 'UTC',
    context: {
      id: organizationId ?? 'personal',
      organizationId,
      name: organizationId ?? 'Personal',
    },
    localDate: '2026-10-15',
    nightStartAt: '2026-10-14T22:00:00Z',
    cutoffAt: '2026-10-15T08:00:00Z',
    morningEndAt: '2026-10-15T12:00:00Z',
    publishedAt: '2026-10-15T08:00:00Z',
    updatedAt: '2026-10-15T08:00:00Z',
    expiresAt: '2026-10-15T12:00:00Z',
    revision: 1,
    revised: false,
    readAt: null,
    dismissedAt: null,
    scorecard: { sessions: 1, pullRequests: 0, blockers: 0, spendMicrodollars: 100 },
    coverage: {
      activity: 'partial',
      pullRequests: 'partial',
      blockers: 'partial',
      spend: 'partial',
    },
    sessions: [],
    sources: [],
    summary: {
      status: 'ready',
      text: `${id}-private-summary`,
      model: 'model',
      costMicrodollars: 1,
      chargeStatus: 'settled',
      estimatedCostMicrodollars: 1,
      startedAt: '2026-10-15T08:00:00Z',
      finishedAt: '2026-10-15T08:01:00Z',
      error: null,
      canRetry: false,
    },
  };
}

function reportKey(reportId: string) {
  return [['agentBriefing', 'get'], { type: 'query', input: { reportId } }] as const;
}

function clientWithReports(reports: BriefingReport[]) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  client.setQueryData(userKey, { id: 'user-1' });
  client.setQueryData(repositoriesKey, [{ gitUrl: 'https://example.test/keep-this-repository' }]);
  client.setQueryData(listKey, { reports, nextCursor: null });
  client.setQueryData(historyKey, {
    pages: [{ reports, nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData<BriefingPreferences>(preferencesKey, {
    timezone: 'UTC',
    nightStart: '22:00',
    morningStart: '08:00',
    morningEnd: '12:00',
    language: 'en',
    notificationsEnabled: false,
    defaultModel: 'model',
    contexts: reports.map(item => ({
      context: item.context,
      aiEnabled: false,
      model: 'model',
      maxDurationSeconds: 600,
      maxSpendMicrodollars: 2_000_000,
    })),
  });
  for (const item of reports) {
    client.setQueryData(reportKey(item.id), item);
  }
  return client;
}

describe('scoped briefing cache access loss', () => {
  beforeEach(() => {
    storage.values.clear();
    vi.clearAllMocks();
    setSignOutActive(false);
  });

  it('preserves Personal, accessible organizations, and unrelated cached data through encrypted save and restore', async () => {
    const personal = report('personal-report', null);
    const allowed = report('allowed-report', 'allowed');
    const denied = report('denied-report', 'denied');
    const client = clientWithReports([personal, denied, allowed]);
    client.setQueryData(deniedListKey, { reports: [], nextCursor: null });
    await expect(
      purgeInaccessibleBriefingCache(client, { userId: 'user-1', authEpoch: currentAuthEpoch() }, [
        'allowed',
      ])
    ).resolves.toBe(true);
    expect(client.getQueryData(reportKey(denied.id))).toBeUndefined();
    expect(client.getQueryData(deniedListKey)).toBeUndefined();
    expect(client.getQueryData(listKey)).toEqual({
      reports: [personal, allowed],
      nextCursor: null,
    });
    expect(client.getQueryData(historyKey)).toEqual({
      pages: [{ reports: [personal, allowed], nextCursor: null }],
      pageParams: [undefined],
    });
    expect(
      client
        .getQueryData<BriefingPreferences>(preferencesKey)
        ?.contexts.map(item => item.context.organizationId)
    ).toEqual([null, 'allowed']);
    const persisted = storage.values.get(`${readCacheScope('user-1')}/read-cache`);
    expect(persisted).toBeDefined();
    expect(persisted).not.toContain('denied-report-private-summary');
    const restored = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    await persistQueryClientRestore({
      queryClient: restored,
      persister: createReadCachePersister({
        queryClient: restored,
        userId: 'user-1',
        epoch: currentAuthEpoch(),
      }),
    });
    expect(restored.getQueryData(reportKey(personal.id))).toEqual(personal);
    expect(restored.getQueryData(reportKey(allowed.id))).toEqual(allowed);
    expect(restored.getQueryData(reportKey(denied.id))).toBeUndefined();
    expect(restored.getQueryData(repositoriesKey)).toEqual([
      { gitUrl: 'https://example.test/keep-this-repository' },
    ]);
    client.clear();
    restored.clear();
  });

  it('does not rewrite or delete offline cache merely because an unrelated billing-only membership exists', async () => {
    const personal = report('personal-report', null);
    const allowed = report('allowed-report', 'allowed');
    const client = clientWithReports([personal, allowed]);
    const diskKey = `${readCacheScope('user-1')}/read-cache`;
    storage.values.set(diskKey, 'existing-offline-cache');
    await expect(
      purgeInaccessibleBriefingCache(client, { userId: 'user-1', authEpoch: currentAuthEpoch() }, [
        'allowed',
      ])
    ).resolves.toBe(false);
    expect(client.getQueryData(reportKey(personal.id))).toEqual(personal);
    expect(client.getQueryData(reportKey(allowed.id))).toEqual(allowed);
    expect(storage.values.get(diskKey)).toBe('existing-offline-cache');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    client.clear();
  });

  it('does not publish a cache rewrite after logout begins', async () => {
    const client = clientWithReports([report('denied-report', 'denied')]);
    setSignOutActive(true);
    await expect(
      purgeInaccessibleBriefingCache(
        client,
        { userId: 'user-1', authEpoch: currentAuthEpoch() },
        []
      )
    ).resolves.toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    client.clear();
  });
});
