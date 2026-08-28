/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free renderer mounts the real provider and socket adapter */
/* eslint-disable promise/prefer-await-to-then -- race tests attach rejection handlers before changing the owner */
import { createElement, useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { beginAuthenticatedOwner, confirmAuthenticatedOwner } from '@/lib/context-scope';
import {
  initializeLocalAccess,
  setLocalAccessContextReady,
  setLocalAccessOwner,
} from '@/lib/local-access';
import { type MobileUserWebConnection } from '@/lib/local-access-transport';
import { UserWebConnectionProvider, useUserWebConnection } from './user-web-connection-provider';

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@/lib/config', () => ({ SESSION_INGEST_WS_URL: 'wss://ingest.example.com' }));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: () => ({}),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ isReady: true, organizationId: 'org-A' }),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: { activeSessions: { createWebTicket: { mutate: mocks.mutate } } },
}));

type Frame = { type: string; id?: string; command?: string };
const sockets: Socket[] = [];
class Socket {
  static OPEN = 1;
  readonly url: string;
  readyState = 0;
  closeRequested = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  frames: Frame[] = [];
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  send(value: string) {
    this.frames.push(JSON.parse(value) as Frame);
  }
  // Model an OS socket that remains physically open after close was requested.
  close() {
    this.closeRequested = true;
  }
}
let stop: (() => void) | undefined = undefined;
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let connection: MobileUserWebConnection | undefined = undefined;
const events: string[] = [];
function Probe() {
  const current = useUserWebConnection();
  connection = current;
  useEffect(
    () =>
      current.onSystemEvent(() => {
        events.push(current.owner.userId ?? 'none');
      }),
    [current]
  );
  return null;
}
beforeEach(async () => {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sockets.length = 0;
  events.length = 0;
  connection = undefined;
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'A');
  stop = initializeLocalAccess({
    storage: {
      read: vi.fn().mockResolvedValue({ status: 'absent' }),
      write: vi.fn().mockResolvedValue('committed'),
    },
    authenticate: vi.fn().mockResolvedValue({ status: 'authenticated' }),
    lifecycle: { getCurrentState: () => 'active', subscribe: () => () => undefined },
  });
  await setLocalAccessOwner('A', currentAuthEpoch());
  setLocalAccessContextReady(true);
  mocks.mutate
    .mockReset()
    .mockImplementation(
      async (_input, options: { context: { localAccessOwner: { userId: string } } }) => {
        await Promise.resolve();
        return { token: `ticket-${options.context.localAccessOwner.userId}` };
      }
    );
});
afterEach(async () => {
  await act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  connection?.destroy();
  stop?.();
  vi.unstubAllGlobals();
});
function socketAt(index: number) {
  const socket = sockets.at(index);
  if (!socket) {
    throw new Error('Expected socket was not constructed');
  }
  return socket;
}
async function mount() {
  await act(() => {
    renderer = TestRenderer.create(
      createElement(UserWebConnectionProvider, null, createElement(Probe))
    );
  });
  await vi.waitFor(() => {
    expect(sockets).toHaveLength(1);
  });
  return socketAt(0);
}
async function replace() {
  await act(async () => {
    bumpAuthEpoch();
    confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'B');
    await setLocalAccessOwner('B', currentAuthEpoch());
    setLocalAccessContextReady(true);
  });
}
function currentConnection() {
  if (!connection) {
    throw new Error('Provider did not publish a connection');
  }
  return connection;
}

