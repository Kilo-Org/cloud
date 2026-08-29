/* eslint-disable import/no-nodejs-modules -- load the installed Expo queue without native bindings */
/* eslint-disable typescript-eslint/no-deprecated -- React Native's DOM-free mounted test renderer */
/* eslint-disable max-lines -- one admission fixture exercises both ingress paths and the installed routing queue */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

import type * as RouterModule from 'expo-router/build/global-state/router';
import type * as QueueModule from 'expo-router/build/global-state/routingQueue';
import { type NavigationState } from 'expo-router/build/react-navigation/native';
import { createElement, StrictMode, useEffect, useSyncExternalStore } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginRoute from '@/app/(auth)/login';
import { useAuth } from '@/lib/auth/auth-context';
import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive, setSignOutActive } from '@/lib/auth/sign-out-state';
import { clearActiveToken, setActiveToken, setSignOutTeardownActive } from '@/lib/auth/token-owner';
import { redirectSystemPath } from '@/lib/deep-link-handler';
import {
  _resetDeepLinkLaunchForTests,
  _setGetLinkingURLForTests,
  _setSecureStoreForTests,
  captureLaunchDeepLink,
  clearAccountBoundPendingDeepLink,
  getPendingDeepLink,
  getPendingDeepLinkRequestId,
  getPendingDeepLinkSnapshot,
  setCurrentDeepLinkUserId,
  setPendingDeepLink,
  subscribeToPendingDeepLink,
} from '@/lib/deep-link-launch';
import {
  _resetDevSessionInjectForTests,
  DEV_SESSION_MARKER,
  getDevSessionSnapshot,
} from '@/lib/dev-session-inject';
import {
  DevSessionInjector,
  rejectDevSessionRequest,
  useDevSessionNavigation,
} from './dev-session-injector';

type Auth = ReturnType<typeof useAuth>;
type Action = {
  type: string;
  target: string;
  payload: { name: string; params?: Record<string, unknown> };
};
type NativeRef = { getRootState: () => NavigationState; dispatch: (action: Action) => void };
const fixture = vi.hoisted(() => ({
  auth: undefined as Auth | undefined,
  authListeners: new Set<() => void>(),
  stateListeners: new Set<() => void>(),
  navigationRef: {
    current: null as NativeRef | null,
    addListener: (_event: string, listener: () => void) => {
      fixture.stateListeners.add(listener);
      return () => {
        fixture.stateListeners.delete(listener);
      };
    },
  },
}));
vi.mock('expo-router', () => ({ useNavigationContainerRef: () => fixture.navigationRef }));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () =>
    useSyncExternalStore(
      listener => {
        fixture.authListeners.add(listener);
        return () => {
          fixture.authListeners.delete(listener);
        };
      },
      () => fixture.auth
    ),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/components/login-screen', () => ({ LoginScreen: () => null }));

const require = createRequire(import.meta.url);
const HOME = '/(app)/(tabs)/(0_home)';
const SESSIONS = '/(app)/(tabs)/(2_agents)';
const PROFILE = '/(app)/(tabs)/(3_profile)';
let navigationState = state('(auth)', state('login'));
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let account: string | undefined = undefined;
let loginCanCommit = true;
let accountLoading = false;
let accountError = false;
let consentError = false;
let shellReady = true;
let throwDispatch = false;
let signInFailure = false;
let logoutGate: ReturnType<typeof Promise.withResolvers<undefined>> | undefined = undefined;
const leases = new Set<string>();
const admissions: {
  id: number | undefined;
  leases: string[];
  loginReady: boolean;
  hadToken: boolean;
}[] = [];
const actions: Action[] = [];
const feedback: string[] = [];
const durable = new Map<string, string>();

function state(
  name: string,
  child?: NavigationState,
  params?: Record<string, unknown>
): NavigationState {
  return {
    key: `${name}-navigator`,
    type: 'stack',
    stale: false,
    index: 0,
    routeNames: [name],
    routes: [{ key: `${name}-route`, name, params, ...(child ? { state: child } : {}) }],
  };
}

