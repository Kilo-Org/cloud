import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import {
  liveSessionContent,
  type LiveSessionContext,
  type LiveSessions,
} from '@/components/home/live-session-state';
import { Text } from '@/components/ui/text';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useUserWebConnectionHealth } from '@/lib/hooks/use-user-web-connection-state';
import { createSubmitLock } from '@/lib/submit-lock';
import { cn } from '@/lib/utils';

export type LiveSessionHeaderNoticeState = Readonly<{
  message: string;
  loadFailed: boolean;
  canRetry: boolean;
  retrying: boolean;
  handleRetry: () => void;
}>;

/**
 * Home's one-line notice in the `Live now` header: a failed load beside
 * readable rows, then no internet, then a lost connection. Null while there is
 * nothing to report, so the header lays out its action as if no notice
 * existed. `LiveSessionFeedback` (with `inlineNotices={false}`) keeps the
 * screen-reader announcements, so the notice text is not a live region.
 */
export function useLiveSessionHeaderNotice(
  context: LiveSessionContext,
  sessions: LiveSessions,
  failureLabel: string
): LiveSessionHeaderNoticeState | null {
  const { t } = useTranslation();
  const internet = useCommittedConnectivityStatus();
  const { isConnected, reconnectExhausted } = useUserWebConnectionHealth();
  const connection = useUserWebConnection();
  const retryLock = useMemo(createSubmitLock, []);
  const [retrying, setRetrying] = useState(false);
  const content = liveSessionContent(context, sessions);

  const loadFailed = content === 'rows' && context.isReady && Boolean(sessions.terminalError);
  const connectionLost =
    content !== 'error' && context.isReady && !isConnected && reconnectExhausted;
  let message: string | null = null;
  if (loadFailed) {
    message = failureLabel;
  } else if (internet === 'offline') {
    message = t('offline.noInternet');
  } else if (connectionLost) {
    message = t('agentChat.sessionConnection.connectionLost');
  }
  if (message === null) {
    return null;
  }

  const handleRetry = () => {
    if (!loadFailed) {
      connection.retryConnection();
      return;
    }
    if (!retryLock.acquire()) {
      return;
    }
    setRetrying(true);
    void (async () => {
      try {
        await sessions.refetch();
      } finally {
        retryLock.release();
        setRetrying(false);
      }
    })();
  };
  return {
    message,
    loadFailed,
    canRetry: loadFailed || (internet !== 'offline' && connectionLost),
    retrying,
    handleRetry,
  };
}

/**
 * Status dot, message, and a sentence-case `Retry`: the retry must not share
 * the header action's uppercase mono treatment, or `Retry` and `See all` read
 * as one label.
 */
export function LiveSessionHeaderNotice({
  notice,
}: Readonly<{ notice: LiveSessionHeaderNoticeState }>) {
  const { t } = useTranslation();
  return (
    <>
      <View
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          notice.loadFailed ? 'bg-destructive' : 'bg-warn'
        )}
      />
      <Text
        numberOfLines={1}
        className={cn(
          'shrink text-xs',
          notice.loadFailed ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {notice.message}
      </Text>
      {notice.canRetry && (
        <Pressable
          onPress={notice.handleRetry}
          disabled={notice.retrying}
          accessibilityState={{ busy: notice.retrying, disabled: notice.retrying }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            notice.loadFailed ? t('common.retry') : t('agentChat.sessionConnection.retryConnection')
          }
          className="shrink-0 active:opacity-70"
        >
          <Text className="text-xs font-medium text-primary">{t('common.retry')}</Text>
        </Pressable>
      )}
    </>
  );
}
