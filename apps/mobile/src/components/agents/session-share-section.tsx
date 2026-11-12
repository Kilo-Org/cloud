import { type SessionShareDuration } from '@kilocode/session-ingest-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, View } from 'react-native';

import { Button } from '@/components/ui/button';
import {
  DURATION_LABEL_KEYS,
  ShareActiveLink,
  type ShareCopyState,
} from './session-share-active-link';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { notificationHaptic } from '@/lib/haptics';
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** The share durations the worker accepts, in the order the row shows them. */
const SHARE_DURATIONS: readonly SessionShareDuration[] = ['1h', '1d', '7d', '30d', 'forever'];

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
  const [copyState, setShareCopyState] = useState<ShareCopyState>('idle');
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
      setShareCopyState('idle');
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
    // Loaded here, not at module scope: the session sheet's mounted test runs
    // in a node environment, and `@/lib/config` reaches Expo's runtime setup,
    // which that environment cannot evaluate. The app reads the same value
    // before the first share can complete.
    onSuccess: async created => {
      const { WEB_BASE_URL } = await import('@/lib/config');
      setCreatedUrl(`${WEB_BASE_URL}/s/${created.share_token}`);
      setShareCopyState('idle');
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
      setShareCopyState('idle');
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
      // Imported at press time for the same reason as `@/lib/config` above.
      const { setStringAsync } = await import('expo-clipboard');
      const copied = await setStringAsync(createdUrl);
      if (!copied) {
        throw new Error('Clipboard rejected the share link');
      }
      notificationHaptic(Haptics.NotificationFeedbackType.Success);
      setShareCopyState('copied');
    } catch {
      setShareCopyState('failed');
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

  let actions: ReactNode = null;
  if (createdUrl !== null) {
    actions = (
      <ShareActiveLink
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
    );
  } else if (hasActiveLink) {
    actions = (
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
    );
  } else {
    actions = (
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
    );
  }

  return (
    <View className="gap-3" testID="session-share-section">
      <Text className="text-sm font-semibold text-foreground">{t('sessionShare.title')}</Text>
      <Text variant="muted" className="text-xs">
        {t('sessionShare.subtitle')}
      </Text>

      {actions}

      {dialog}
      {actionError !== null ? (
        <Text className="text-xs text-destructive" testID="session-share-error">
          {actionError}
        </Text>
      ) : null}
    </View>
  );
}
