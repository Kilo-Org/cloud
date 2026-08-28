/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom). */
/* eslint-disable max-lines -- keep the real SDK lifecycle probes with the route's shared mounted fixture. */
import { createElement, type ReactElement, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as ReactQuery from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createSessionManager,
  type KiloSessionId,
  type SessionManager,
  type SessionManagerConfig,
  type SessionSnapshotPageOutcome,
} from '@kilocode/cloud-agent-sdk';
import { kiloId, stubTextPart, stubUserMessage } from '@kilocode/cloud-agent-sdk/test-helpers';

import '@/i18n';
import { useSessionManager } from '@/components/agents/session-provider';
import { UserWebConnectionProvider } from '@/components/agents/user-web-connection-provider';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { clearActiveToken, setActiveToken, setSignOutTeardownActive } from '@/lib/auth/token-owner';
import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';
import SessionDetailScreen from './[session-id]';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());
const useRouterMock = vi.hoisted(() => vi.fn());
const useQueryMock = vi.hoisted(() => vi.fn());
const queryOptionsMock = vi.hoisted(() => vi.fn());
const createMobileManagerMock = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
  token: 'account-a-token' as string | undefined,
  authEpoch: 1,
  isLoading: false,
  isSigningOut: false,
  sessionEnded: false,
}));

const CHILD_ID = kiloId('ses_child_scope_probe');
const childPageMock = vi.fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>();
type ManagerProbe = { manager: SessionManager; store: SessionManagerConfig['store'] };
const managers: ManagerProbe[] = [];
// Request credentials can change independently of the React token (request-time refresh).
let requestAccount: 'A' | 'B' = 'A';
const rootRequests: { account: 'A' | 'B'; sessionId: KiloSessionId }[] = [];

const queryState = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  isFetching: false,
  error: null as { data?: { code?: string } } | null,
  data: null as { organization_id?: string } | null,
  refetch: vi.fn(),
}));

const confirmationRequests = vi.hoisted(() => ({
  getMe: vi.fn<() => Promise<{ id: string }>>(),
  ticket: vi.fn<() => Promise<{ token: string }>>(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn() }));
vi.mock('@/lib/config', () => ({ SESSION_INGEST_WS_URL: 'wss://ingest.example.com' }));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: () => ({}),
}));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
  useRouter: useRouterMock,
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQuery: useQueryMock,
}));

// Foreground query refresh is separate from route parsing and provider lifetime.
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      get: {
        queryOptions: queryOptionsMock,
        queryKey: () => [['cliSessionsV2', 'get']],
      },
    },
  }),
  trpcClient: {
    user: { getMe: { query: confirmationRequests.getMe } },
    activeSessions: { createWebTicket: { mutate: confirmationRequests.ticket } },
  },
}));

vi.mock('@/components/invalid-route-state', () => ({
  InvalidRouteState: 'InvalidRouteState',
}));

vi.mock('@/components/agents/session-detail-content', () => ({
  SessionDetailContent: function SessionDetailContent(
    props: Readonly<{ sessionId: KiloSessionId }>
  ) {
    const manager = useSessionManager();
    const { sessionId } = props;
    // Match the real detail lifecycle for the original manager and every successor.
    useEffect(() => {
      void manager.switchSession(sessionId);
    }, [sessionId, manager]);
    const rootMessages = useAtomValue(manager.atoms.messagesList);
    const childMessages = useAtomValue(manager.atoms.childMessages)(CHILD_ID);
    return createElement(
      'SessionDetailContent',
      props,
      rootMessages.flatMap(message =>
        message.parts.flatMap(part =>
          part.type === 'text' ? [createElement('RootText', { key: part.id }, part.text)] : []
        )
      ),
      childMessages.flatMap(message =>
        message.parts.flatMap(part =>
          part.type === 'text' ? [createElement('Text', { key: part.id }, part.text)] : []
        )
      )
    );
  },
}));

vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: 'SessionSkeletonMessages',
  SessionComposerSkeleton: 'SessionComposerSkeleton',
}));

vi.mock('@/components/agents/session-connection-indicator', () => ({
  SessionConnectionIndicator: 'SessionConnectionIndicator',
}));

