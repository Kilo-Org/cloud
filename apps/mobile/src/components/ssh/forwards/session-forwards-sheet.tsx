import { type TFunction } from 'i18next';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Globe, Plug, PlugZap, Square } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { openExternalUrl } from '@/lib/external-link';
import { forwardErrorMessage } from '@/lib/ssh/files/error-copy';
import { forwardLabel, type SshForward } from '@/lib/ssh/forwards';
import {
  type ForwardStatus,
  isHttpForward,
  localForwardUrl,
  startForward,
  stopForward,
} from '@/lib/ssh/forwards-runtime';
import { sshHostPath } from '@/lib/ssh/routes';
import { useForwardStatuses, useSshForwards } from '@/lib/ssh/use-forwards';

type SessionForwardsSheetProps = Readonly<{
  visible: boolean;
  hostId: string;
  /** The app session the listeners run on. */
  sessionId: string;
  /** The session's connection; null while it is not up. */
  nativeSessionId: string | null;
  onClose: () => void;
}>;

/**
 * The host's stored forwards and what each one is doing on this session. A
 * listening local forward that serves HTTP opens in the in-app browser.
 */
export function SessionForwardsSheet({
  visible,
  hostId,
  sessionId,
  nativeSessionId,
  onClose,
}: SessionForwardsSheetProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const forwards = useSshForwards(hostId);
  const statuses = useForwardStatuses(sessionId);
  const connected = nativeSessionId !== null;

  let body = null;
  if (forwards.isPending) {
    body = (
      <View className="gap-2 px-4 pb-3">
        {[0, 1].map(row => (
          <Skeleton key={row} className="h-14 rounded-xl" />
        ))}
      </View>
    );
  } else if (forwards.isError) {
    body = (
      <View className="items-center gap-3 px-6 pb-4">
        <AccessibleStatus message={t('ssh.forwards.loadFailed')} className="text-sm" />
        <Button
          variant="outline"
          className={STATE_ACTION_CLASS}
          onPress={() => void forwards.refetch()}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  } else if (forwards.data.length === 0) {
    body = (
      <EmptyState
        placement="static"
        icon={Plug}
        title={t('ssh.forwards.emptyTitle')}
        description={t('ssh.forwards.emptyDescription')}
        action={
          <Button
            variant="outline"
            className={STATE_ACTION_CLASS}
            onPress={() => {
              onClose();
              router.push(sshHostPath(hostId));
            }}
          >
            <Text>{t('ssh.forwards.manage')}</Text>
          </Button>
        }
      />
    );
  } else {
    body = (
      <ScrollView className="max-h-[420px]" contentContainerClassName="gap-2 px-4 pb-3">
        {forwards.data.map(forward => (
          <ForwardRow
            key={forward.id}
            forward={forward}
            status={statuses.get(forward.id) ?? { kind: 'stopped' }}
            connected={connected}
            onStart={() => {
              if (nativeSessionId !== null) {
                void startForward(sessionId, nativeSessionId, forward);
              }
            }}
            onStop={() => void stopForward(sessionId, forward.id)}
            onOpen={port => {
              void openExternalUrl(localForwardUrl(port));
            }}
          />
        ))}
      </ScrollView>
    );
  }

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View className="gap-3 pb-4">
        <View className="flex-row items-center gap-2 px-4 pt-1">
          <PlugZap size={16} color={colors.foreground} />
          <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
            {t('ssh.forwards.title')}
          </Text>
        </View>
        {body}
      </View>
    </Sheet>
  );
}

function ForwardAction({
  status,
  name,
  connected,
  onStart,
  onStop,
}: Readonly<{
  status: ForwardStatus;
  name: string;
  connected: boolean;
  onStart: () => void;
  onStop: () => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  if (status.kind === 'starting') {
    return <ActivityIndicator size="small" />;
  }
  if (status.kind === 'listening') {
    return (
      <IconButton
        accessibilityLabel={t('ssh.forwards.stopAction', { name })}
        onPress={() => {
          onStop();
        }}
      >
        <Square size={16} color={colors.mutedForeground} />
      </IconButton>
    );
  }
  return (
    <IconButton
      accessibilityLabel={t('ssh.forwards.startAction', { name })}
      disabled={!connected}
      onPress={() => {
        onStart();
      }}
    >
      <Plug size={16} color={colors.mutedForeground} />
    </IconButton>
  );
}

function ForwardRow({
  forward,
  status,
  connected,
  onStart,
  onStop,
  onOpen,
}: Readonly<{
  forward: SshForward;
  status: ForwardStatus;
  connected: boolean;
  onStart: () => void;
  onStop: () => void;
  onOpen: (port: number) => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const listening = status.kind === 'listening';
  const openable = listening && isHttpForward(forward);
  const name = forwardLabel(forward);

  return (
    <Pressable
      accessibilityRole={openable ? 'button' : undefined}
      accessibilityLabel={name}
      accessibilityHint={openable ? t('ssh.forwards.openHint') : undefined}
      disabled={!openable}
      className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 active:opacity-70"
      onPress={() => {
        if (status.kind === 'listening') {
          onOpen(status.port);
        }
      }}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {name}
        </Text>
        <Text
          className={
            status.kind === 'failed' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
          }
          numberOfLines={2}
        >
          {forward.direction === 'local'
            ? t('ssh.forwards.localLine')
            : t('ssh.forwards.remoteLine')}
          {' · '}
          {forwardStatusLine(status, t)}
        </Text>
      </View>
      {openable ? <Globe size={16} color={colors.mutedForeground} /> : null}
      <ForwardAction
        status={status}
        name={name}
        connected={connected}
        onStart={onStart}
        onStop={onStop}
      />
    </Pressable>
  );
}

function forwardStatusLine(status: ForwardStatus, t: TFunction): string {
  if (status.kind === 'listening') {
    return t('ssh.forwards.listening', { port: status.port });
  }
  if (status.kind === 'starting') {
    return t('common.starting');
  }
  if (status.kind === 'failed') {
    return forwardErrorMessage(t, status.code);
  }
  return t('ssh.forwards.stopped');
}
