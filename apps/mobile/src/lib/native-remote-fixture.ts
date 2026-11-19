/**
 * Development-only transcript fixtures for the native remote demo.
 * `kiloapp:///dev/native-remote-fixture/reconnecting` and `.../gaps` are the
 * only entry points (`+native-intent.tsx`, behind `__DEV__`).
 *
 * `reconnecting` publishes a loaded transcript whose connection dropped before
 * the retry could land, the settled form of the reconnecting surface: `Not
 * connected` in the status line, the transcript still rendered. `gaps`
 * publishes a transcript with two missing parts, and its Retry republishes the
 * same transcript whole. Both go through `connectSession`'s listener, the same
 * path a live socket drives, so a run shows the fix end to end. A production
 * build never reaches this code: `__DEV__` refuses in the handler.
 */
import {
  type NativePresenceConnection,
  type NativeSessionConnection,
  type NativeSessionState,
  type NativeSessionSummary,
} from '@kilocode/cloud-agent-sdk';

export type NativeRemoteFixtureName = 'reconnecting' | 'gaps';

const FIXTURE_PATH = /(?:^|\/)dev\/native-remote-fixture\/(reconnecting|gaps)\/?$/;

export const nativeRemoteFixtureSummary: NativeSessionSummary = {
  sessionID: 'ses-fixture',
  tenant: { type: 'user', id: 'fixture-owner' },
  live: true,
  createdAt: 1,
};

const emptyPending = { permissions: [], questions: [], unreadablePermissions: [] };

function fixtureState(name: NativeRemoteFixtureName): NativeSessionState {
  if (name === 'reconnecting') {
    return {
      connection: 'disconnected',
      runnerConnected: false,
      session: {
        id: nativeRemoteFixtureSummary.sessionID,
        origin: { directory: '/fixture' },
        time: { created: 1, updated: 3 },
      },
      snapshot: { position: 1, revision: 1 },
      messages: [
        {
          seq: 1,
          message: {
            id: 'msg_fixture_dropped',
            type: 'assistant',
            time: { created: 1, completed: 2 },
            content: [{ type: 'text', text: 'Fixture reply before the connection dropped.' }],
          },
        },
      ],
      pending: emptyPending,
      events: [],
      commands: {},
    };
  }
  return {
    connection: 'connected',
    runnerConnected: true,
    session: {
      id: nativeRemoteFixtureSummary.sessionID,
      origin: { directory: '/fixture' },
      time: { created: 1, updated: 3 },
    },
    snapshot: { position: 3, revision: 3 },
    messages: [
      {
        seq: 1,
        message: {
          id: 'msg_fixture_complete',
          type: 'assistant',
          time: { created: 1, completed: 2 },
          content: [{ type: 'text', text: 'Fixture reply already on screen.' }],
        },
      },
      {
        seq: 2,
        incomplete: true,
        message: { id: 'msg_fixture_gap_a', type: 'assistant', time: { created: 2 }, content: [] },
      },
      {
        seq: 3,
        incomplete: true,
        message: { id: 'msg_fixture_gap_b', type: 'assistant', time: { created: 3 }, content: [] },
      },
    ],
    pending: emptyPending,
    events: [],
    commands: {},
  };
}

function fixtureConnection(
  publish: (state: NativeSessionState) => void,
  healed: NativeSessionState
): NativeSessionConnection {
  const command = () => Promise.resolve('fixture-command');
  return {
    sendMessage: command,
    interrupt: command,
    respondPermission: command,
    replyQuestion: command,
    rejectQuestion: command,
    sendCommand: command,
    getCommandStatus: () => Promise.resolve('delivered'),
    // The retry fills the two missing parts without reconnecting.
    requestRecovery: () => {
      publish(healed);
      return Promise.resolve();
    },
    clear: () => undefined,
    refresh: () => undefined,
    close: () => undefined,
  };
}

export function nativeRemoteFixtureClient(name: NativeRemoteFixtureName) {
  const initial = fixtureState(name);
  const healed: NativeSessionState = {
    ...initial,
    messages: initial.messages.filter(item => !item.incomplete),
  };
  const presence: NativePresenceConnection = {
    command: instanceID =>
      Promise.resolve({ commandID: 'fixture-command', instanceID, status: 'unknown' as const }),
    close: () => undefined,
  };
  return {
    listSessions: () => Promise.resolve({ items: [nativeRemoteFixtureSummary], cursor: null }),
    connectPresence: () => presence,
    connectSession: (
      _sessionID: string,
      listener: (state: NativeSessionState) => void
    ): NativeSessionConnection => {
      listener(initial);
      return fixtureConnection(listener, healed);
    },
  };
}

/**
 * Handle a fixture link. The matched route string when the path is a fixture
 * link, so the caller navigates there; falsy when it is not.
 */
export function nativeRemoteFixtureRoute(path: string): `/(app)/native-remote` | undefined {
  const name = FIXTURE_PATH.exec(path)?.[1] as NativeRemoteFixtureName | undefined;
  if (!name || !__DEV__) {
    return undefined;
  }
  activeFixture = name;
  return '/(app)/native-remote';
}

let activeFixture: NativeRemoteFixtureName | undefined = undefined;

/**
 * The fixture the handler link selected for this dev session. A link's
 * selection is process-global and sticky; the entry screen's live route
 * parameter wins when both name a state, so navigation order does not matter.
 */
export function readNativeRemoteFixture(): NativeRemoteFixtureName | undefined {
  return activeFixture;
}
