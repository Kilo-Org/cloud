import { type SessionShareDuration } from '@kilocode/session-ingest-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, View } from 'react-native';

import { useConfirmDialog } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { notificationHaptic } from '@/lib/haptics';
import { useTRPC } from '@/lib/trpc';

import { SharePanelBody } from './session-share-panel';
import {
  actionErrorMessage,
  type CreatedLink,
  freshnessOf,
  type ShareFreshness,
  sharePanelOf,
} from './session-share-state';

/**
 * The session's public share link: create it with the same choice the web
 * offers (how long it lives, whether later messages are included), then copy
 * it, hand it to the system share sheet, or revoke it.
 *
 * The body's six states are drawn by `SharePanelBody`; this section owns the
 * session read, the mutations and the transient outcomes they produce.
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
  /** The link this sheet made, or null. Everything the panel draws about it is on it. */
  const [created, setCreated] = useState<CreatedLink | null>(null);
  /** What the read taken at the last Copy or Share press proved about `created`. */
  const [freshness, setFreshness] = useState<ShareFreshness>({ kind: 'unchecked' });
  const [actionError, setActionError] = useState<string | null>(null);

  const shareStateQuery = useQuery(
    trpc.cliSessionsV2.get.queryOptions(
      { session_id: sessionId },
      { enabled: visible, staleTime: 30_000 }
    )
  );
  const panel = sharePanelOf(created, shareStateQuery, freshness);

  // Closing the sheet drops the transient outcomes, so a reopen starts from the
  // action rather than from the last attempt's feedback. The created URL is one
  // of them: the server stores only the token's identity, so keeping it across a
  // close would offer Copy/Share for a link that may since have been revoked.
  useEffect(() => {
    if (!visible) {
      setCreated(null);
      setFreshness({ kind: 'unchecked' });
      setActionError(null);
    }
  }, [visible]);

  const invalidateShareState = (): Promise<void> =>
    queryClient.invalidateQueries({
      queryKey: trpc.cliSessionsV2.get.queryKey({ session_id: sessionId }),
    });

  const shareMutation = useMutation({
    ...trpc.cliSessionsV2.share.mutationOptions(),
    // Loaded here, not at module scope: the session sheet's mounted test runs
    // in a node environment, and `@/lib/config` reaches Expo's runtime setup,
    // which that environment cannot evaluate. The app reads the same value
    // before the first share can complete.
    onSuccess: async shared => {
      const { WEB_BASE_URL } = await import('@/lib/config');
      setCreated({
        url: `${WEB_BASE_URL}/s/${shared.share_token}`,
        publicId: shared.public_id ?? null,
        at: Date.now(),
        copy: 'idle',
      });
      setActionError(null);
      setFreshness({ kind: 'unchecked' });
      notificationHaptic(Haptics.NotificationFeedbackType.Success);
      /* Awaited, so the read that can judge this link has started before the
         mutation reports success: the panel then compares against a read taken
         after the create rather than against the one before it. */
      await invalidateShareState();
    },
    onError: error => {
      setActionError(actionErrorMessage(error, t('sessionShare.createFailed')));
    },
  });

  const unshareMutation = useMutation({
    ...trpc.cliSessionsV2.unshare.mutationOptions(),
    onSuccess: () => {
      setCreated(null);
      setFreshness({ kind: 'unchecked' });
      setActionError(null);
      notificationHaptic(Haptics.NotificationFeedbackType.Success);
      void invalidateShareState();
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

  /*
   * A read taken now, not the row on screen: the sheet can stay open while
   * another device rotates the link, and `staleTime` schedules no read that
   * would notice. Only this read can tell the URL this sheet made from its
   * replacement. A link created without an identity has nothing to compare.
   */
  const mayDistribute = async (link: CreatedLink): Promise<boolean> => {
    if (link.publicId === null) {
      return true;
    }
    const read = await shareStateQuery.refetch({ cancelRefetch: false });
    const settled = freshnessOf(link, read);
    setFreshness(settled);
    return settled.kind === 'current';
  };

  const copyLink = async () => {
    if (created === null || !(await mayDistribute(created))) {
      return;
    }
    const { url } = created;
    try {
      // Imported at press time for the same reason as `@/lib/config` above.
      const { setStringAsync } = await import('expo-clipboard');
      const copied = await setStringAsync(url);
      if (!copied) {
        throw new Error('Clipboard rejected the share link');
      }
      notificationHaptic(Haptics.NotificationFeedbackType.Success);
      setCreated(held => (held === null ? held : { ...held, copy: 'copied' }));
    } catch {
      setCreated(held => (held === null ? held : { ...held, copy: 'failed' }));
    }
  };

  const shareLink = async () => {
    if (created === null || !(await mayDistribute(created))) {
      return;
    }
    const { url } = created;
    try {
      await Share.share({ message: url, url });
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

  return (
    <View className="gap-3" testID="session-share-section">
      <Text className="text-sm font-semibold text-foreground">{t('sessionShare.title')}</Text>
      <Text variant="muted" className="text-xs">
        {t('sessionShare.subtitle')}
      </Text>

      <SharePanelBody
        panel={panel}
        duration={duration}
        includeNewMessages={includeNewMessages}
        onDurationChange={setDuration}
        onIncludeNewMessagesChange={setIncludeNewMessages}
        busy={busy}
        creating={shareMutation.isPending}
        revoking={unshareMutation.isPending}
        retrying={shareStateQuery.isFetching}
        onCopy={() => {
          void copyLink();
        }}
        onShare={() => {
          void shareLink();
        }}
        onCreate={createLink}
        onRetry={() => {
          setFreshness({ kind: 'unchecked' });
          void shareStateQuery.refetch();
        }}
        onRevoke={revokeLink}
      />

      {dialog}
      {actionError !== null ? (
        <Text className="text-xs text-destructive" testID="session-share-error">
          {actionError}
        </Text>
      ) : null}
    </View>
  );
}