function destinationState(href: string): NavigationState {
  const url = new URL(href, 'https://fixture.invalid');
  const params = Object.fromEntries(url.searchParams);
  if (url.pathname.startsWith('/(app)/agent-chat/')) {
    return state(
      '(app)',
      state('agent-chat/[session-id]', undefined, {
        ...params,
        'session-id': decodeURIComponent(url.pathname.split('/').at(-1) ?? ''),
      })
    );
  }
  const tab = url.pathname.split('/')[3];
  if (!tab) {
    throw new Error('Unknown fixture destination');
  }
  return state('(app)', state('(tabs)', state(tab, state('index', undefined, params))));
}

const store = {
  navigationRef: fixture.navigationRef,
  assertIsReady: () => {
    if (!fixture.navigationRef.current) {
      throw new Error('Missing fixture navigation ref');
    }
  },
  getRouteInfo: () => ({ segments: [], params: {} }),
  redirects: [],
  linking: { getStateFromPath: destinationState, config: {} },
};
const installedModules = new Map<string, object>();
function loadInstalled(name: string): object {
  const cached = installedModules.get(name);
  if (cached) {
    return cached;
  }
  const exports = {};
  installedModules.set(name, exports);
  runInNewContext(
    readFileSync(require.resolve(`expo-router/build/global-state/${name}.js`), 'utf8'),
    {
      exports,
      process,
      console,
      require: (id: string) => {
        if (['./routingQueue', './getNavigationAction', './stateUtils'].includes(id)) {
          return loadInstalled(id.slice(2));
        }
        if (id === './store') {
          return { store };
        }
        if (id === 'expo/dom') {
          return { IS_DOM: false };
        }
        if (id === 'expo-linking') {
          return {};
        }
        if (id === 'react-native') {
          return { Platform: { OS: 'ios' } };
        }
        if (id === '../domComponents/emitDomEvent') {
          return { emitDomLinkEvent: () => false };
        }
        if (id === '../utils/url') {
          return { shouldLinkExternally: () => false };
        }
        if (id === '../getRoutesRedirects') {
          return { applyRedirects: (href: string) => href };
        }
        if (id === '../link/href') {
          return require('expo-router/build/link/href');
        }
        if (id === '../navigationParams') {
          return require('expo-router/build/navigationParams');
        }
        if (id === '../matchers') {
          return require('expo-router/build/matchers');
        }
        throw new Error(`Unexpected Expo dependency: ${id}`);
      },
    }
  );
  return exports;
}
// No source rewriting: navigate, action resolution, state utilities, and queue are installed code.
const { router } = loadInstalled('router') as typeof RouterModule;
const { routingQueue } = loadInstalled('routingQueue') as typeof QueueModule;

function publishAuth(patch: Partial<Auth>): void {
  if (!fixture.auth) {
    throw new Error('Missing auth fixture');
  }
  fixture.auth = { ...fixture.auth, ...patch };
  for (const listener of fixture.authListeners) {
    listener();
  }
}

async function signOut(): Promise<void> {
  // AuthProvider starts teardown inside its asynchronous auth-transition queue.
  await Promise.resolve();
  if (!fixture.auth?.token && isSignOutActive()) {
    return;
  }
  setSignOutActive(true);
  setSignOutTeardownActive(true);
  publishAuth({ isSigningOut: true });
  clearAccountBoundPendingDeepLink();
  try {
    await (logoutGate?.promise ?? Promise.resolve());
  } finally {
    bumpAuthEpoch();
    clearActiveToken();
    setCurrentDeepLinkUserId(null);
    account = undefined;
    publishAuth({ token: undefined, authEpoch: currentAuthEpoch() });
  }
}

async function signIn(token: string): Promise<void> {
  admissions.push({
    id: getDevSessionSnapshot().replacement?.request.id,
    leases: [...leases],
    loginReady: getDevSessionSnapshot().loginReady,
    hadToken: Boolean(fixture.auth?.token),
  });
  bumpAuthEpoch();
  await Promise.resolve();
  if (signInFailure) {
    throw new Error('raw-secret-error');
  }
  account = token.replace('credential-', 'account-');
  setActiveToken(token, null);
  setSignOutTeardownActive(false);
  setSignOutActive(false);
  setCurrentDeepLinkUserId(account);
  publishAuth({ token, isSigningOut: false, authEpoch: currentAuthEpoch() });
}

function Lease({ name }: { name: string }) {
  useEffect(() => {
    leases.add(name);
    return () => {
      leases.delete(name);
    };
  }, [name]);
  return null;
}

