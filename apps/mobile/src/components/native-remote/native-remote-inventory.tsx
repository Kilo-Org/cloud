import { type NativePresenceState, type NativeSessionSummary } from '@kilocode/cloud-agent-sdk';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type NativeInventory } from '@/lib/native-remote/use-native-inventory';
import { NativeRemoteSessionList } from './native-remote-lists';

type Instance = NativePresenceState['instances'][number];

const connectionKeys = {
  connecting: 'common.starting',
  connected: 'common.connected',
  disconnected: 'common.notConnected',
} as const;

export function NativeRemoteInventory({
  inventory,
  select,
  create,
}: {
  inventory: NativeInventory;
  select: (session: NativeSessionSummary) => void;
  create: (instance: Instance, directory: string) => void;
}) {
  const { t } = useTranslation();
  const [instanceID, setInstanceID] = useState('');
  const online = inventory.presence.instances.filter(instance => instance.online);
  const selected = online.find(instance => instance.instanceID === instanceID);
  return (
    <View className="gap-4">
      <Text accessibilityRole="header">{t('todos.segment.sessions')}</Text>
      {inventory.loading && inventory.sessions.length === 0 ? (
        <Skeleton className="h-24 rounded-md" />
      ) : null}
      {!inventory.loading && inventory.sessions.length === 0 ? (
        <Text>{t('nativeRemote.sessionsEmpty')}</Text>
      ) : null}
      {inventory.sessions.length > 0 ? (
        <NativeRemoteSessionList sessions={inventory.sessions} select={select} />
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={inventory.loading}
          onPress={() => void inventory.load()}
        >
          <Text>{t('common.refresh')}</Text>
        </Button>
        {inventory.cursor ? (
          <Button
            variant="outline"
            disabled={inventory.loading}
            onPress={() => void inventory.load(inventory.cursor ?? undefined)}
          >
            <Text>{t('common.loadMore')}</Text>
          </Button>
        ) : null}
      </View>
      {inventory.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {inventory.error}
        </Text>
      ) : null}
      <Text accessibilityRole="header">{t('nativeRemote.hosts')}</Text>
      <Text className="text-muted-foreground">
        {t('nativeRemote.presenceStatus', {
          connection: t(connectionKeys[inventory.presence.connection]),
        })}
      </Text>
      {inventory.presence.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {inventory.presence.error}
        </Text>
      ) : null}
      {online.length === 0 ? <Text>{t('nativeRemote.hostsEmpty')}</Text> : null}
      {online.map(instance => (
        <Button
          key={instance.instanceID}
          variant={instanceID === instance.instanceID ? 'secondary' : 'outline'}
          accessibilityRole="radio"
          accessibilityState={{ checked: instanceID === instance.instanceID }}
          onPress={() => {
            setInstanceID(instance.instanceID);
          }}
        >
          <Text className="min-w-0 flex-1" numberOfLines={2}>
            {instance.advertisement.name} · {instance.advertisement.projectName}
          </Text>
        </Button>
      ))}
      {selected ? (
        <CreateSession
          key={selected.instanceID}
          instance={selected}
          creating={inventory.creating}
          create={create}
        />
      ) : null}
    </View>
  );
}

function CreateSession({
  instance,
  creating,
  create,
}: {
  instance: Instance;
  creating: boolean;
  create: (instance: Instance, directory: string) => void;
}) {
  const { t } = useTranslation();
  const directory = useRef('');
  return (
    <View className="gap-2">
      <Input
        accessibilityLabel={t('nativeRemote.directory')}
        placeholder={t('nativeRemote.directory')}
        autoCapitalize="none"
        autoCorrect={false}
        defaultValue=""
        onChangeText={text => {
          directory.current = text;
        }}
      />
      <Button
        disabled={creating}
        loading={creating}
        onPress={() => {
          create(instance, directory.current);
        }}
      >
        <Text>{t('nativeRemote.createSession')}</Text>
      </Button>
    </View>
  );
}
