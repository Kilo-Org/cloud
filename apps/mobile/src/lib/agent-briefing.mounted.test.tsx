import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useBriefingInvalidation } from '@/lib/agent-briefing';
import { readCacheScope } from '@/lib/persist/cache-scope';
import { act, TestRenderer } from '@/test/renderer';

// The prune is best-effort and runs off-render, so the only things to observe
// are the query cache and the one persisted read-cache blob: the suite mounts a
// probe over a real QueryClient and asserts on both.
const USER_ID = 'user-1';

type Membership = { organizationId: string; role: string };
type MembershipsRead = { isSuccess: boolean; data: Membership[] | undefined };

const state = vi.hoisted(() => {
  const seeded: { memberships: MembershipsRead } = {
    memberships: { isSuccess: true, data: [{ organizationId: 'allowed', role: 'member' }] },
  };
  return seeded;
});

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
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/auth/auth-context', () => ({
  // The epoch the app starts at, which is the one the publication fence accepts.
  useAuth: () => ({ authEpoch: 0, isSigningOut: false }),
}));
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => state.memberships,
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ agentBriefing: { pathKey: () => ['agentBriefing'] } }),
}));

const USER_KEY = [['user', 'getMe'], { type: 'query' }] as const;
const LIST_KEY = [
  ['agentBriefing', 'list'],
  { type: 'query', input: { scope: 'all', currentOnly: true, limit: 30 } },
] as const;
const ALLOWED_LIST_KEY = [
  ['agentBriefing', 'list'],
  {
    type: 'query',
    input: { scope: 'organization', organizationId: 'allowed', currentOnly: true, limit: 1 },
  },
] as const;
const DENIED_LIST_KEY = [
  ['agentBriefing', 'list'],
  {
    type: 'query',
    input: { scope: 'organization', organizationId: 'denied', currentOnly: true, limit: 1 },
  },
] as const;
const PERSONAL_REPORT_KEY = [
  ['agentBriefing', 'get'],
  { type: 'query', input: { reportId: 'personal-report' } },
] as const;

// Only the fields the prune and the restore allowlist read: the context an entry
// belongs to, and the summary text a persisted snapshot must keep.
const PERSONAL_REPORT = {
  id: 'personal-report',
  context: { organizationId: null },
  summary: { text: 'personal-report-private-summary' },
};
const ALLOWED_REPORT = {
  id: 'allowed-report',
  context: { organizationId: 'allowed' },
  summary: { text: 'allowed-report-private-summary' },
};
const DENIED_REPORT = {
  id: 'denied-report',
  context: { organizationId: 'denied' },
  summary: { text: 'denied-report-private-summary' },
};

const seededList = { reports: [PERSONAL_REPORT, ALLOWED_REPORT], nextCursor: null };
const seededAllowedList = { reports: [ALLOWED_REPORT], nextCursor: null };
const seededDeniedList = { reports: [DENIED_REPORT], nextCursor: null };

function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  // `purgeInaccessibleBriefingCache` reads the owner from this cached identity.
  client.setQueryData(USER_KEY, { id: USER_ID });
  client.setQueryData(LIST_KEY, seededList);
  client.setQueryData(ALLOWED_LIST_KEY, seededAllowedList);
  client.setQueryData(DENIED_LIST_KEY, seededDeniedList);
  client.setQueryData(PERSONAL_REPORT_KEY, PERSONAL_REPORT);
  return client;
}

function InvalidationProbe({ error }: { error: unknown }) {
  useBriefingInvalidation(error);
  return null;
}

type Mounted = { unmount: () => void };

async function mount(client: QueryClient, error: unknown): Promise<Mounted> {
  const pending: { renderer: TestRenderer.ReactTestRenderer | undefined } = {
    renderer: undefined,
  };
  await act(async () => {
    pending.renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client }, createElement(InvalidationProbe, { error }))
    );
    await Promise.resolve();
  });
  const renderer = pending.renderer;
  if (!renderer) {
    throw new Error('The probe did not mount');
  }
  return {
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
      client.clear();
    },
  };
}

/** Flush the effect's best-effort continuation before asserting on it. */
async function flushEffect(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const forbidden = { data: { code: 'FORBIDDEN' } };

describe('useBriefingInvalidation', () => {
  beforeEach(() => {
    storage.values.clear();
    vi.clearAllMocks();
    state.memberships = {
      isSuccess: true,
      data: [{ organizationId: 'allowed', role: 'member' }],
    };
  });

  it('drops only the denied organization and keeps every readable briefing entry', async () => {
    const client = seededClient();
    const mounted = await mount(client, forbidden);

    await flushEffect();
    expect(storage.removeItem).not.toHaveBeenCalled();
    // A prune that changes anything re-persists the remaining snapshot, which is
    // how the hook's off-render work announces it finished.
    await vi.waitFor(() => {
      expect(storage.setItem).toHaveBeenCalled();
    });

    expect(client.getQueryData(LIST_KEY)).toEqual(seededList);
    expect(client.getQueryData(PERSONAL_REPORT_KEY)).toEqual(PERSONAL_REPORT);
    expect(client.getQueryData(ALLOWED_LIST_KEY)).toEqual(seededAllowedList);
    expect(client.getQueryData(DENIED_LIST_KEY)).toBeUndefined();
    const persisted = storage.values.get(`${readCacheScope(USER_ID)}/read-cache`);
    expect(persisted).toContain('personal-report-private-summary');
    mounted.unmount();
  });

  it('prunes nothing while the membership list has not settled', async () => {
    state.memberships = { isSuccess: false, data: undefined };
    const client = seededClient();
    const mounted = await mount(client, forbidden);

    // An unsettled list would make every organization look inaccessible, so the
    // hook must wait for it rather than guess.
    await flushEffect();

    expect(client.getQueryData(LIST_KEY)).toEqual(seededList);
    expect(client.getQueryData(PERSONAL_REPORT_KEY)).toEqual(PERSONAL_REPORT);
    expect(client.getQueryData(ALLOWED_LIST_KEY)).toEqual(seededAllowedList);
    expect(client.getQueryData(DENIED_LIST_KEY)).toEqual(seededDeniedList);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('prunes nothing for an error that is not an access denial', async () => {
    const client = seededClient();
    const mounted = await mount(client, {
      data: { code: 'INTERNAL_SERVER_ERROR' },
    });

    await flushEffect();

    expect(client.getQueryData(LIST_KEY)).toEqual(seededList);
    expect(client.getQueryData(PERSONAL_REPORT_KEY)).toEqual(PERSONAL_REPORT);
    expect(client.getQueryData(ALLOWED_LIST_KEY)).toEqual(seededAllowedList);
    expect(client.getQueryData(DENIED_LIST_KEY)).toEqual(seededDeniedList);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    mounted.unmount();
  });
});