function NavigationOwner() {
  const auth = useAuth();
  const pending = useSyncExternalStore(subscribeToPendingDeepLink, getPendingDeepLinkSnapshot);
  const ready =
    shellReady &&
    Boolean(auth.token) &&
    !auth.isSigningOut &&
    !accountLoading &&
    !accountError &&
    !consentError;
  const prepare = useDevSessionNavigation({
    userId: accountLoading ? undefined : account,
    userIdLoading: accountLoading,
    userIdError: accountError,
    consentCheckError: consentError,
    isShellReady: ready,
  });
  useEffect(() => {
    if (pending === null || !ready) {
      return;
    }
    const requestId = getPendingDeepLinkRequestId();
    const href = prepare(pending, requestId);
    if (href === null) {
      return;
    }
    const consumed = getPendingDeepLink();
    if (consumed) {
      try {
        router.navigate(
          (requestId === null ? consumed : href) as Parameters<typeof router.navigate>[0],
          { withAnchor: true }
        );
      } catch (error) {
        if (requestId === null) {
          throw error;
        }
        rejectDevSessionRequest(requestId);
      }
    }
  }, [pending, ready, prepare]);
  return createElement('surface', { account: auth.token ? account : 'signed-out' });
}

function Harness() {
  const auth = useAuth();
  return createElement(
    'harness',
    null,
    createElement(DevSessionInjector),
    createElement(NavigationOwner),
    !auth.token && loginCanCommit
      ? createElement(LoginRoute)
      : createElement(
          'authenticated',
          null,
          createElement(Lease, { name: 'live-owner' }),
          createElement(Lease, { name: 'socket' })
        )
  );
}

async function render(): Promise<void> {
  await act(() => {
    // Strict Mode must wrap the root to replay initial passive effects in React 19.
    const tree = createElement(StrictMode, null, createElement(Harness));
    if (renderer) {
      renderer.update(tree);
    } else {
      renderer = TestRenderer.create(tree);
    }
  });
}

function requestUrl(label: string, path: string): string {
  return `kiloapp://${path}?dev_session_token=credential-${label}&dev_session_refresh=refresh-${label}&dev_session_expires_in=3600`;
}

async function send(
  label: string,
  path = '/home',
  ingress: 'warm' | 'launch' | 'initial-intent' = 'warm'
): Promise<number> {
  const captured: { id: number | undefined } = { id: undefined };
  await act(() => {
    const url = requestUrl(label, path);
    if (ingress === 'launch') {
      _setGetLinkingURLForTests(() => url);
      captureLaunchDeepLink();
    } else {
      redirectSystemPath({ path: url, initial: ingress === 'initial-intent' });
    }
    captured.id = getDevSessionSnapshot().pending?.id;
  });
  if (captured.id === undefined) {
    throw new Error('Request was not captured');
  }
  return captured.id;
}

async function emit(): Promise<void> {
  // Delay the native imperative emitter, never navigate or the installed queue.
  await act(() => {
    routingQueue.run(fixture.navigationRef as Parameters<typeof routingQueue.run>[0]);
  });
}

function stateFromPayload(name: string, params: Record<string, unknown> = {}): NavigationState {
  const { screen, params: nested, ...leafParams } = params;
  const child =
    typeof screen === 'string'
      ? stateFromPayload(screen, nested as Record<string, unknown>)
      : undefined;
  return state(name, child, leafParams);
}

function applyAction(current: NavigationState, action: Action): NavigationState {
  if (current.key === action.target) {
    return { ...stateFromPayload(action.payload.name, action.payload.params), key: current.key };
  }
  return {
    ...current,
    routes: current.routes.map(route => ({
      ...route,
      ...(route.state ? { state: applyAction(route.state as NavigationState, action) } : {}),
    })),
  };
}

async function commit(next?: NavigationState): Promise<void> {
  await act(() => {
    if (next) {
      navigationState = next;
    } else {
      const action = actions.at(-1);
      if (!action) {
        throw new Error('Nothing was dispatched');
      }
      navigationState = applyAction(navigationState, action);
    }
    for (const listener of fixture.stateListeners) {
      listener();
    }
  });
}

function visibleAccount(): string {
  return renderer?.root.find(node => Object.is(node.type, 'surface')).props.account as string;
}

