import {
  type NativePresenceConnection,
  type NativeSessionConnection,
  type NativeSessionState,
  type NativeSessionSummary,
  NativeSyncClient,
} from '@kilocode/cloud-agent-sdk';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { NativeRemoteDemo } from '@/components/native-remote/native-remote-demo';
import { NativeRemoteTranscript } from '@/components/native-remote/native-remote-transcript';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useAuth } from '@/lib/auth/auth-context';
import { SESSION_SYNC_URL } from '@/lib/config';
import { nativeRemoteCredential } from '@/lib/native-remote-credential';
import { useNativeSession } from '@/lib/native-remote/use-native-session';
import { useOrganization } from '@/lib/organization-context';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Development-only transcript fixtures, opened as
 * `native-remote?nativeRemoteFixture=reconnecting|gaps`.
 *
 * `reconnecting` publishes a loaded transcript whose connection dropped before
 * the retry could land, the settled form of the reconnecting surface: `Not
 * connected` in the status line, the transcript still rendered. `gaps`
 * publishes a transcript with two missing parts, and its Retry republishes the
 * same transcript whole. Both go through `connectSession`'s listener, the same
 * path a live socket drives, so the run proves the fix end to end. A
 * production build never reaches this code: `__DEV__` refuses first.
 */
type NativeFixtureName = 'reconnecting' | 'gaps';

const fixtureSummary: NativeSessionSummary = {
  sessionID: 'ses-fixture',
  tenant: { type: 'user', id: 'fixture-owner' },
  live: true,
  createdAt: 1,
};
const emptyPending = { permissions: [], questions: [], unreadablePermissions: [] };

function fixtureState(name: NativeFixtureName): NativeSessionState {
  if (name === 'reconnecting') {
    return {
      connection: 'disconnected',
      runnerConnected: false,
      session: {
        id: fixtureSummary.sessionID,
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
      id: fixtureSummary.sessionID,
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
    close: () => undefined,
  };
}

function fixtureClient(name: NativeFixtureName) {
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
    listSessions: () => Promise.resolve({ items: [fixtureSummary], cursor: null }),
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

function FixtureNativeRemote({ fixture }: { fixture: NativeFixtureName }) {
  const { t } = useTranslation();
  const client = useMemo(() => fixtureClient(fixture), [fixture]);
  const remote = useNativeSession(client, fixtureSummary);
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('nativeRemote.title')} />
      <TabScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-4 pt-4 pb-8">
        <NativeRemoteTranscript sessionID={fixtureSummary.sessionID} remote={remote} />
      </TabScreenScrollView>
    </View>
  );
}

function fixtureName(value: string | string[] | undefined): NativeFixtureName | undefined {
  return value === 'reconnecting' || value === 'gaps' ? value : undefined;
}

function OwnedNativeRemoteDemo({
  epoch,
  baseUrl,
  organizationID,
}: {
  epoch: number;
  baseUrl: string;
  organizationID: string | undefined;
}) {
  const client = useMemo(
    () => new NativeSyncClient({ baseUrl, getCredential: () => nativeRemoteCredential(epoch) }),
    [baseUrl, epoch]
  );
  return <NativeRemoteDemo client={client} organizationID={organizationID} />;
}

export function NativeRemoteEntryScreen() {
  const { token, authEpoch, isSigningOut } = useAuth();
  const { organizationId, isLoaded } = useOrganization();
  const { nativeRemoteFixture } = useLocalSearchParams<{ nativeRemoteFixture?: string }>();
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  const fixture = fixtureName(nativeRemoteFixture);
  if (fixture) {
    return <FixtureNativeRemote fixture={fixture} />;
  }
  if (!SESSION_SYNC_URL || !token || isSigningOut) {
    return <Redirect href="/" />;
  }
  if (!isLoaded) {
    return <Skeleton className="m-4 h-48" />;
  }
  return (
    <OwnedNativeRemoteDemo
      key={authEpoch}
      epoch={authEpoch}
      baseUrl={SESSION_SYNC_URL}
      organizationID={organizationId ?? undefined}
    />
  );
}