describe('immutable user-web socket ownership', () => {
  it('mints the ingest ticket and opens the socket for the captured owner', async () => {
    const socket = await mount();
    expect(new URL(socket.url).searchParams.get('ticket')).toBe('ticket-A');
    expect(currentConnection().owner.userId).toBe('A');
  });
  it('rejects pending A commands and fences late A events before B uses a new socket', async () => {
    const a = await mount();
    a.open();
    const old = currentConnection();
    const pending = Promise.allSettled([old.sendCommand('session-A', 'interrupt', {})]);
    await vi.waitFor(() => {
      expect(a.frames.some(frame => frame.command === 'interrupt')).toBe(true);
    });
    const lateMessage = a.onmessage;
    await replace();
    expect(a.closeRequested).toBe(true);
    expect(a.readyState).toBe(Socket.OPEN);
    expect(await pending).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'Connection destroyed' }) },
    ]);
    const b = socketAt(1);
    b.open();
    const system = { type: 'system', event: 'sessions.list', data: { sessions: [] } };
    lateMessage?.({ data: JSON.stringify(system) });
    b.receive(system);
    expect(events).toEqual(['B']);
    const bResult = currentConnection().sendCommand('session-B', 'interrupt', {});
    await vi.waitFor(() => {
      expect(b.frames.some(frame => frame.command === 'interrupt')).toBe(true);
    });
    const command = b.frames.find(frame => frame.command === 'interrupt');
    b.receive({ type: 'response', id: command?.id, result: { acceptedBy: 'B' } });
    await expect(bResult).resolves.toEqual({ acceptedBy: 'B' });
    expect(a.frames.filter(frame => frame.type === 'command')).toHaveLength(1);
    await expect(old.sendCommand('session-B', 'interrupt', {})).rejects.toMatchObject({
      code: 'LOCAL_ACCESS_DENIED',
    });
  });
  it('invalidates a delayed A ticket without connecting it under B', async () => {
    const ticket = Promise.withResolvers<{ token: string }>();
    mocks.mutate.mockReturnValueOnce(ticket.promise);
    await act(() => {
      renderer = TestRenderer.create(
        createElement(UserWebConnectionProvider, null, createElement(Probe))
      );
    });
    expect(sockets).toHaveLength(0);
    await replace();
    ticket.resolve({ token: 'late-A-ticket' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sockets).toHaveLength(1);
    expect(new URL(socketAt(0).url).searchParams.get('ticket')).toBe('ticket-B');
  });
  it('does not renew a command after lock/unlock during waitForOpen', async () => {
    const access = await import('@/lib/local-access');
    const socket = await mount();
    await access.requestLocalAccess('enable');
    const pending = Promise.allSettled([
      currentConnection().sendCommand('session-A', 'interrupt', {}),
    ]);
    access.lockLocalAccess();
    await access.requestLocalAccess('unlock');
    socket.open();
    expect(await pending).toEqual([
      { status: 'rejected', reason: expect.any(access.LocalAccessDeniedError) },
    ]);
    expect(socket.frames.filter(frame => frame.type === 'command')).toEqual([]);
  });
  it.each(['bound', 'explicit'] as const)(
    'retains the %s command context through a socket wait',
    async source => {
      const transport = await import('@/lib/local-access-transport');
      const access = await import('@/lib/local-access');
      const capture = transport.captureMobileActionAdmission;
      const scopedAuthority = vi
        .spyOn(transport, 'captureMobileActionAdmission')
        .mockImplementation((owner, organizationId) => {
          if (organizationId !== 'target-org') {
            throw new access.LocalAccessDeniedError('context');
          }
          return capture(owner, organizationId);
        });
      try {
        const socket = await mount();
        const current = currentConnection();
        current.setSessionScope('session-A', source === 'bound' ? 'target-org' : 'source-org');
        const command = source === 'bound' ? 'interrupt' : 'create_session';
        const data = source === 'bound' ? {} : { orgId: 'target-org' };
        const pending = current.sendCommand('session-A', command, data);
        current.setSessionScope('session-A', 'later-org');
        socket.open();
        await vi.waitFor(() => {
          expect(socket.frames.some(frame => frame.command === command)).toBe(true);
        });
        const frame = socket.frames.find(value => value.command === command);
        socket.receive({ type: 'response', id: frame?.id, result: { accepted: true } });
        await expect(pending).resolves.toEqual({ accepted: true });
      } finally {
        scopedAuthority.mockRestore();
      }
    }
  );
});
