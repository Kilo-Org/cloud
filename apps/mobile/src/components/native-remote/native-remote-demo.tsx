import { type NativePresenceState, type NativeSessionSummary } from '@kilocode/cloud-agent-sdk';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import {
  type NativeRemoteClient,
  useNativeInventory,
} from '@/lib/native-remote/use-native-inventory';
import { useNativeSession } from '@/lib/native-remote/use-native-session';
import { NativeRemoteInventory } from './native-remote-inventory';
import { NativeRemoteTranscript } from './native-remote-transcript';

type NativeRemoteDemoProps = {
  client: NativeRemoteClient;
  organizationID?: string;
};

export function NativeRemoteDemo({ client, organizationID }: NativeRemoteDemoProps) {
  // Scope changes replace drafts and selections as well as their connections.
  const [owner, setOwner] = useState({ client, organizationID, generation: 0 });
  if (owner.client !== client || owner.organizationID !== organizationID) {
    setOwner({ client, organizationID, generation: owner.generation + 1 });
  }
  return (
    <NativeRemoteScreen key={owner.generation} client={client} organizationID={organizationID} />
  );
}

function NativeRemoteScreen({ client, organizationID }: NativeRemoteDemoProps) {
  const { t } = useTranslation();
  const inventory = useNativeInventory(client, organizationID);
  const [session, setSession] = useState<NativeSessionSummary>();
  const selection = useRef(0);
  const remote = useNativeSession(client, session);

  function select(next: NativeSessionSummary) {
    selection.current += 1;
    setSession(next);
  }

  async function create(instance: NativePresenceState['instances'][number], directory: string) {
    const started = selection.current;
    const created = await inventory.create(instance, directory);
    // A manual selection made during create_session wins over a late reply.
    if (created && selection.current === started) {
      select(created);
    }
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('nativeRemote.title')} />
      <TabScreenScrollView
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-4 px-4 pt-4 pb-8"
      >
        <NativeRemoteInventory
          inventory={inventory}
          select={select}
          create={(instance, directory) => void create(instance, directory)}
        />
        {session ? (
          <NativeRemoteTranscript
            key={session.sessionID}
            sessionID={session.sessionID}
            remote={remote}
          />
        ) : null}
      </TabScreenScrollView>
    </View>
  );
}