vi.mock('@/components/agents/session-context-metrics', () => ({
  SessionContextMetrics: 'SessionContextMetrics',
}));

vi.mock('@/components/agents/mobile-session-manager', () => ({
  createMobileAgentSessionManager: createMobileManagerMock,
}));

vi.mock('@/components/agents/session-terminal-error', () => ({
  buildTerminalErrorCopyText: () => '',
}));

vi.mock('@/components/agents/use-message-copy', () => ({
  performCopy: vi.fn(),
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: 'ScreenHeader',
}));

vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext<string | undefined>(undefined) };
});

vi.mock('@/lib/spawned-not-found-retry', () => ({
  shouldRetryNotFoundOnSpawnedRoute: () => false,
}));

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  if (type === 'QueryError') {
    return root.findAllByType(QueryError);
  }
  if (type === 'Button') {
    return root.findAllByType(Button);
  }
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

async function mountRoute(
  element: ReactElement = createElement(SessionDetailScreen)
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(UserWebConnectionProvider, null, element));
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  const renderer = ref.current;
  onTestFinished(() => {
    act(() => {
      renderer.unmount();
    });
  });
  return renderer;
}

async function updateRoute(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.update(
      createElement(UserWebConnectionProvider, null, createElement(SessionDetailScreen))
    );
    await Promise.resolve();
  });
}

function queryEnabled(): boolean | undefined {
  const options = useQueryMock.mock.calls[0]?.[0] as { enabled?: boolean } | undefined;
  return options?.enabled;
}

function queryInput(): { session_id?: string } | undefined {
  return queryOptionsMock.mock.calls[0]?.[0] as { session_id?: string } | undefined;
}

function beginReplacement() {
  setSignOutActive(true);
  setSignOutTeardownActive(true);
  authState.isSigningOut = true;
  authState.token = undefined;
  bumpAuthEpoch();
  authState.authEpoch = currentAuthEpoch();
  beginAuthenticatedOwner();
  clearActiveToken();
}

function commitCredentials(account: 'A' | 'B') {
  requestAccount = account;
  authState.token = account === 'A' ? 'account-a-token' : 'account-b-token';
  setActiveToken(authState.token, null);
  authState.isSigningOut = false;
  setSignOutTeardownActive(false);
  setSignOutActive(false);
}

function commitAccount(account: 'A' | 'B') {
  commitCredentials(account);
  confirmAuthenticatedOwner(getAuthenticatedOwner(), `user-${account}`);
}

beforeEach(() => {
  beginReplacement();
  commitAccount('A');
  confirmationRequests.getMe
    .mockReset()
    .mockReturnValue(Promise.withResolvers<{ id: string }>().promise);
  // Keep sockets deterministic; connection integration has its own real-SDK socket suite.
  confirmationRequests.ticket
    .mockReset()
    .mockReturnValue(Promise.withResolvers<{ token: string }>().promise);
  managers.length = 0;
  requestAccount = 'A';
  rootRequests.length = 0;
  childPageMock.mockReset();
  createMobileManagerMock.mockReset();
  createMobileManagerMock.mockImplementation(
    ({ store, userWebConnection }: Pick<SessionManagerConfig, 'store' | 'userWebConnection'>) => {
      const manager = createSessionManager({
        store,
        userWebConnection,
        resolveSession: async id => {
          await Promise.resolve();
          return { type: 'read-only', kiloSessionId: id };
        },
        getTicket: vi.fn(),
        fetchSnapshot: vi.fn().mockResolvedValue({ info: { id: 'sess-1' }, messages: [] }),
        fetchSnapshotPage: async (id, options) => {
          if (id === CHILD_ID) {
            const page = await childPageMock(id, options);
            return page;
          }
          return transcriptPage(
            id,
            `msg-root-${requestAccount}`,
            `Account ${requestAccount} root row`
          );
        },
        api: {
          send: vi.fn(),
          interrupt: vi.fn(),
          answer: vi.fn(),
          reject: vi.fn(),
          respondToPermission: vi.fn(),
        },
        prepare: vi.fn(),
        initiate: vi.fn(),
        fetchSession: async id => {
          rootRequests.push({ account: requestAccount, sessionId: id });
          await Promise.resolve();
          return {
            kiloSessionId: id,
            cloudAgentSessionId: null,
            title: 'Scope probe root',
            organizationId: null,
            gitUrl: null,
            gitBranch: null,
            mode: null,
            model: null,
            variant: null,
            repository: null,
            isInitiated: true,
            needsLegacyPrepare: false,
            isPreparingAsync: false,
            prompt: null,
            initialMessageId: null,
            associatedPr: null,
          };
        },
      });
      managers.push({ manager, store });
      return manager;
    }
  );
  useLocalSearchParamsMock.mockReset();
  useRouterMock.mockReset();
  useRouterMock.mockReturnValue({ replace: vi.fn() });
  useQueryMock.mockReset();
  useQueryMock.mockImplementation((options: { enabled?: boolean } | undefined) => {
    // A disabled TanStack query stays pending forever (`isPending: true` when
    // `enabled` is false). Model that so the invalid-param tests exercise the
    // real branch order instead of a skeleton that never resolves.
    const disabled = options?.enabled === false;
    return {
      ...queryState,
      isPending: disabled ? true : queryState.isPending,
    };
  });
  queryOptionsMock.mockReset();
  queryOptionsMock.mockReturnValue({});
  queryState.isPending = false;
  queryState.isError = false;
  queryState.isFetching = false;
  queryState.error = null;
  queryState.data = null;
  queryState.refetch.mockClear();
});

