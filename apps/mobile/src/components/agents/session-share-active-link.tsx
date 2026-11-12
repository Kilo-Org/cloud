import { type SessionShareDuration } from '@kilocode/session-ingest-contracts';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/** The inline outcome of the copy action on a live share link. */
export type ShareCopyState = 'idle' | 'copied' | 'failed';

export const DURATION_LABEL_KEYS = {
  '1h': 'sessionShare.duration1h',
  '1d': 'sessionShare.duration1d',
  '7d': 'sessionShare.duration7d',
  '30d': 'sessionShare.duration30d',
  forever: 'sessionShare.durationForever',
} as const satisfies Record<SessionShareDuration, string>;

/**
 * A live share link: its lifetime and message scope, the URL itself, and the
 * actions that use it. The URL is shown as a pressable copy target and every
 * action repeats the copy outcome inline, because a toast would render behind
 * the sheet's window.
 */
export function ShareActiveLink({
  url,
  lifetime,
  includeNewMessages,
  copyState,
  busy,
  onCopy,
  onShare,
  onRevoke,
}: Readonly<{
  url: string;
  /** The chosen lifetime; `forever` is the one that never expires. */
  lifetime: SessionShareDuration;
  includeNewMessages: boolean;
  copyState: ShareCopyState;
  busy: boolean;
  onCopy: () => void;
  onShare: () => void;
  onRevoke: () => void;
}>) {
  const { t } = useTranslation();
  const lifetimeLabel =
    lifetime === 'forever'
      ? t('sessionShare.neverExpires')
      : t('sessionShare.expiresIn', { duration: t(DURATION_LABEL_KEYS[lifetime]) });
  return (
    <View className="gap-3">
      <View className="gap-1">
        <Text variant="muted" className="text-xs">
          {lifetimeLabel}
        </Text>
        <Text variant="muted" className="text-xs">
          {includeNewMessages
            ? t('sessionShare.includesNewMessages')
            : t('sessionShare.excludesNewMessages')}
        </Text>
      </View>
      <Pressable
        onPress={onCopy}
        accessibilityRole="button"
        accessibilityLabel={t('common.copyLink')}
        className="rounded-md border border-border bg-secondary p-3 active:opacity-70"
        testID="session-share-url"
      >
        <Text variant="mono" className="text-xs text-foreground">
          {url}
        </Text>
      </Pressable>
      {copyState !== 'idle' ? (
        <Text
          className={
            copyState === 'failed' ? 'text-xs text-destructive' : 'text-xs text-foreground'
          }
          testID="session-share-copy-status"
        >
          {copyState === 'failed'
            ? t('agentChat.chatLink.couldNotCopyLink')
            : t('agentChat.chatLink.linkCopied')}
        </Text>
      ) : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={busy}
        onPress={onCopy}
        testID="session-share-copy"
      >
        {t('common.copyLink')}
      </Button>
      <Button
        variant="outline"
        className="w-full"
        disabled={busy}
        onPress={onShare}
        testID="session-share-sheet"
      >
        {t('agentChat.chatLink.shareLink')}
      </Button>
      <Button
        variant="outline-destructive"
        className="w-full"
        loading={busy}
        onPress={onRevoke}
        testID="session-share-revoke"
      >
        {t('sessionShare.revoke')}
      </Button>
    </View>
  );
}