function startSignedIn(): void {
  account = 'account-old';
  setActiveToken('credential-old', null);
  setCurrentDeepLinkUserId(account);
  publishAuth({ token: 'credential-old' });
  navigationState = destinationState(HOME);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('__DEV__', true);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  _resetDeepLinkLaunchForTests();
  _resetDevSessionInjectForTests();
  _setSecureStoreForTests({
    setItemAsync: async (key, value) => {
      durable.set(key, value);
      await Promise.resolve();
    },
    deleteItemAsync: async key => {
      durable.delete(key);
      await Promise.resolve();
    },
    getItemAsync: async key => {
      await Promise.resolve();
      return durable.get(key) ?? null;
    },
  });
  clearActiveToken();
  setSignOutActive(false);
  setSignOutTeardownActive(false);
  fixture.auth = {
    token: undefined,
    isLoading: false,
    sessionEnded: false,
    authEpoch: currentAuthEpoch(),
    isSigningOut: false,
    signIn,
    signOut,
  };
  account = undefined;
  loginCanCommit = true;
  accountLoading = false;
  accountError = false;
  consentError = false;
  shellReady = true;
  throwDispatch = false;
  signInFailure = false;
  logoutGate = undefined;
  navigationState = state('(auth)', state('login'));
  fixture.navigationRef.current = {
    getRootState: () => navigationState,
    dispatch: action => {
      if (throwDispatch) {
        throw new Error('raw-secret-error');
      }
      actions.push(action);
    },
  };
  routingQueue.queue = [];
  actions.length = 0;
  admissions.length = 0;
  feedback.length = 0;
  durable.clear();
  leases.clear();
  vi.spyOn(console, 'info').mockImplementation((...parts: unknown[]) => {
    feedback.push(parts.join(' '));
  });
});

