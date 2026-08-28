/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the native provider without a device. */
/* eslint-disable max-lines -- real connection lifetime cases share the socket and credential fixture. */
import { createElement, StrictMode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type UserWebConnection } from '@kilocode/cloud-agent-sdk/user-web-connection';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import {
  clearActiveToken,
  getActiveToken,
  setActiveToken,
  setSignOutTeardownActive,
} from '@/lib/auth/token-owner';
import {
  beginAuthenticatedOwner,
  getAuthenticatedOwner,
  isAuthenticatedOwner,
} from '@/lib/context-scope';
import {
  useIdentityConfirmation,
  UserWebConnectionProvider,
  useUserWebConnection,
} from './user-web-connection-provider';

const mocks = vi.hoisted(() => ({
  getMe: vi.fn<() => Promise<{ id: string }>>(),
  mutate: vi.fn<() => Promise<{ token: string }>>(),
  query: vi.fn(),
  auth: {
    token: 'account-a-token' as string | undefined,
    isLoading: false,
    isSigningOut: false,
    sessionEnded: false,
  },
}));

vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn() }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/config', () => ({ SESSION_INGEST_WS_URL: 'wss://ingest.example.com' }));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: () => ({}),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    user: { getMe: { query: mocks.getMe } },
    activeSessions: {
      createWebTicket: { mutate: mocks.mutate },
      getToken: { query: mocks.query },
    },
  },
}));

const sockets: TestSocket[] = [];
class TestSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly frames: string[] = [];

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  send(frame: string) {
    this.frames.push(frame);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
    this.receive({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const renderers: TestRenderer.ReactTestRenderer[] = [];
const connections: UserWebConnection[] = [];
const identityCredentials: (string | undefined)[] = [];
const ticketCredentials: (string | undefined)[] = [];

function Consumer() {
  connections.push(useUserWebConnection());
  return createElement('ConnectionConsumer', useIdentityConfirmation());
}

function confirmationFeedback(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType('ConnectionConsumer').props as ReturnType<
    typeof useIdentityConfirmation
  >;
}

function connectionTree() {
  return createElement(UserWebConnectionProvider, null, createElement(Consumer));
}

async function mountConnection(strict = false) {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    holder.renderer = TestRenderer.create(
      strict ? createElement(StrictMode, null, connectionTree()) : connectionTree()
    );
    await Promise.resolve();
  });
  if (!holder.renderer) {
    throw new Error('connection provider did not mount');
  }
  renderers.push(holder.renderer);
  return holder.renderer;
}

async function updateConnection(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.update(connectionTree());
    await Promise.resolve();
  });
}

function currentConnection() {
  const connection = connections.at(-1);
  if (!connection) {
    throw new Error('connection consumer did not mount');
  }
  return connection;
}

function currentSocket() {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error('connection did not open a socket');
  }
  return socket;
}

function beginReplacement() {
  mocks.auth.token = undefined;
  mocks.auth.isSigningOut = true;
  setSignOutTeardownActive(true);
  setSignOutActive(true);
  bumpAuthEpoch();
  beginAuthenticatedOwner();
  clearActiveToken();
}

function commitCredentials() {
  setActiveToken('account-b-token', null);
  setSignOutTeardownActive(false);
  setSignOutActive(false);
  mocks.auth.token = 'account-b-token';
  mocks.auth.isSigningOut = false;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('WebSocket', TestSocket);
  sockets.length = 0;
  connections.length = 0;
  identityCredentials.length = 0;
  ticketCredentials.length = 0;
  mocks.query.mockClear();
  mocks.auth.token = 'account-a-token';
  mocks.auth.isSigningOut = false;
  setSignOutActive(false);
  setSignOutTeardownActive(false);
  bumpAuthEpoch();
  beginAuthenticatedOwner();
  setActiveToken('account-a-token', null);
  mocks.getMe.mockReset().mockImplementation(async () => {
    const token = getActiveToken()?.token;
    identityCredentials.push(token);
    await Promise.resolve();
    return { id: token === 'account-b-token' ? 'user-b' : 'user-a' };
  });
  mocks.mutate.mockReset().mockImplementation(async () => {
    const token = getActiveToken()?.token;
    ticketCredentials.push(token);
    await Promise.resolve();
    return { token: token === 'account-b-token' ? 'ticket-b' : 'ticket-a' };
  });
});

afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
  for (const connection of connections) {
    connection.destroy();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('UserWebConnectionProvider ownership', () => {
  it('mints the ingest ticket via the createWebTicket mutation under confirmed credentials', async () => {
    await mountConnection();
    currentSocket().open();

    expect(new URL(currentSocket().url).searchParams.get('ticket')).toBe('ticket-a');
    expect(identityCredentials).toEqual(['account-a-token']);
    expect(ticketCredentials).toEqual(['account-a-token']);
    expect(getAuthenticatedOwner().userId).toBe('user-a');
    expect(currentConnection().isConnected()).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('starts no old-account work on a fresh pending mount and opens a committed successor', async () => {
    beginReplacement();
    const renderer = await mountConnection();
    expect(renderer.toJSON()).toBeNull();
    expect(identityCredentials).toEqual([]);
    expect(ticketCredentials).toEqual([]);
    expect(sockets).toHaveLength(0);

    commitCredentials();
    await updateConnection(renderer);
    currentSocket().open();
    expect(getAuthenticatedOwner().userId).toBe('user-b');
    expect(identityCredentials).toEqual(['account-b-token']);
    expect(ticketCredentials).toEqual(['account-b-token']);
    expect(currentConnection().isConnected()).toBe(true);
  });

  it.each(['replacement', 'early logout'] as const)(
    'destroys the old connection during %s even with a retained session consumer',
    async transition => {
      const renderer = await mountConnection();
      const previous = currentConnection();
      const socket = currentSocket();
      socket.open();
      const releaseSession = previous.subscribeToCliSession('old-root');
      expect(socket.frames).toContain(JSON.stringify({ type: 'subscribe', sessionId: 'old-root' }));

      act(() => {
        if (transition === 'replacement') {
          beginReplacement();
        } else {
          mocks.auth.isSigningOut = true;
          setSignOutActive(true);
          beginAuthenticatedOwner();
        }
        // Observe retirement before React unmounts the consumer or releases its retain.
        expect(socket.readyState).toBe(3);
        expect(previous.isConnected()).toBe(false);
      });
      await expect(previous.sendCommand('old-root', 'send_message', {})).rejects.toThrow(
        'Connection destroyed'
      );
      releaseSession();

      commitCredentials();
      await updateConnection(renderer);
      currentSocket().open();
      expect(currentConnection()).not.toBe(previous);
      expect(currentConnection().isConnected()).toBe(true);
      expect(new URL(currentSocket().url).searchParams.get('ticket')).toBe('ticket-b');
    }
  );

  it('rejects a late getMe response after replacement and keeps the successor identity', async () => {
    const identity = Promise.withResolvers<{ id: string }>();
    mocks.getMe.mockReturnValueOnce(identity.promise);
    const renderer = await mountConnection();
    expect(getAuthenticatedOwner().userId).toBeNull();
    expect(sockets).toHaveLength(0);

    act(beginReplacement);
    commitCredentials();
    await updateConnection(renderer);
    await act(async () => {
      identity.resolve({ id: 'user-a' });
      await identity.promise;
    });

    expect(getAuthenticatedOwner().userId).toBe('user-b');
    expect(ticketCredentials).toEqual(['account-b-token']);
    expect(sockets).toHaveLength(1);
    expect(new URL(currentSocket().url).searchParams.get('ticket')).toBe('ticket-b');
  });

  it('rejects a pending old ticket after replacement while the successor connects', async () => {
    const ticket = Promise.withResolvers<{ token: string }>();
    mocks.mutate.mockReturnValueOnce(ticket.promise);
    const renderer = await mountConnection();
    const previous = currentConnection();
    const releaseSession = previous.subscribeToCliSession('old-root');
    expect(isAuthenticatedOwner(getAuthenticatedOwner())).toBe(true);
    expect(sockets).toHaveLength(0);

    act(beginReplacement);
    commitCredentials();
    await updateConnection(renderer);
    await act(async () => {
      ticket.resolve({ token: 'late-ticket-a' });
      await ticket.promise;
    });

    expect(sockets).toHaveLength(1);
    expect(new URL(currentSocket().url).searchParams.get('ticket')).toBe('ticket-b');
    expect(previous.isConnected()).toBe(false);
    releaseSession();
  });

  it('preserves the live connection, subscription, and owner during ordinary refresh', async () => {
    const renderer = await mountConnection();
    const connection = currentConnection();
    const socket = currentSocket();
    const owner = getAuthenticatedOwner();
    socket.open();
    const releaseSession = connection.subscribeToCliSession('current-root');
    const events: string[] = [];
    const unsubscribe = connection.onSystemEvent(event => {
      events.push(event.event);
    });

    setActiveToken('account-a-refreshed-token', null);
    mocks.auth.token = 'account-a-refreshed-token';
    await updateConnection(renderer);
    socket.receive({ type: 'system', event: 'sessions.list', data: { sessions: [] } });

    expect(getAuthenticatedOwner()).toBe(owner);
    expect(currentConnection()).toBe(connection);
    expect(connection.isConnected()).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(socket.frames).toEqual([
      JSON.stringify({ type: 'subscribe', sessionId: 'current-root' }),
    ]);
    expect(events).toEqual(['sessions.list']);
    expect(identityCredentials).toEqual(['account-a-token']);
    expect(ticketCredentials).toEqual(['account-a-token']);
    unsubscribe();
    releaseSession();
  });

  it('recovers identity confirmation through the existing connection retry after a transient failure', async () => {
    mocks.getMe.mockRejectedValueOnce(new Error('offline'));
    await mountConnection();
    expect(getAuthenticatedOwner().userId).toBeNull();
    expect(sockets).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(getAuthenticatedOwner().userId).toBe('user-a');
    currentSocket().open();
    expect(currentConnection().isConnected()).toBe(true);
  });

  it('retries current confirmation without replacing the connection or duplicating pending requests', async () => {
    mocks.getMe.mockRejectedValueOnce(new Error('offline'));
    const renderer = await mountConnection();
    const connection = currentConnection();
    const releaseConsumer = connection.retain();
    expect(confirmationFeedback(renderer)).toMatchObject({ isError: true, isPending: false });
    expect(getAuthenticatedOwner().userId).toBeNull();

    const identity = Promise.withResolvers<{ id: string }>();
    mocks.getMe.mockReturnValueOnce(identity.promise);
    const retry = confirmationFeedback(renderer).retry;
    act(() => {
      retry();
      retry();
    });
    expect(confirmationFeedback(renderer)).toMatchObject({ isError: true, isPending: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.getMe).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(0);

    await act(async () => {
      identity.resolve({ id: 'user-a' });
      await identity.promise;
    });
    currentSocket().open();
    expect(confirmationFeedback(renderer)).toMatchObject({ isError: false, isPending: false });
    expect(getAuthenticatedOwner().userId).toBe('user-a');
    expect(currentConnection()).toBe(connection);
    expect(connection.isConnected()).toBe(true);
    expect(sockets).toHaveLength(1);
    releaseConsumer();
  });

  it.each(['success', 'failure'] as const)(
    'ignores stale confirmation %s and Retry after replacement',
    async outcome => {
      const identity = Promise.withResolvers<{ id: string }>();
      mocks.getMe.mockReturnValueOnce(identity.promise);
      const renderer = await mountConnection();
      const retiredRetry = confirmationFeedback(renderer).retry;
      expect(confirmationFeedback(renderer)).toMatchObject({ isError: false, isPending: true });

      act(beginReplacement);
      commitCredentials();
      await updateConnection(renderer);
      currentSocket().open();
      const owner = getAuthenticatedOwner();
      const connection = currentConnection();
      await act(async () => {
        if (outcome === 'success') {
          identity.resolve({ id: 'user-a' });
        } else {
          identity.reject(new Error('retired account failure'));
        }
        await Promise.resolve();
        retiredRetry();
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(getAuthenticatedOwner()).toBe(owner);
      expect(owner.userId).toBe('user-b');
      expect(confirmationFeedback(renderer)).toMatchObject({ isError: false, isPending: false });
      expect(currentConnection()).toBe(connection);
      expect(connection.isConnected()).toBe(true);
      expect(ticketCredentials).toEqual(['account-b-token']);
      expect(sockets).toHaveLength(1);
    }
  );

  it('keeps a current connection usable after StrictMode effect replay', async () => {
    await mountConnection(true);
    currentSocket().open();

    expect(sockets).toHaveLength(1);
    expect(getAuthenticatedOwner().userId).toBe('user-a');
    expect(currentConnection().isConnected()).toBe(true);
  });
});
