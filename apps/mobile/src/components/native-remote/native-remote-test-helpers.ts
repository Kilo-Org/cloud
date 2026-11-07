import {
  type NativePresenceConnection,
  type NativePresenceState,
  type NativeSessionConnection,
  type NativeSessionState,
  type NativeSyncClient,
} from '@kilocode/cloud-agent-sdk';
import { type Mock, vi } from 'vitest';

export const onlineHost: NativePresenceState['instances'][number] = {
  instanceID: 'host-owned',
  tenant: { type: 'user', id: 'fake-user' },
  online: true,
  advertisement: { name: 'Owned host', projectName: 'Sample', kind: 'remote', sessions: [] },
};
export const readySession: NativeSessionState = {
  connection: 'connected',
  runnerConnected: true,
  session: { id: 'ses-first', origin: { directory: '/sample' }, time: { created: 1, updated: 1 } },
  messages: [
    {
      message: {
        id: 'msg_snapshot',
        type: 'assistant',
        time: { created: 1 },
        content: [{ type: 'text', text: 'Snapshot hello' }],
      },
      seq: 1,
    },
  ],
  pending: { permissions: [], questions: [] },
  events: [],
  commands: {},
};
export const summary = {
  sessionID: 'ses-first',
  tenant: onlineHost.tenant,
  live: true,
  createdAt: 1,
};

type SessionConnectionMock = {
  [Key in keyof NativeSessionConnection]: Mock<NativeSessionConnection[Key]>;
};

function sessionConnection() {
  return {
    sendMessage: vi
      .fn<NativeSessionConnection['sendMessage']>()
      .mockResolvedValue('prompt-command'),
    interrupt: vi.fn<NativeSessionConnection['interrupt']>().mockResolvedValue('abort-command'),
    respondPermission: vi
      .fn<NativeSessionConnection['respondPermission']>()
      .mockResolvedValue('permission-command'),
    replyQuestion: vi
      .fn<NativeSessionConnection['replyQuestion']>()
      .mockResolvedValue('question-command'),
    rejectQuestion: vi
      .fn<NativeSessionConnection['rejectQuestion']>()
      .mockResolvedValue('reject-command'),
    sendCommand: vi.fn<NativeSessionConnection['sendCommand']>().mockResolvedValue('slash-command'),
    getCommandStatus: vi
      .fn<NativeSessionConnection['getCommandStatus']>()
      .mockResolvedValue('delivered'),
    clear: vi.fn(),
    close: vi.fn(),
  };
}

export function nativeRemoteFixture() {
  let presenceListener: ((state: NativePresenceState) => void) | undefined = undefined;
  const sessionListeners = new Map<string, (state: NativeSessionState) => void>();
  const connections = new Map<string, SessionConnectionMock>();
  const presence = {
    close: vi.fn(),
    command: vi.fn<NativePresenceConnection['command']>().mockResolvedValue({
      commandID: 'create-command',
      instanceID: onlineHost.instanceID,
      status: 'replied',
      body: { status: 'succeeded', result: { sessionID: 'ses-created' } },
    }),
  };
  const api = {
    listSessions: vi
      .fn<NativeSyncClient['listSessions']>()
      .mockResolvedValue({ items: [summary], cursor: null }),
    connectPresence: vi.fn<NativeSyncClient['connectPresence']>().mockImplementation(listener => {
      presenceListener = listener;
      return presence;
    }),
    connectSession: vi
      .fn<NativeSyncClient['connectSession']>()
      .mockImplementation((sessionID, listener) => {
        const connection = sessionConnection();
        connections.set(sessionID, connection);
        sessionListeners.set(sessionID, listener);
        return connection;
      }),
  };
  return {
    client: api,
    api,
    presence,
    publishPresence: (state: NativePresenceState) => presenceListener?.(state),
    publishSession: (sessionID: string, state: NativeSessionState) =>
      sessionListeners.get(sessionID)?.(state),
    connection: (sessionID: string) => {
      const connection = connections.get(sessionID);
      if (!connection) {
        throw new Error(`Session not connected: ${sessionID}`);
      }
      return connection;
    },
  };
}
