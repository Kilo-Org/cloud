/* eslint-disable max-lines -- one mount file proving the offline cold-start history contract end to end */
import { hashKey, onlineManager } from '@tanstack/react-query';
import { type PersistedClient } from '@tanstack/react-query-persist-client';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

// ── In-memory encrypted KV + SecureStore (no native bridge) ────────────────

const kvMock = vi.hoisted(() => {
  const scopes = new Map<string, Map<string, string>>();
  return {
    scopes,
    getItem: vi.fn((scope: string, k: string) => scopes.get(scope)?.get(k) ?? null),
    setItem: vi.fn((scope: string, k: string, v: string) => {
      let bucket = scopes.get(scope);
      if (!bucket) {
        bucket = new Map<string, string>();
        scopes.set(scope, bucket);
      }
      bucket.set(k, v);
    }),
    removeItem: vi.fn((scope: string, k: string) => {
      scopes.get(scope)?.delete(k);
    }),
    clearScope: vi.fn((scope: string) => {
      scopes.delete(scope);
    }),
    clearScopePrefix: vi.fn((prefix: string) => {
      for (const scope of scopes.keys()) {
        if (scope.startsWith(prefix)) {
          scopes.delete(scope);
        }
      }
    }),
  };
});

vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: kvMock.getItem,
  setItem: kvMock.setItem,
  removeItem: kvMock.removeItem,
  clearScope: kvMock.clearScope,
  clearScopePrefix: kvMock.clearScopePrefix,
}));

const secureStoreMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getItemAsync: vi.fn((key: string) => store.get(key) ?? null),
    setItemAsync: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
});

vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreMock.getItemAsync,
  setItemAsync: secureStoreMock.setItemAsync,
  deleteItemAsync: secureStoreMock.deleteItemAsync,
}));

// ── tRPC proxy with the real key shapes; query fns never run offline ───────

const trpcMock = vi.hoisted(() => {
  const queryFns = {
    getMe: vi.fn(() => undefined as never),
    organizations: vi.fn(),
    activeSessions: vi.fn(),
    storedList: vi.fn(),
    recentRepositories: vi.fn(),
    search: vi.fn(),
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the tRPC mock's key builder must live inside the hoisted factory it is returned from.
  const listKey = (input: unknown): readonly unknown[] => [
    ['cliSessionsV2', 'list'],
    { input, type: 'infinite' },
  ];
  const trpc = {
    user: {
      getMe: {
        queryOptions: () => ({
          queryKey: GET_ME_QUERY_KEY,
          queryFn: queryFns.getMe,
        }),
      },
    },
    organizations: {
      list: {
        queryOptions: () => ({
          queryKey: ORGANIZATIONS_KEY,
          queryFn: queryFns.organizations,
        }),
      },
    },
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { input, type: 'query' }],
        queryOptions: (input: unknown, options: object) => ({
          queryKey: [['activeSessions', 'list'], { input, type: 'query' }],
          queryFn: queryFns.activeSessions,
          ...options,
        }),
      },
    },
    cliSessionsV2: {
      list: {
        infiniteQueryKey: (input: unknown) => listKey(input),
        pathFilter: () => ({ queryKey: [['cliSessionsV2', 'list']] }),
        infiniteQueryOptions: (input: unknown, options: object) => ({
          queryKey: listKey(input),
          queryFn: queryFns.storedList,
          initialPageParam: (input as { cursor?: unknown } | null)?.cursor,
          ...options,
        }),
      },
      recentRepositories: {
        queryOptions: (input: unknown, options: object) => ({
          queryKey: [['cliSessionsV2', 'recentRepositories'], { input, type: 'query' }],
          queryFn: queryFns.recentRepositories,
          ...options,
        }),
      },
      search: {
        infiniteQueryKey: (input: unknown) => listKey(input),
        pathFilter: () => ({ queryKey: [['cliSessionsV2', 'search']] }),
        infiniteQueryOptions: (input: unknown, options: object) => ({
          queryKey: listKey(input),
          queryFn: queryFns.search,
          initialPageParam: (input as { cursor?: unknown } | null)?.cursor,
          ...options,
        }),
      },
    },
  };
  return { queryFns, listKey, useTRPC: () => trpc };
});

vi.mock('@/lib/trpc', () => ({ useTRPC: trpcMock.useTRPC }));

// ── Screen-adjacent infra seams (same pattern as the screen mount tests) ───

vi.mock('react-native', () => ({
  View: 'View',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Platform: { OS: 'ios' },
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => undefined }),
  },
  InteractionManager: {
    runAfterInteractions: (run: () => void) => {
      run();
    },
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({
  useNavigation: () => ({ isFocused: () => true }),
  useFocusEffect: () => undefined,
}));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', X: 'X', History: 'History' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ accentSoftForeground: '#1a1a10', mutedForeground: '#666' }),
}));
vi.mock('@/components/agents/session-list-content', () => ({
  AgentSessionListContent: 'AgentSessionListContent',
}));
vi.mock('@/components/agents/session-list-header-actions', () => ({
  SessionListHeaderActions: 'SessionListHeaderActions',
}));
vi.mock('@/components/agents/session-list-search-header', () => ({
  SessionListSearchHeader: 'SessionListSearchHeader',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/agents/use-session-search-input', () => ({
  useSessionSearchInput: () => ({
    searchQuery: '',
    searchInputRef: { current: null },
    hasText: false,
    awaitingCommit: false,
    searchInputKey: 'session-search-empty',
    searchDefaultValue: undefined,
    handleSearchInputChange: vi.fn(),
    handleClearSearchInput: vi.fn(),
    clearSearchInput: vi.fn(),
    searchController: { clearSearchOnly: vi.fn() },
  }),
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ value: null, settled: true }),
}));
// The screen reads only the draft key constant; the real drafts module loads
// the RN Sentry SDK, which this DOM-free suite cannot parse.
vi.mock('@/lib/persist/drafts', () => ({
  SESSION_SEARCH_DRAFT_KEY: 'draft:session-search-history',
  saveDraft: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/auth/account-metadata-write', () => ({
  setAccountMetadata: vi.fn().mockResolvedValue(undefined),
  deleteAccountMetadata: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, isLoaded: true }),
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: 'token', isLoading: false, isSigningOut: false, authEpoch: 0 }),
}));