afterEach(async () => {
  await act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  _resetDeepLinkLaunchForTests();
  _resetDevSessionInjectForTests();
  fixture.authListeners.clear();
  fixture.stateListeners.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('development account admission through both ingress paths', () => {
  it.each(['launch', 'initial-intent'] as const)(
    'holds bootstrap and deduplicates consumed cold delivery with %s first',
    async ingress => {
      publishAuth({ isLoading: true });
      const a = await send('A', '/cloud/sessions', ingress);
      await render();
      expect(getDevSessionSnapshot().pending?.id).toBe(a);
      expect(getDevSessionSnapshot().replacement).toBeNull();
      expect(visibleAccount()).toBe('signed-out');
      expect(admissions).toEqual([]);
      await act(() => {
        publishAuth({ isLoading: false });
      });
      const b = await send('B', '/profile');
      await act(() => {
        const path = requestUrl('A', '/cloud/sessions');
        if (ingress === 'launch') {
          redirectSystemPath({ path, initial: true });
        } else {
          _setGetLinkingURLForTests(() => path);
          captureLaunchDeepLink();
        }
      });
      expect(visibleAccount()).toBe('account-A');
      expect(admissions.map(item => item.id)).toEqual([a]);
      expect(getDevSessionSnapshot().pending?.id).toBe(b);
      expect(getDevSessionSnapshot().replacement?.request.href).toBe(SESSIONS);
      expect(routingQueue.queue).toHaveLength(1);
      await emit();
      await commit();
      expect(visibleAccount()).toBe('account-B');
    }
  );

  it('waits for passive lease cleanup and keeps only the latest paired request', async () => {
    startSignedIn();
    loginCanCommit = false;
    logoutGate = Promise.withResolvers<undefined>();
    await render();
    const a = await send('A');
    await send('B', '/cloud/sessions/ses_B');
    const c = await send('C', '/profile');
    expect(getDevSessionSnapshot().replacement?.request).toMatchObject({ id: a, href: HOME });
    expect(getDevSessionSnapshot().pending).toMatchObject({ id: c, href: PROFILE });
    expect(visibleAccount()).toBe('account-old');
    expect(admissions).toEqual([]);
    await act(() => {
      logoutGate?.resolve(undefined);
    });
    expect(getDevSessionSnapshot().replacement?.phase).toBe('login');
    expect(leases.size).toBe(2);
    expect(admissions).toEqual([]);
    loginCanCommit = true;
    await render();
    expect(admissions).toEqual([{ id: a, leases: [], loginReady: true, hadToken: false }]);
    await emit();
    await commit();
    expect(visibleAccount()).toBe('account-C');
    expect(admissions).toEqual([
      { id: a, leases: [], loginReady: true, hadToken: false },
      { id: c, leases: [], loginReady: true, hadToken: false },
    ]);
    expect(getDevSessionSnapshot().replacement?.request.href).toBe(PROFILE);
  });

  it('does not release B on A navigate return, dispatch, or the Home/sessions collision', async () => {
    await render();
    const a = await send('A', '/cloud/sessions');
    const b = await send('B');
    expect(routingQueue.queue).toHaveLength(1);
    expect(getDevSessionSnapshot().pending?.id).toBe(b);
    expect(visibleAccount()).toBe('account-A');
    await emit();
    expect(routingQueue.queue).toHaveLength(0);
    expect(actions).toHaveLength(1);
    expect(visibleAccount()).toBe('account-A');
    const home = destinationState(`${HOME}?${DEV_SESSION_MARKER}=${a}`);
    const tabs = home.routes[0]?.state?.routes[0]?.state;
    const parked = destinationState(`${SESSIONS}?${DEV_SESSION_MARKER}=${a}`).routes[0]?.state
      ?.routes[0]?.state?.routes[0];
    if (!tabs || !parked) {
      throw new Error('Missing fixture tabs');
    }
    Object.assign(tabs, {
      routes: [...tabs.routes, parked],
      routeNames: ['(0_home)', '(2_agents)'],
    });
    await commit(home);
    expect(getDevSessionSnapshot().pending?.id).toBe(b);
    expect(visibleAccount()).toBe('account-A');
    await commit(destinationState(`${SESSIONS}?${DEV_SESSION_MARKER}=${a}`));
    expect(visibleAccount()).toBe('account-B');
    expect(admissions.map(item => item.id)).toEqual([a, b]);
  });

  it('requires the selected detail id and rejects incomplete nested state', async () => {
    await render();
    const a = await send('A', '/cloud/sessions/ses_A');
    const b = await send('B');
    await emit();
    await commit(destinationState(`/(app)/agent-chat/ses_other?${DEV_SESSION_MARKER}=${a}`));
    expect(visibleAccount()).toBe('account-A');
    await commit(
      state('(app)', undefined, {
        screen: 'agent-chat/[session-id]',
        [DEV_SESSION_MARKER]: String(a),
      })
    );
    expect(getDevSessionSnapshot().pending?.id).toBe(b);
    for (const patch of [{ stale: true }, { index: undefined }]) {
      const incomplete = destinationState(`/(app)/agent-chat/ses_A?${DEV_SESSION_MARKER}=${a}`);
      const child = incomplete.routes[0]?.state;
      if (!child) {
        throw new Error('Missing fixture detail state');
      }
      Object.assign(child, patch);
      // eslint-disable-next-line no-await-in-loop -- observe each committed state before publishing the next one
      await commit(incomplete);
      expect(visibleAccount()).toBe('account-A');
      expect(getDevSessionSnapshot().pending?.id).toBe(b);
    }
    await commit(destinationState(`/(app)/agent-chat/ses_A?${DEV_SESSION_MARKER}=${a}`));
    expect(visibleAccount()).toBe('account-B');
  });

  it('uses fresh markers for identical destinations and ignores stale markers', async () => {
    await render();
    const a = await send('A');
    const b = await send('B');
    await emit();
    await commit();
    const c = await send('C');
    await emit();
    await commit(destinationState(`${HOME}?${DEV_SESSION_MARKER}=${a}`));
    expect(visibleAccount()).toBe('account-B');
    expect(getDevSessionSnapshot().pending?.id).toBe(c);
    await commit(destinationState(`${HOME}?${DEV_SESSION_MARKER}=${b}`));
    expect(visibleAccount()).toBe('account-C');
  });

  it.each(['sign-out', 'sign-in'])(
    'permits a fresh request after a pre-enqueue %s failure',
    async failure => {
      if (failure === 'sign-out') {
        startSignedIn();
        logoutGate = Promise.withResolvers<undefined>();
      } else {
        signInFailure = true;
      }
      await render();
      const a = await send('A');
      if (failure === 'sign-out') {
        await act(() => {
          logoutGate?.reject(new Error('raw-secret-error'));
        });
      }
      expect(getDevSessionSnapshot().replacement).toBeNull();
      expect(routingQueue.queue).toHaveLength(0);
      const attempts = admissions.length;
      await render();
      expect(admissions).toHaveLength(attempts);
      signInFailure = false;
      logoutGate = undefined;
      const b = await send('B');
      expect(visibleAccount()).toBe('account-B');
      expect(admissions.at(-1)?.id).toBe(b);
      expect(feedback.join('\n')).toContain(
        `[dev-session] ${a} Replacement failed before navigation`
      );
      expect(feedback.join('\n')).not.toMatch(/credential-|refresh-|raw-secret-error|kiloapp:/);
    }
  );

  it.each(['unresolved-account', 'unresolved-consent', 'consent-required'])(
    'holds %s behind existing admission',
    async gate => {
      accountLoading = gate === 'unresolved-account';
      shellReady = false;
      await render();
      const a = await send('A');
      const b = await send('B');
      expect(getDevSessionSnapshot().replacement?.phase).toBe('admitted');
      expect(getPendingDeepLinkRequestId()).toBe(a);
      expect(routingQueue.queue).toHaveLength(0);
      expect(getDevSessionSnapshot().pending?.id).toBe(b);
      accountLoading = false;
      shellReady = true;
      await render();
      await emit();
      await commit();
      expect(visibleAccount()).toBe('account-B');
    }
  );

  it.each(['account-error', 'consent-error', 'epoch', 'sign-out', 'superseded'])(
    'rejects pre-enqueue %s without clearing another destination',
    async failure => {
      shellReady = false;
      await render();
      await send('A');
      accountError = failure === 'account-error';
      consentError = failure === 'consent-error';
      if (failure === 'epoch') {
        bumpAuthEpoch();
      }
      if (failure === 'sign-out') {
        setSignOutActive(true);
      }
      if (failure === 'superseded') {
        await act(() => {
          setPendingDeepLink(PROFILE, 'universal-link');
        });
      }
      await render();
      expect(getDevSessionSnapshot().replacement).toBeNull();
      expect(getPendingDeepLinkSnapshot()).toBe(failure === 'superseded' ? PROFILE : null);
      expect(routingQueue.queue).toHaveLength(0);
    }
  );

  it.each(['epoch', 'resolved-account', 'token-owner', 'sign-out'])(
    'never acknowledges a queued destination after %s changes',
    async failure => {
      await render();
      const a = await send('A');
      const b = await send('B');
      await emit();
      if (failure === 'epoch') {
        bumpAuthEpoch();
      }
      if (failure === 'resolved-account') {
        account = 'account-other';
      }
      if (failure === 'token-owner') {
        clearActiveToken();
      }
      if (failure === 'sign-out') {
        setSignOutActive(true);
      }
      await commit(destinationState(`${HOME}?${DEV_SESSION_MARKER}=${a}`));
      expect(getDevSessionSnapshot().replacement?.phase).toBe('blocked');
      expect(getDevSessionSnapshot().pending?.id).toBe(b);
      expect(admissions.map(item => item.id)).toEqual([a]);
    }
  );

  it.each(['delayed-exception', 'missing-ref', 'missing-commit'])(
    'fails closed after a queued %s',
    async failure => {
      await render();
      const a = await send('A');
      const b = await send('B');
      if (failure === 'delayed-exception') {
        throwDispatch = true;
      }
      if (failure === 'missing-ref') {
        fixture.navigationRef.current = null;
      }
      await (failure === 'delayed-exception'
        ? expect(emit()).rejects.toThrow('raw-secret-error')
        : emit());
      expect(getDevSessionSnapshot().pending?.id).toBe(b);
      await act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(getDevSessionSnapshot().replacement?.phase).toBe('blocked');
      await send('C');
      expect(admissions.map(item => item.id)).toEqual([a]);
      expect(feedback.join('\n')).toContain('Restart the app');
      expect(feedback.join('\n')).not.toMatch(/credential-|refresh-|raw-secret-error|kiloapp:/);
    }
  );

  it('clears login readiness on unmount and requires a current passive mount', async () => {
    await render();
    expect(getDevSessionSnapshot().loginReady).toBe(true);
    await act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    expect(getDevSessionSnapshot().loginReady).toBe(false);
    const a = await send('A');
    loginCanCommit = false;
    await render();
    expect(admissions).toEqual([]);
    loginCanCommit = true;
    await render();
    expect(admissions).toEqual([{ id: a, leases: [], loginReady: true, hadToken: false }]);
  });

  it('keeps a fresh pending request usable when the first teardown rejects', async () => {
    startSignedIn();
    logoutGate = Promise.withResolvers<undefined>();
    await render();
    const a = await send('A');
    const b = await send('B', '/profile');
    await act(() => {
      logoutGate?.reject(new Error('raw-secret-error'));
    });
    expect(visibleAccount()).toBe('account-B');
    expect(admissions).toEqual([{ id: b, leases: [], loginReady: true, hadToken: false }]);
    expect(getDevSessionSnapshot().replacement?.request).toMatchObject({ id: b, href: PROFILE });
    expect(feedback.join('\n')).toContain(
      `[dev-session] ${a} Replacement failed before navigation`
    );
  });

  it('does not enqueue an old ordinary destination while sign-out waits in its auth queue', async () => {
    startSignedIn();
    setPendingDeepLink(PROFILE, 'notification');
    const a = await send('A');
    await render();
    expect(visibleAccount()).toBe('account-A');
    expect(routingQueue.queue).toHaveLength(1);
    const action = routingQueue.queue[0] as QueueModule.LinkAction;
    expect(action.payload.href).toBe(`${HOME}?${DEV_SESSION_MARKER}=${a}`);
  });

  it.each([true, false])(
    'keeps ordinary destinations and accounts unchanged with development=%s',
    async development => {
      vi.stubGlobal('__DEV__', development);
      startSignedIn();
      await render();
      await act(() => {
        setPendingDeepLink(PROFILE, 'universal-link');
      });
      const action = routingQueue.queue[0] as QueueModule.LinkAction;
      expect(action.payload.href).toBe(PROFILE);
      await emit();
      await commit();
      expect(navigationState.routes[0]?.state?.routes[0]?.state?.routes[0]?.name).toBe(
        '(3_profile)'
      );
      expect(visibleAccount()).toBe('account-old');
      expect(admissions).toEqual([]);
    }
  );

  it.each(['published-epoch', 'shell'])(
    'rechecks %s before acknowledging an already committed destination',
    async gate => {
      await render();
      const a = await send('A');
      const b = await send('B');
      await emit();
      await act(() => {
        if (gate === 'published-epoch') {
          publishAuth({ authEpoch: currentAuthEpoch() - 1 });
        } else {
          shellReady = false;
        }
      });
      await commit();
      expect(getDevSessionSnapshot().replacement?.phase).toBe('enqueued');
      expect(getDevSessionSnapshot().pending?.id).toBe(b);
      expect(visibleAccount()).toBe('account-A');
      await act(() => {
        shellReady = true;
        publishAuth({ authEpoch: currentAuthEpoch() });
      });
      expect(visibleAccount()).toBe('account-B');
      expect(admissions.map(item => item.id)).toEqual([a, b]);
    }
  );

  it('does not sign in after teardown resolves while the injector is unmounted', async () => {
    startSignedIn();
    logoutGate = Promise.withResolvers<undefined>();
    await render();
    const a = await send('A');
    await act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    await act(() => {
      logoutGate?.resolve(undefined);
    });
    expect(getDevSessionSnapshot().replacement?.phase).toBe('login');
    expect(getDevSessionSnapshot().loginReady).toBe(false);
    expect(admissions).toEqual([]);
    await render();
    expect(visibleAccount()).toBe('account-A');
    expect(admissions).toEqual([{ id: a, leases: [], loginReady: true, hadToken: false }]);
  });

  it('keeps a queued replacement closed across unmount and Strict Mode replay', async () => {
    await render();
    const a = await send('A');
    await act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    const b = await send('B');
    await act(() => {
      vi.advanceTimersByTime(15_000);
    });
    await render();
    expect(getDevSessionSnapshot().replacement?.phase).toBe('blocked');
    expect(getDevSessionSnapshot().pending?.id).toBe(b);
    expect(admissions.map(item => item.id)).toEqual([a]);
  });
});
