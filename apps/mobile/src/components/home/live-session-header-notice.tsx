import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, Pressable } from 'react-native';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import {
  liveSessionContent,
  type LiveSessionContext,
  type LiveSessions,
} from '@/components/home/live-session-state';
import { EYEBROW_LATIN_DISPLAY, Text } from '@/components/ui/text';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useUserWebConnectionHealth } from '@/lib/hooks/use-user-web-connection-state';
import { createSubmitLock } from '@/lib/submit-lock';
import { cn } from '@/lib/utils';

type LiveSessionHeaderNoticeProps = Readonly<{
  context: LiveSessionContext;
  sessions: LiveSessions;
  failureLabel: string;
}>;

/**
 * Home's one-line notice in the `Live now` header: a failed load beside
 * readable rows, then no internet, then a lost connection. The header row has
 * a fixed height, so a notice that comes and goes on its own never moves the
 * card. `LiveSessionFeedback` (with `inlineNotices={false}`) keeps the
 * screen-reader announcements, so this text is not a live region.
 */
export function LiveSessionHeaderNotice({
  context,
  sessions,
  failureLabel,
}: LiveSessionHeaderNoticeProps) {
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
  const canRetry = loadFailed || (internet !== 'offline' && connectionLost);

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

  return (
    <>
      <Text
        numberOfLines={1}
        className={cn('shrink text-xs', loadFailed ? 'text-destructive' : 'text-muted-foreground')}
      >
        {message}
      </Text>
      {canRetry && (
        <Pressable
          onPress={handleRetry}
          disabled={retrying}
          accessibilityState={{ busy: retrying, disabled: retrying }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            loadFailed ? t('common.retry') : t('agentChat.sessionConnection.retryConnection')
          }
          className="shrink-0 active:opacity-70"
        >
          <Text
            className={cn(
              'font-mono-medium text-[11px] text-primary',
              !I18nManager.isRTL && EYEBROW_LATIN_DISPLAY
            )}
          >
            {t('common.retry')}
          </Text>
        </Pressable>
      )}
    </>
  );
}