/* eslint-disable import/first -- the mocks above must be registered before the screen and its modules are imported. */
import { SessionHistoryScreen } from './session-history-screen';
import { buildAgentSessionListInput } from '@/lib/agent-session-input';
import { SESSION_LIST_SORT } from '@/lib/agent-session-sort';
import { createKiloAppQueryClient } from '@/lib/query-client';
import { readCacheScope, restorePersistedCacheOnColdStart } from '@/lib/persist/read-cache';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

const GET_ME_QUERY_KEY: readonly unknown[] = [['user', 'getMe'], { type: 'query' }];
const ORGANIZATIONS_KEY: readonly unknown[] = [['organizations', 'list'], { type: 'query' }];

// ── Fixtures ────────────────────────────────────────────────────────────────

function storedSession(sessionId: string, title: string) {
  return {
    session_id: sessionId,
    title,
    created_at: '2026-09-29T12:00:00Z',
    updated_at: '2026-09-29T12:00:00Z',
  };
}

function page(sessions: { session_id: string; title: string }[], nextCursor: string | null) {
  return { cliSessions: sessions, nextCursor };
}

/** A persisted client with the given successful queries. */
function makePersistedClient(
  queries: {
    queryKey: readonly unknown[];
    data: unknown;
    dataUpdatedAt?: number;
  }[]
): PersistedClient {
  return {
    timestamp: Date.now(),
    buster: '',
    clientState: {
      mutations: [],
      queries: queries.map(query => ({
        queryHash: hashKey(query.queryKey),
        queryKey: query.queryKey,
        state: {
          data: query.data,
          dataUpdateCount: 1,
          dataUpdatedAt: query.dataUpdatedAt ?? Date.now(),
          error: null,
          errorUpdateCount: 0,
          errorUpdatedAt: 0,
          fetchFailureCount: 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: 'success',
          fetchStatus: 'idle',
        },
      })),
    },
  };
}

function seedReadCache(userId: string, queries: Parameters<typeof makePersistedClient>[0]) {
  kvMock.scopes.set(
    readCacheScope(userId),
    new Map([['read-cache', JSON.stringify(makePersistedClient(queries))]])
  );
}

function listContent(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(node => hasType(node, 'AgentSessionListContent'));
}

function hasType(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && node.type === type;
}

function renderedSessionIds(renderer: TestRenderer.ReactTestRenderer): string[] {
  const sections = listContent(renderer).props.sections as {
    data: { session_id: string }[];
  }[];
  return sections.flatMap(section => section.data.map(session => session.session_id));
}

beforeEach(() => {
  kvMock.scopes.clear();
  secureStoreMock.store.clear();
  secureStoreMock.store.set(ACTIVE_USER_ID_KEY, 'u1');
  onlineManager.setOnline(true);
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe('offline cold start of the Agents session history', () => {
  const listInput = buildAgentSessionListInput({
    organizationId: null,
    sortBy: SESSION_LIST_SORT,
  });
  const listKey = [['cliSessionsV2', 'list'], { input: listInput, type: 'infinite' }] as const;

  it('renders the cached history offline: restore, mount, rows', async () => {
    onlineManager.setOnline(false);
    const queryClient = createKiloAppQueryClient();
    seedReadCache('u1', [
      { queryKey: GET_ME_QUERY_KEY, data: { id: 'u1' } },
      {
        queryKey: listKey,
        data: {
          pages: [page([storedSession('recent', 'Recent session')], null)],
          pageParams: [undefined],
        },
      },
    ]);
    await act(async () => {
      await restorePersistedCacheOnColdStart(queryClient);
    });
    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toEqual({ id: 'u1' });
    expect(queryClient.getQueryData(listKey)).toBeDefined();

    const { renderer } = await renderWithProviders(createElement(SessionHistoryScreen), {
      queryClient,
    });
    await waitFor(() => listContent(renderer).props.isLoading === false);
    expect(renderedSessionIds(renderer)).toEqual(['recent']);
    expect(listContent(renderer).props.isError).toBe(false);
  });

  it('renders the cached first page when the restore hydrates after the screen mounted', async () => {
    // The restore's keychain and KV reads can still be in flight when the
    // user reaches the history screen. Offline with nothing cached yet, the
    // paused stored query must settle into the retryable error surface instead
    // of pinning its loading placeholders; the late hydration of the same
    // account's snapshot must still land and render the rows.
    onlineManager.setOnline(false);
    const queryClient = createKiloAppQueryClient();
    const { renderer } = await renderWithProviders(createElement(SessionHistoryScreen), {
      queryClient,
    });
    await waitFor(() => listContent(renderer).props.isLoading === false);
    expect(listContent(renderer).props.isError).toBe(true);

    seedReadCache('u1', [
      { queryKey: GET_ME_QUERY_KEY, data: { id: 'u1' } },
      {
        queryKey: listKey,
        data: {
          pages: [page([storedSession('recent', 'Recent session')], null)],
          pageParams: [undefined],
        },
      },
    ]);
    await act(async () => {
      await restorePersistedCacheOnColdStart(queryClient);
    });
    await waitFor(() => renderedSessionIds(renderer).includes('recent'));
    expect(listContent(renderer).props.isError).toBe(false);
  });
});
