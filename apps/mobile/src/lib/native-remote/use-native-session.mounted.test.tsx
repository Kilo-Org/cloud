import {
  type NativeSessionConnection,
  type NativeSessionState,
  type NativeSessionSummary,
} from '@kilocode/cloud-agent-sdk';
import { createElement, useLayoutEffect } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';
import { type NativeRemoteClient } from './use-native-inventory';
import { type NativeRemoteSession, useNativeSession } from './use-native-session';

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

function fixture() {
  const listeners: ((state: NativeSessionState) => void)[] = [];
  const connection = {
    close: vi.fn(),
    clear: vi.fn(),
    sendMessage: vi.fn<NativeSessionConnection['sendMessage']>().mockResolvedValue('old-command'),
    interrupt: vi.fn<NativeSessionConnection['interrupt']>(),
    respondPermission: vi.fn<NativeSessionConnection['respondPermission']>(),
    replyQuestion: vi.fn<NativeSessionConnection['replyQuestion']>(),
    rejectQuestion: vi.fn<NativeSessionConnection['rejectQuestion']>(),
    sendCommand: vi.fn<NativeSessionConnection['sendCommand']>(),
    getCommandStatus: vi.fn<NativeSessionConnection['getCommandStatus']>(),
  };
  const client: NativeRemoteClient = {
    listSessions: vi.fn<NativeRemoteClient['listSessions']>(),
    connectPresence: vi.fn<NativeRemoteClient['connectPresence']>(),
    connectSession: vi.fn<NativeRemoteClient['connectSession']>((_id, listener) => {
      listeners.push(listener);
      return connection;
    }),
  };
  return { client, connection, listeners };
}

const session: NativeSessionSummary = {
  sessionID: 'old-session',
  tenant: { type: 'organization', id: 'old-organization' },
  createdAt: 1,
  live: true,
};
const connected: NativeSessionState = {
  connection: 'connected',
  runnerConnected: true,
  messages: [],
  pending: {
    permissions: [{ id: 'old-permission', action: 'shell', resources: [] }],
    questions: [],
  },
  events: [],
  commands: { 'old-command': 'delivered' },
};

describe('native session ownership', () => {
  it.each(['session', 'organization', 'client'] as const)(
    'never commits the old transcript or controls under a new %s',
    async changed => {
      const original = fixture();
      const replacement = fixture();
      const commits: NativeRemoteSession[] = [];
      const published: { current?: NativeRemoteSession } = {};
      function Harness(props: { client: NativeRemoteClient; selected: NativeSessionSummary }) {
        const value = useNativeSession(props.client, props.selected);
        published.current = value;
        useLayoutEffect(() => {
          commits.push(value);
        });
        return null;
      }
      function remote() {
        if (!published.current) {
          throw new Error('Session hook did not mount');
        }
        return published.current;
      }
      const holder: { current?: TestRenderer.ReactTestRenderer } = {};
      act(() => {
        holder.current = TestRenderer.create(
          createElement(Harness, { client: original.client, selected: session })
        );
      });
      const renderer = holder.current;
      const listener = original.listeners[0];
      if (!renderer || !listener) {
        throw new Error('Session did not connect');
      }
      act(() => {
        listener(connected);
      });
      await act(async () => {
        await remote().send('hello', false);
      });
      expect(remote().commandID).toBe('old-command');
      expect(remote().canControl).toBe(true);
      original.connection.sendMessage.mockRejectedValueOnce(new Error('old-error'));
      await act(async () => {
        await remote().send('fail', false);
      });
      expect(remote().error).toBe('old-error');
      commits.length = 0;
      act(() => {
        renderer.update(
          createElement(Harness, {
            client: changed === 'client' ? replacement.client : original.client,
            selected: {
              ...session,
              sessionID: changed === 'session' ? 'new-session' : session.sessionID,
              tenant: {
                type: 'organization',
                id: changed === 'organization' ? 'new-organization' : session.tenant.id,
              },
            },
          })
        );
      });
      expect(commits.length).toBeGreaterThan(0);
      for (const committed of commits) {
        expect(committed.state).toBeUndefined();
        expect(committed.commandID).toBe('');
        expect(committed.error).toBe('');
        expect(committed.busy).toBe(false);
        expect(committed.canControl).toBe(false);
        expect(committed.pending).toEqual({ permissions: [], questions: [] });
      }
      act(() => {
        listener(connected);
      });
      expect(remote().state).toBeUndefined();
      expect(original.connection.close).toHaveBeenCalledOnce();
      act(() => {
        renderer.unmount();
      });
    }
  );

  it('admits one command before React rerenders and reuses unchanged pending inventory', async () => {
    const original = fixture();
    const deferred = Promise.withResolvers<string>();
    original.connection.sendMessage.mockReturnValueOnce(deferred.promise);
    const published: { current?: NativeRemoteSession } = {};
    function Harness() {
      published.current = useNativeSession(original.client, session);
      return null;
    }
    function remote() {
      if (!published.current) {
        throw new Error('Session hook did not mount');
      }
      return published.current;
    }
    const holder: { current?: TestRenderer.ReactTestRenderer } = {};
    act(() => {
      holder.current = TestRenderer.create(createElement(Harness));
    });
    const renderer = holder.current;
    const listener = original.listeners[0];
    if (!renderer || !listener) {
      throw new Error('Session did not connect');
    }
    act(() => {
      listener(connected);
    });
    const pending = remote().pending;
    const commands: { first?: Promise<boolean>; second?: Promise<boolean> } = {};
    act(() => {
      const current = remote();
      commands.first = current.send('first', false);
      commands.second = current.send('second', false);
    });
    expect(original.connection.sendMessage).toHaveBeenCalledOnce();
    await expect(commands.second).resolves.toBe(false);
    expect(remote().pending).toBe(pending);
    await act(async () => {
      deferred.resolve('first-command');
      await commands.first;
    });
    expect(remote().busy).toBe(false);
    await act(async () => {
      expect(await remote().send('next', false)).toBe(true);
    });
    expect(original.connection.sendMessage).toHaveBeenCalledTimes(2);
    act(() => {
      renderer.unmount();
    });
  });
});
