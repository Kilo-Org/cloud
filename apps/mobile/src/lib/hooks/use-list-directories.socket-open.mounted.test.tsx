import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listDirectoriesOnConnection } from '@kilocode/cloud-agent-sdk/list-directories';
import {
  createUserWebConnection,
  type UserWebConnection,
} from '@kilocode/cloud-agent-sdk/user-web-connection';

import { act } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { useListDirectories, type UseListDirectoriesResult } from './use-list-directories';

const holder = vi.hoisted((): { connection: UserWebConnection | null } => ({ connection: null }));

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => holder.connection,
}));
vi.mock('@kilocode/cloud-agent-sdk/list-directories', () => ({
  listDirectoriesOnConnection: vi.fn(),
}));

const sockets: TestSocket[] = [];

class TestSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly frames: string[] = [];
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  send(frame: string) {
    this.frames.push(frame);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

type Probe = { current: UseListDirectoriesResult | null };

function Harness({ connectionId, probe }: { connectionId: string; probe: Probe }) {
  probe.current = useListDirectories(connectionId);
  return null;
}

const listFn = vi.mocked(listDirectoriesOnConnection);
const server = { name: 'apps', path: 'apps' };

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function firstSocket(): TestSocket {
  const socket = sockets[0];
  if (!socket) {
    throw new Error('connection did not open a socket');
  }
  return socket;
}

function currentConnection(): UserWebConnection {
  if (holder.connection === null) {
    throw new Error('connection was not created');
  }
  return holder.connection;
}

/**
 * The picker's guard must not tear down a viewer socket that is OPEN or still
 * CONNECTING when its first inbound frame has not parsed: that socket is a
 * working transport, and replacing it rejects the commands sharing the
 * connection (the picker's own `list_directories` included, plus unrelated
 * in-flight commands such as `list_models`).
 */
describe('useListDirectories with a socket the picker must not replace', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', TestSocket);
    sockets.length = 0;
    listFn.mockReset();
    holder.connection = createUserWebConnection({
      websocketUrl: 'ws://localhost:9999/api/user/web',
      getAuthToken: () => 'ticket',
    });
  });

  afterEach(() => {
    currentConnection().destroy();
    holder.connection = null;
    vi.unstubAllGlobals();
  });

  it('lists the directory without replacing the socket or rejecting a pending command', async () => {
    const connection = currentConnection();
    const release = connection.retain();
    try {
      const socket = firstSocket();
      socket.open();
      expect(connection.socketPhase()).toBe('open');
      expect(connection.isConnected()).toBe(false);

      let settled = false;
      const pending = connection.sendCommandToConnection({
        command: 'list_models',
        data: { protocolVersion: 1 },
        expectedConnectionId: 'conn-1',
      });
      const observe = async () => {
        try {
          await pending;
        } finally {
          settled = true;
        }
      };
      void observe();
      await flushMicrotasks();
      expect(socket.frames).toHaveLength(1);
      const frame: { id?: unknown } = JSON.parse(socket.frames[0] ?? '{}');
      expect(typeof frame.id).toBe('string');

      listFn.mockResolvedValue({ ok: true, path: 'src', directories: [server] });
      const probe: Probe = { current: null };
      const { unmount } = await renderWithProviders(
        createElement(Harness, { connectionId: 'conn-1', probe })
      );
      const api = () => {
        if (probe.current === null) {
          throw new Error('hook has not rendered yet');
        }
        return probe.current;
      };
      act(() => {
        api().list('src');
      });
      await waitFor(() => api().state?.phase === 'ready');

      expect(api().state).toEqual({ phase: 'ready', path: 'src', directories: [server] });
      expect(sockets).toHaveLength(1);
      expect(socket.close).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      socket.receive({ type: 'response', id: frame.id, result: { providers: [] } });
      await expect(pending).resolves.toEqual({ providers: [] });
      unmount();
    } finally {
      release();
    }
  });

  it('lists the directory while the handshake is still in flight', async () => {
    const connection = currentConnection();
    const release = connection.retain();
    try {
      const socket = firstSocket();
      expect(socket.readyState).toBe(0);
      expect(connection.socketPhase()).toBe('connecting');
      expect(connection.isConnected()).toBe(false);

      const pending = connection.sendCommandToConnection({
        command: 'list_models',
        data: { protocolVersion: 1 },
        expectedConnectionId: 'conn-1',
      });
      await flushMicrotasks();
      expect(socket.frames).toHaveLength(0);

      listFn.mockResolvedValue({ ok: true, path: 'src', directories: [server] });
      const probe: Probe = { current: null };
      const { unmount } = await renderWithProviders(
        createElement(Harness, { connectionId: 'conn-1', probe })
      );
      const api = () => {
        if (probe.current === null) {
          throw new Error('hook has not rendered yet');
        }
        return probe.current;
      };
      act(() => {
        api().list('src');
      });
      await waitFor(() => api().state?.phase === 'ready');

      expect(api().state).toEqual({ phase: 'ready', path: 'src', directories: [server] });
      expect(sockets).toHaveLength(1);
      expect(socket.close).not.toHaveBeenCalled();

      socket.open();
      await flushMicrotasks();
      expect(socket.frames).toHaveLength(1);
      const frame: { id?: unknown } = JSON.parse(socket.frames[0] ?? '{}');
      expect(typeof frame.id).toBe('string');
      socket.receive({ type: 'response', id: frame.id, result: { providers: [] } });
      await expect(pending).resolves.toEqual({ providers: [] });
      unmount();
    } finally {
      release();
    }
  });
});