describe('SessionDetailScreen invalid session-id', () => {
  it('renders InvalidRouteState with the app backTo when session-id is undefined', async () => {
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': undefined });
    const renderer = await mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)');
    expect(findByType(renderer.root, 'SessionDetailContent')).toHaveLength(0);
    expect(queryEnabled()).toBe(false);
  });

  it('renders InvalidRouteState with the app backTo when session-id is an array', async () => {
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': ['sess-1', 'sess-2'] });
    const renderer = await mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)');
    expect(findByType(renderer.root, 'SessionDetailContent')).toHaveLength(0);
    expect(queryEnabled()).toBe(false);
  });
});

describe('SessionDetailScreen valid session-id', () => {
  it('renders the session content with the parsed session-id and enables the query', async () => {
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1' });
    const renderer = await mountRoute();

    const content = findByType(renderer.root, 'SessionDetailContent');
    expect(content).toHaveLength(1);
    expect(propOf(content[0], 'sessionId')).toBe('sess-1');
    expect(findByType(renderer.root, 'InvalidRouteState')).toHaveLength(0);
    expect(queryEnabled()).toBe(true);
    expect(queryInput()).toEqual({ session_id: 'sess-1' });
  });
});

function transcriptPage(sessionId: KiloSessionId, messageId: string, text: string) {
  return {
    kind: 'success',
    info: { id: sessionId, ...(sessionId === CHILD_ID ? { parentID: 'sess-1' } : {}) },
    messages: [
      {
        info: stubUserMessage({ id: messageId, sessionID: sessionId }),
        parts: [
          stubTextPart({
            id: `part-${messageId}`,
            sessionID: sessionId,
            messageID: messageId,
            text,
          }),
        ],
      },
    ],
    nextCursor: null,
    omittedItemCount: 0,
  } satisfies SessionSnapshotPageOutcome;
}

function childPage(messageId: string, text: string, nextCursor: string | null = null) {
  return { ...transcriptPage(CHILD_ID, messageId, text), nextCursor };
}

function transcriptText(renderer: TestRenderer.ReactTestRenderer, type = 'Text'): string {
  if (renderer.toJSON() === null) {
    return '';
  }
  return findByType(renderer.root, type)
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join('\n');
}

function childIds({ store, manager }: ManagerProbe): string[] {
  return store
    .get(manager.atoms.childMessages)(CHILD_ID)
    .map(message => message.info.id);
}

