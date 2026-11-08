import { useRef, useState } from 'react';
import { type TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { Skeleton } from '@/components/ui/skeleton';
import { transcriptText } from '@/lib/native-remote/projections';
import { type NativeRemoteSession } from '@/lib/native-remote/use-native-session';
import { NativeRemoteQuestion } from './native-remote-question';
import { NativeRemoteMessages } from './native-remote-lists';

const connectionKeys = {
  connecting: 'common.starting',
  connected: 'common.connected',
  disconnected: 'common.notConnected',
} as const;
const commandKeys = {
  queued: 'common.queued',
  delivered: 'nativeRemote.delivered',
  expired: 'nativeRemote.expired',
} as const;

export function NativeRemoteTranscript({
  sessionID,
  remote,
}: {
  sessionID: string;
  remote: NativeRemoteSession;
}) {
  const { t } = useTranslation();
  const { state, conversation, pending, canControl } = remote;
  const commandStatus = state?.commands[remote.commandID];
  const loading = !state || conversation?.loading;
  return (
    <View className="gap-3 border-t border-border pt-4">
      <Text accessibilityRole="header" selectable className="font-mono text-sm">
        {sessionID}
      </Text>
      <Text accessibilityLiveRegion="polite" className="text-muted-foreground">
        {t('nativeRemote.status', {
          connection: t(connectionKeys[state?.connection ?? 'connecting']),
          runner: state?.runnerConnected ? t('common.online') : t('chat.botStatus.offline'),
        })}
      </Text>
      {loading && <Skeleton className="h-80 rounded-md" />}
      {!loading &&
        conversation?.session &&
        (conversation.messages.length > 0 || conversation.incompleteMessageIDs.length === 0) && (
          <NativeRemoteMessages messages={conversation.messages} />
        )}
      {pending.permissions.map(permission => (
        <View key={permission.id} className="gap-2 rounded-lg border border-border p-3">
          <Text>{permission.action}</Text>
          <Text selectable>{permission.resources.join('\n')}</Text>
          {permission.message ? <Text>{permission.message}</Text> : null}
          <View className="flex-row flex-wrap gap-2">
            <Button
              disabled={!canControl}
              onPress={() =>
                void remote.run(connection => connection.respondPermission(permission.id, 'once'))
              }
            >
              <Text>{t('agentChat.permissionCard.allowOnce')}</Text>
            </Button>
            <Button
              variant="outline"
              disabled={!canControl}
              onPress={() =>
                void remote.run(connection => connection.respondPermission(permission.id, 'always'))
              }
            >
              <Text>{t('agentChat.permissionCard.alwaysAllow')}</Text>
            </Button>
            <Button
              variant="outline"
              disabled={!canControl}
              onPress={() =>
                void remote.run(connection => connection.respondPermission(permission.id, 'reject'))
              }
            >
              <Text>{t('agentChat.permissionCard.deny')}</Text>
            </Button>
          </View>
        </View>
      ))}
      {pending.questions.map(question => (
        <NativeRemoteQuestion
          key={`${question.id}:${JSON.stringify(question.fields)}`}
          question={question}
          disabled={!canControl}
          reply={answers =>
            void remote.run(connection => connection.replyQuestion(question.id, answers))
          }
          reject={() => void remote.run(connection => connection.rejectQuestion(question.id))}
        />
      ))}
      <NativeRemoteComposer remote={remote} />
      {remote.error || conversation?.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {remote.error || conversation?.error}
        </Text>
      ) : null}
      {commandStatus ? (
        <Text accessibilityLiveRegion="polite">
          {t('nativeRemote.commandStatus', { status: t(commandKeys[commandStatus]) })}
        </Text>
      ) : null}
      {state?.events
        .filter(event => event.type === 'command.outcome')
        .map(event => (
          <Text key={event.seq} selectable className="text-xs text-muted-foreground">
            {transcriptText(event.body)}
          </Text>
        ))}
    </View>
  );
}

function NativeRemoteComposer({ remote }: { remote: NativeRemoteSession }) {
  const { t } = useTranslation();
  const prompt = useRef('');
  const input = useRef<TextInput>(null);
  const [hasText, setHasText] = useState(false);
  const [queue, setQueue] = useState(false);
  async function submit() {
    const submitted = prompt.current;
    if (!submitted.trim()) {
      return;
    }
    const sent = await remote.send(submitted, queue);
    // Do not erase typing that happened while the command was being admitted.
    if (sent && prompt.current === submitted) {
      prompt.current = '';
      input.current?.clear();
      setHasText(false);
    }
  }
  return (
    <View className="gap-3">
      <Input
        ref={input}
        accessibilityLabel={t('nativeRemote.prompt')}
        placeholder={t('nativeRemote.prompt')}
        defaultValue=""
        multiline
        className="min-h-[96px] leading-[1.25rem]"
        autoCapitalize="sentences"
        onChangeText={text => {
          prompt.current = text;
          setHasText(Boolean(text.trim()));
        }}
      />
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1">{t('nativeRemote.queueIfOffline')}</Text>
        <Switch
          accessibilityLabel={t('nativeRemote.queueIfOffline')}
          value={queue}
          onValueChange={setQueue}
        />
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button
          disabled={!hasText || remote.busy}
          loading={remote.busy}
          onPress={() => void submit()}
        >
          <Text>{t('common.sendMessage')}</Text>
        </Button>
        <Button
          variant="outline"
          disabled={!remote.canControl}
          onPress={() => void remote.run(connection => connection.interrupt())}
        >
          <Text>{t('nativeRemote.abort')}</Text>
        </Button>
        <Button
          variant="outline"
          onPress={() => {
            remote.clear();
          }}
        >
          <Text>{t('nativeRemote.localClear')}</Text>
        </Button>
      </View>
    </View>
  );
}
