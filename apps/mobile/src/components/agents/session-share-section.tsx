import { type SessionShareDuration } from '@kilocode/session-ingest-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Share, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import { notificationHaptic } from '@/lib/haptics';
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** The share durations the worker accepts, in the order the row shows them. */
const SHARE_DURATIONS: readonly SessionShareDuration[] = ['1h', '1d', '7d', '30d', 'forever'];

const DURATION_LABEL_KEYS = {
  '1h': 'sessionShare.duration1h',
  '1d': 'sessionShare.duration1d',
  '7d': 'sessionShare.duration7d',
  '30d': 'sessionShare.duration30d',
  forever: 'sessionShare.durationForever',
} as const satisfies Record<SessionShareDuration, string>;

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * The message to show for a failed share action: the server's own wording when
 * it has one, and the caller's fallback when it does not. A worker error such
 * as the payload-too-large refusal is the useful part, so it wins.
 */
function actionErrorMessage(error: unknown, fallback: string): string {
  const message = readTrpcErrorField(error, 'message')?.trim();
  return message !== undefined && message.length > 0 ? message : fallback;
}

/**
 * The session's public share link: create it with the same choice the web
 * offers (how long it lives, whether later messages are included), then copy
 * it, hand it to the system share sheet, or revoke it.
 *
 * The sheet shows one of three states:
 * - no link: the duration row, the include-later-messages toggle and the
 *   create action;
 * - a link created in this session: the URL, its lifetime, copy and share, and
 *   revoke;
 * - a link that already exists (created on another device, or before this
 *   screen opened): the link can be rotated or revoked. The URL itself cannot
 *   be recovered — the server stores only the token's identity, exactly as the
 *   web share dialog does — so the state names that and offers a fresh link.
 */
export function SessionShareSection({
  sessionId,
  visible,
}: Readonly<{ sessionId: string; visible: boolean }>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [duration, setDuration] = useState<SessionShareDuration>('7d');
  const [includeNewMessages, setIncludeNewMessages] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);

  const shareStateQuery = useQuery(
    trpc.cliSessionsV2.get.queryOptions(
      { session_id: sessionId },
      { enabled: visible, staleTime: 30_000 }
    )
  );
  const hasActiveLink = shareStateQuery.data?.public_id != null;

  // Closing the sheet drops the transient outcomes, so a reopen starts from the
  // action rather than from the last attempt's feedback.
  useEffect(() => {
    if (!visible) {
      setCopyState('idle');
      setActionError(null);
    }
  }, [visible]);

  const invalidateShareState = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.cliSessionsV2.get.queryKey({ session_id: sessionId }),
    });
  };

  const shareMutation = useMutation({
    ...trpc.cliSessionsV2.share.mutationOptions(),
    onSuccess: created => {
      setCreatedUrl(`${WEB_BASE_URL}/s/${created.share_token}`);
      setCopyState('idle');
      setActionError(null);
      notificationHaptic(Haptics.NotificationFeedbackType.Success);
      invalidateShareState();
    },
    onError: error => {
      setActionError(actionErrorMessage(error, t('sessionShare.createFailed')));
    },
  });

  const unshareMutation = useMutation({
    ...trpc.cliSessionsV2.unshare.mutationOptions(),
    onSuccess: () => {
      setCreatedUrl(null);
      setCopyState('idle');
      setActionError(null);
      notificationHaptic(Haptics.NotificationFeedbackType.Success);
      invalidateShareState();
    },
    onError: error => {
      setActionError(actionErrorMessage(error, t('sessionShare.revokeFailed')));
    },
  });

  const busy = shareMutation.isPending || unshareMutation.isPending;

  const createLink = () => {
    setActionError(null);
    shareMutation.mutate({
      session_id: sessionId,
      duration,
      include_new_messages: includeNewMessages,
    });
  };

  const copyLink = async () => {
    if (createdUrl === null) {
      return;
    }
    try {
      const copied = await Clipboard.setStringAsync(createdUrl);
      if (!copied) {
        throw new Error('Clipboard rejected the share link');
      }
      notificationHaptic(Haptics.NotificationFeedbackType.Success);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const shareLink = async () => {
    if (createdUrl === null) {
      return;
    }
    try {
      await Share.share({ message: createdUrl, url: createdUrl });
    } catch {
      setActionError(t('agentChat.chatLink.couldNotShareLink'));
    }
  };

  const revokeLink = () => {
    confirm({
      title: t('sessionShare.revokeTitle'),
      message: t('sessionShare.revokeMessage'),
      confirmLabel: t('sessionShare.revoke'),
      onConfirm: () => {
        setActionError(null);
        unshareMutation.mutate({ session_id: sessionId });
      },
    });
  };

  const durationLabels = SHARE_DURATIONS.map(value => ({
    value,
    label: t(DURATION_LABEL_KEYS[value]),
  }));

  return (
    <View className="gap-3" testID="session-share-section">
      <Text className="text-sm font-semibold text-foreground">{t('sessionShare.title')}</Text>
      <Text variant="muted" className="text-xs">
        {t('sessionShare.subtitle')}
      </Text>

      {createdUrl !== null ? (
        <ActiveLink
          url={createdUrl}
          lifetime={duration}
          includeNewMessages={includeNewMessages}
          copyState={copyState}
          busy={busy}
          onCopy={() => {
            void copyLink();
          }}
          onShare={() => {
            void shareLink();
          }}
          onRevoke={revokeLink}
        />
      ) : hasActiveLink ? (
        <View className="gap-3">
          <Text className="text-sm font-medium text-foreground" testID="session-share-active">
            {t('sessionShare.activeTitle')}
          </Text>
          <Text variant="muted" className="text-xs">
            {t('sessionShare.activeDescription')}
          </Text>
          <Button
            variant="outline"
            className="w-full"
            loading={shareMutation.isPending}
            disabled={busy}
            onPress={createLink}
            testID="session-share-rotate"
          >
            {t('sessionShare.rotate')}
          </Button>
          <Button
            variant="outline-destructive"
            className="w-full"
            loading={unshareMutation.isPending}
            disabled={busy}
            onPress={revokeLink}
            testID="session-share-revoke"
          >
            {t('sessionShare.revoke')}
          </Button>
        </View>
      ) : (
        <View className="gap-3">
          <View className="gap-2">
            <Text className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('sessionShare.durationLabel')}
            </Text>
            <SegmentedControl
              options={durationLabels}
              value={duration}
              onChange={setDuration}
              accessibilityLabel={t('sessionShare.durationLabel')}
            />
          </View>
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1 gap-1">
              <Text className="text-sm font-medium text-foreground">
                {t('sessionShare.includeNewMessages')}
              </Text>
              <Text variant="muted" className="text-xs">
                {includeNewMessages
                  ? t('sessionShare.includeNewMessagesOn')
                  : t('sessionShare.includeNewMessagesOff')}
              </Text>
            </View>
            <Switch
              testID="session-share-include-new"
              accessibilityLabel={t('sessionShare.includeNewMessages')}
              value={includeNewMessages}
              disabled={busy}
              onValueChange={setIncludeNewMessages}
            />
          </View>
          <Button
            className="w-full"
            loading={shareMutation.isPending}
            disabled={busy}
            onPress={createLink}
            testID="session-share-create"
          >
            {t('sessionShare.create')}
          </Button>
        </View>
      )}

      {actionError !== null ? (
        <Text className="text-xs text-destructive" testID="session-share-error">
          {actionError}
        </Text>
      ) : null}
      {dialog}
    </View>
  );
}

function ActiveLink({
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
  copyState: CopyState;
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