async function startChildPage(pageKind: 'first' | 'older') {
  useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1', organizationId: 'org-a' });
  const renderer = await mountRoute();
  const current = managers.at(-1);
  if (!current) {
    throw new Error('route did not create a manager');
  }
  // The rendered detail effect, not this helper, must initialize the manager.
  expect(transcriptText(renderer, 'RootText')).toBe('Account A root row');

  if (pageKind === 'older') {
    childPageMock.mockResolvedValueOnce(
      childPage('msg-account-a-cached', 'Account A cached row', 'older-cursor')
    );
    await act(async () => {
      await current.manager.hydrateChildSession(CHILD_ID);
    });
    expect(transcriptText(renderer)).toContain('Account A cached row');
  }

  const deferred = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
  childPageMock.mockReturnValueOnce(deferred.promise);
  const pending: { request?: Promise<void> } = {};
  act(() => {
    pending.request =
      pageKind === 'first'
        ? current.manager.hydrateChildSession(CHILD_ID)
        : current.manager.loadOlderChildMessages(CHILD_ID);
  });
  if (!pending.request) {
    throw new Error('child request did not start');
  }
  expect(childPageMock).toHaveBeenLastCalledWith(
    CHILD_ID,
    pageKind === 'first' ? {} : { cursor: 'older-cursor' }
  );
  return { renderer, current, request: pending.request, resolvePage: deferred.resolve };
}

// Exercise the real provider, manager, child replay, and Jotai storage with
// controlled auth snapshots, network results, and a native transcript renderer stub.
describe.each(['first', 'older'] as const)('SessionDetailScreen %s child-page scope', pageKind => {
  it.each([
    {
      transition: 'root replacement',
      change: () => {
        useLocalSearchParamsMock.mockReturnValue({
          'session-id': 'sess-2',
          organizationId: 'org-a',
        });
      },
    },
    {
      transition: 'context replacement',
      change: () => {
        useLocalSearchParamsMock.mockReturnValue({
          'session-id': 'sess-1',
          organizationId: 'org-b',
        });
      },
    },
    {
      transition: 'account replacement before credential publication',
      change: () => {
        beginReplacement();
      },
    },
    {
      transition: 'account replacement after credential publication',
      change: () => {
        beginReplacement();
        commitAccount('B');
      },
    },
    {
      transition: 'logout before credential cleanup',
      change: () => {
        authState.isSigningOut = true;
        setSignOutActive(true);
        beginAuthenticatedOwner();
      },
    },
  ])('rejects deferred rows after $transition', async ({ change }) => {
    const { renderer, current, request, resolvePage } = await startChildPage(pageKind);
    act(change);
    await updateRoute(renderer);
    await act(async () => {
      resolvePage(childPage('msg-account-a-late', 'Account A late row'));
      await request;
    });

    // Keep both observations even when one fails: hidden content is not retired storage.
    expect.soft(childIds(current)).not.toContain('msg-account-a-late');
    expect.soft(transcriptText(renderer)).not.toContain('Account A');
  });

  it('keeps valid rows and accepts deferred rows during ordinary token refresh', async () => {
    const { renderer, current, request, resolvePage } = await startChildPage(pageKind);
    authState.token = 'account-a-refreshed-token';
    await updateRoute(renderer);
    await act(async () => {
      resolvePage(childPage('msg-account-a-late', 'Account A late row'));
      await request;
    });

    expect(transcriptText(renderer)).toContain('Account A late row');
    expect(childIds(current)).toContain('msg-account-a-late');
    if (pageKind === 'older') {
      expect(transcriptText(renderer)).toContain('Account A cached row');
    }
  });
});

describe.each(['first', 'older'] as const)(
  'SessionDetailScreen %s replacement sequence',
  pageKind => {
    it('retires the manager synchronously before React can unmount its route', async () => {
      const { renderer, current, request, resolvePage } = await startChildPage(pageKind);
      await act(async () => {
        beginReplacement();
        // Root rows exist in both cases, so this fails if retirement waits for React cleanup.
        expect(current.store.get(current.manager.atoms.messagesList)).toEqual([]);
        expect(childIds(current)).toEqual([]);
        resolvePage(childPage('msg-account-a-late', 'Account A late row'));
        await request;
      });

      expect(childIds(current)).toEqual([]);
      expect(transcriptText(renderer)).toBe('');
    });

    it('retires the old owner while pending and initializes the committed successor', async () => {
      const { renderer, current, request, resolvePage } = await startChildPage(pageKind);
      const startedRequests = rootRequests.length;

      // Pending ownership publishes while credential persistence still holds account A.
      act(beginReplacement);
      await updateRoute(renderer);
      expect.soft(transcriptText(renderer, 'RootText')).not.toContain('Account A');
      expect.soft(transcriptText(renderer)).not.toContain('Account A');
      expect.soft(rootRequests.slice(startedRequests)).toEqual([]);

      await act(async () => {
        resolvePage(childPage('msg-account-a-late', 'Account A late row'));
        await request;
      });
      expect.soft(childIds(current)).toEqual([]);
      expect.soft(transcriptText(renderer)).not.toContain('Account A');

      // A current getMe response confirms the committed credentials.
      act(() => {
        commitAccount('B');
      });
      await updateRoute(renderer);
      expect.soft(transcriptText(renderer, 'RootText')).toBe('Account B root row');

      const successor = managers.at(-1);
      if (successor && renderer.toJSON() !== null) {
        childPageMock.mockResolvedValueOnce(
          childPage('msg-account-b-current', 'Account B current row')
        );
        await act(async () => {
          await successor.manager.hydrateChildSession(CHILD_ID);
        });
      }
      expect.soft(childIds(current)).toEqual([]);
      expect.soft(transcriptText(renderer)).toBe('Account B current row');

      authState.token = 'account-b-refreshed-token';
      await updateRoute(renderer);
      expect.soft(transcriptText(renderer, 'RootText')).toBe('Account B root row');
      expect.soft(transcriptText(renderer)).toBe('Account B current row');
    });
  }
);

describe('SessionDetailScreen owner-scoped metadata and recovery', () => {
  it('does not initialize a successor from the previous account metadata cache', async () => {
    const actual = await vi.importActual<typeof ReactQuery>('@tanstack/react-query');
    useQueryMock.mockImplementation(actual.useQuery);
    const metadata = Promise.withResolvers<{ organization_id: string }>();
    queryOptionsMock.mockImplementation(() => ({
      queryKey: [['cliSessionsV2', 'get']],
      queryFn: async () => {
        const account = requestAccount;
        await Promise.resolve();
        return account === 'A' ? { organization_id: 'org-a' } : metadata.promise;
      },
    }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    vi.useFakeTimers();
    onTestFinished(() => {
      client.clear();
      vi.useRealTimers();
    });
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1' });
    const tree = createElement(QueryClientProvider, { client }, createElement(SessionDetailScreen));
    const renderer = await mountRoute(tree);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(transcriptText(renderer, 'RootText')).toBe('Account A root row');
    const requestsBeforeReplacement = rootRequests.length;

    await act(async () => {
      beginReplacement();
      commitAccount('B');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(transcriptText(renderer, 'RootText')).toBe('');
    expect(rootRequests.slice(requestsBeforeReplacement)).toEqual([]);

    await act(async () => {
      metadata.resolve({ organization_id: 'org-b' });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(transcriptText(renderer, 'RootText')).toBe('Account B root row');
  });

  it('waits for current identity after credentials commit on a fresh mount', async () => {
    beginReplacement();
    requestAccount = 'B';
    authState.token = 'account-b-token';
    authState.isSigningOut = false;
    setSignOutActive(false);
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1', organizationId: 'org-a' });
    const renderer = await mountRoute();
    expect(rootRequests).toEqual([]);
    expect(transcriptText(renderer, 'RootText')).toBe('');

    act(() => {
      commitAccount('B');
    });
    await updateRoute(renderer);
    expect(transcriptText(renderer, 'RootText')).toBe('Account B root row');
  });

  it('keeps the existing retry action usable for a temporary metadata failure', async () => {
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1' });
    queryState.isError = true;
    queryState.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    queryState.refetch.mockImplementation(async () => {
      queryState.isError = false;
      queryState.error = null;
      await Promise.resolve();
    });
    const renderer = await mountRoute();
    const error = findByType(renderer.root, 'QueryError')[0];
    expect(propOf(error, 'variant')).toBe('server');
    const retry = propOf(error, 'onRetry') as (() => void) | undefined;
    if (!retry) {
      throw new Error('temporary error lost its retry action');
    }

    act(retry);
    await updateRoute(renderer);

    expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
    expect(transcriptText(renderer, 'RootText')).toBe('Account A root row');
  });

  it.each([
    { code: 'NOT_FOUND', variant: 'not-found' },
    { code: 'UNAUTHORIZED', variant: 'permission' },
  ])('keeps $code terminal with no retry action', async ({ code, variant }) => {
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1' });
    queryState.isError = true;
    queryState.error = { data: { code } };
    const renderer = await mountRoute();
    const error = findByType(renderer.root, 'QueryError')[0];

    expect(propOf(error, 'variant')).toBe(variant);
    expect(propOf(error, 'onRetry')).toBeUndefined();
    expect(findByType(renderer.root, 'SessionDetailContent')).toHaveLength(0);
    expect(findByType(renderer.root, 'Button')).toHaveLength(2);
  });
});

describe('SessionDetailScreen fresh authentication scope', () => {
  // Fresh mounts now consume the producer's pending/confirmed association, not token history.
  it('starts no old-account work when first mounted during pending replacement', async () => {
    beginReplacement();
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1', organizationId: 'org-a' });
    const renderer = await mountRoute();

    expect.soft(rootRequests).toEqual([]);
    expect.soft(transcriptText(renderer, 'RootText')).toBe('');
    expect.soft(transcriptText(renderer)).toBe('');

    act(() => {
      commitAccount('B');
    });
    await updateRoute(renderer);
    expect.soft(transcriptText(renderer, 'RootText')).toBe('Account B root row');
  });

  it('initializes current-account rows on a fresh mount and route re-entry', async () => {
    beginReplacement();
    commitAccount('A');
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1', organizationId: 'org-a' });
    const renderer = await mountRoute();
    expect(transcriptText(renderer, 'RootText')).toBe('Account A root row');
    const previous = managers.at(-1);
    if (!previous) {
      throw new Error('route did not create a manager');
    }
    act(() => {
      renderer.unmount();
    });
    expect(previous.store.get(previous.manager.atoms.messagesList)).toEqual([]);

    const reentered = await mountRoute();
    expect(transcriptText(reentered, 'RootText')).toBe('Account A root row');
  });
});

function retryControl(renderer: TestRenderer.ReactTestRenderer) {
  const retry = findByType(renderer.root, 'Pressable').find(
    node => propOf(node, 'accessibilityLabel') === 'Retry'
  );
  if (!retry) {
    throw new Error('confirmation Retry is missing');
  }
  return retry;
}

function pressControl(control: TestRenderer.ReactTestInstance | undefined) {
  const onPress = propOf(control, 'onPress') as (() => void) | undefined;
  if (!onPress) {
    throw new Error('route control is not operable');
  }
  onPress();
}

describe('SessionDetailScreen identity confirmation feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    beginReplacement();
    commitCredentials('B');
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1' });
  });

  it.each([undefined, 'org-a'])(
    'shows the header and existing skeletons while identity is pending with organization %s',
    async organizationId => {
      useLocalSearchParamsMock.mockReturnValue({
        'session-id': 'sess-1',
        organizationId,
        title: 'Account A private title',
      });
      const renderer = await mountRoute(
        createElement(
          'RouteAndSibling',
          null,
          createElement(SessionDetailScreen),
          createElement('UnrelatedScreen')
        )
      );

      const header = findByType(renderer.root, 'ScreenHeader')[0];
      expect(propOf(header, 'title')).toBeTruthy();
      expect(propOf(header, 'title')).not.toBe('Account A private title');
      expect(findByType(renderer.root, 'SessionSkeletonMessages')).toHaveLength(1);
      expect(findByType(renderer.root, 'SessionComposerSkeleton')).toHaveLength(1);
      expect(findByType(renderer.root, 'SessionDetailContent')).toHaveLength(0);
      expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
      expect(findByType(renderer.root, 'Pressable')).toHaveLength(0);
      expect(findByType(renderer.root, 'UnrelatedScreen')).toHaveLength(1);
      expect(transcriptText(renderer, 'RootText')).toBe('');
      expect(rootRequests).toEqual([]);
      expect(queryEnabled()).toBe(false);
    }
  );

  it('keeps repeated failures recoverable and opens current root and child rows after user Retry', async () => {
    const repeatedFailure = Promise.withResolvers<{ id: string }>();
    const success = Promise.withResolvers<{ id: string }>();
    confirmationRequests.getMe
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(repeatedFailure.promise)
      .mockReturnValueOnce(success.promise);
    const renderer = await mountRoute();

    expect(transcriptText(renderer)).toContain('Could not load your account');
    expect(transcriptText(renderer)).toContain('Check your connection and try again.');
    expect(propOf(retryControl(renderer), 'accessibilityState')).toMatchObject({
      disabled: false,
      busy: false,
    });
    act(() => {
      pressControl(retryControl(renderer));
    });
    expect(findByType(renderer.root, 'QueryError')).toHaveLength(1);
    expect(propOf(retryControl(renderer), 'disabled')).toBe(true);
    expect(propOf(retryControl(renderer), 'accessibilityState')).toMatchObject({
      disabled: true,
      busy: true,
    });
    expect(findByType(renderer.root, 'ActivityIndicator')).toHaveLength(1);
    expect(rootRequests).toEqual([]);

    await act(async () => {
      repeatedFailure.reject(new Error('still offline'));
      await Promise.resolve();
    });
    expect(transcriptText(renderer)).toContain('Could not load your account');
    expect(transcriptText(renderer)).toContain('Back to sessions');
    expect(propOf(retryControl(renderer), 'accessibilityState')).toMatchObject({
      disabled: false,
      busy: false,
    });
    expect(transcriptText(renderer, 'RootText')).toBe('');
    act(() => {
      pressControl(retryControl(renderer));
    });
    expect(propOf(retryControl(renderer), 'accessibilityState')).toMatchObject({
      disabled: true,
      busy: true,
    });
    await act(async () => {
      success.resolve({ id: 'user-B' });
      await success.promise;
    });

    expect(getAuthenticatedOwner().userId).toBe('user-B');
    expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
    expect(transcriptText(renderer, 'RootText')).toBe('Account B root row');
    const current = managers.at(-1);
    if (!current) {
      throw new Error('confirmed route did not initialize its manager');
    }
    childPageMock.mockResolvedValueOnce(childPage('msg-current-child', 'Account B child row'));
    await act(async () => {
      await current.manager.hydrateChildSession(CHILD_ID);
    });
    expect(transcriptText(renderer)).toBe('Account B child row');
  });

  it('leaves failed confirmation through Back to sessions', async () => {
    confirmationRequests.getMe.mockRejectedValueOnce(new Error('offline'));
    let destination = 'session-detail';
    useRouterMock.mockReturnValue({
      replace: (href: string) => {
        destination = href;
      },
    });
    const renderer = await mountRoute();
    const back = findByType(renderer.root, 'Button').find(button =>
      findByType(button, 'Text').some(text => text.children.includes('Back to sessions'))
    );
    act(() => {
      pressControl(back);
    });

    expect(destination).toBe('/(app)/(tabs)/(2_agents)');
    expect(rootRequests).toEqual([]);
  });

  it.each(['success', 'failure'] as const)(
    'keeps successor feedback and ownership unchanged after retired identity %s',
    async outcome => {
      beginReplacement();
      commitCredentials('A');
      const retired = Promise.withResolvers<{ id: string }>();
      const current = Promise.withResolvers<{ id: string }>();
      confirmationRequests.getMe
        .mockReturnValueOnce(retired.promise)
        .mockReturnValueOnce(current.promise);
      const renderer = await mountRoute();
      act(beginReplacement);
      commitCredentials('B');
      await updateRoute(renderer);
      const owner = getAuthenticatedOwner();
      await act(async () => {
        if (outcome === 'success') {
          retired.resolve({ id: 'user-A' });
        } else {
          retired.reject(new Error('retired account failure'));
        }
        await Promise.resolve();
      });

      expect(getAuthenticatedOwner()).toBe(owner);
      expect(owner.userId).toBeNull();
      expect(findByType(renderer.root, 'ScreenHeader')).toHaveLength(1);
      expect(findByType(renderer.root, 'SessionSkeletonMessages')).toHaveLength(1);
      expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
      expect(transcriptText(renderer, 'RootText')).toBe('');
      expect(rootRequests).toEqual([]);
      await act(async () => {
        current.resolve({ id: 'user-B' });
        await current.promise;
      });
      expect(transcriptText(renderer, 'RootText')).toBe('Account B root row');
      expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
    }
  );
});
