import { type SessionShareDuration } from '@kilocode/session-ingest-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, View } from 'react-native';

import { useConfirmDialog } from '@/components/ui/dialog';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { notificationHaptic } from '@/lib/haptics';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

import { type ShareDistribution } from './session-share-active-link';
import { SharePanelBody } from './session-share-panel';
import {
  actionErrorMessage,
  type CreatedLink,
  freshnessOf,
  type ShareFreshness,
  sharePanelOf,
} from './session-share-state';

/** A press-time operation, and the session and presentation that started it. */
type ShareOperation = Readonly<{
  readonly version: number;
  readonly sessionId: string;
  readonly kind: ShareDistribution;
  readonly link: CreatedLink;
}>;

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
  /** The press-time action currently running, kept in a ref as well as here. */
  const [pendingDistribution, setPendingDistribution] = useState<ShareDistribution | null>(null);

  /*
   * The one running distribution, owned by the presentation that started it.
   * The ref is written before the first await, so two presses in one tick can
   * start only one read and one native hand-off.
   */
  const distributionRef = useRef<ShareOperation | null>(null);
  /*
   * A sheet that closes, reopens, changes session or unmounts is a different
   * presentation, and so is a link that is replaced or revoked. The version is
   * bumped where that change enters the component — during render for the
   * props — so a continuation that resumes after an await can never publish
   * into the presentation that replaced it.
   */
  const presentationRef = useRef({ visible, sessionId, version: 0 });
  const presented = presentationRef.current;
  if (presented.visible !== visible || presented.sessionId !== sessionId) {
    presentationRef.current = { visible, sessionId, version: presented.version + 1 };
    distributionRef.current = null;
  }

  const shareStateQuery = useQuery({
    ...trpc.cliSessionsV2.get.queryOptions(
      { session_id: sessionId },
      { enabled: visible, staleTime: 30_000 }
    ),
    ...SETTLE_WHILE_OFFLINE,
  });
  const panel = sharePanelOf(created, shareStateQuery, freshness);

  /*
   * Closing the sheet drops the transient outcomes, so a reopen starts from the
   * action rather than from the last attempt's feedback. The created URL is one
   * of them: the server stores only the token's identity, so keeping it across a
   * close would offer Copy/Share for a link that may since have been revoked.
   * A session change drops them for the same reason.
   */
  useEffect(() => {
    setCreated(null);
    setFreshness({ kind: 'unchecked' });
    setActionError(null);
    setPendingDistribution(null);
  }, [visible, sessionId]);

  // Nothing may publish after the section is gone.
  useEffect(
    () => () => {
      distributionRef.current = null;
    },
    []
  );

  const invalidateShareState = (): Promise<void> =>
    queryClient.invalidateQueries({
      queryKey: trpc.cliSessionsV2.get.queryKey({ session_id: sessionId }),
    });

  /*
   * Abandons the presentation the running work belongs to. A create, a
   * replacement, a revoke or a link that was just published makes every
   * press-time operation stale, so neither its read nor its clipboard or native
   * hand-off may continue.
   */
  const invalidatePresentation = (): void => {
    presentationRef.current = {
      ...presentationRef.current,
      version: presentationRef.current.version + 1,
    };
    distributionRef.current = null;
    setPendingDistribution(null);
  };

  const owns = (operation: ShareOperation): boolean =>
    distributionRef.current === operation &&
    presentationRef.current.version === operation.version &&
    presentationRef.current.sessionId === operation.sessionId;

  const shareMutation = useMutation({
    ...trpc.cliSessionsV2.share.mutationOptions<{ version: number }>(),
    onMutate: () => ({ version: presentationRef.current.version }),
    onSuccess: async (shared, _input, context) => {
      if (context.version !== presentationRef.current.version) {
        return;
      }
      // Loaded here, not at module scope: the session sheet's mounted test runs
      // in a node environment, and `@/lib/config` reaches Expo's runtime setup,
      // which that environment cannot evaluate. The app reads the same value
      // before the first share can complete.
      const { WEB_BASE_URL } = await import('@/lib/config');
      if (context.version !== presentationRef.current.version) {
        return;
      }
      invalidatePresentation();
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
    onError: (error, _input, context) => {
      if (context?.version !== presentationRef.current.version) {
        return;
      }
      setActionError(actionErrorMessage(error, t('sessionShare.createFailed')));
    },
  });

  const unshareMutation = useMutation({
    ...trpc.cliSessionsV2.unshare.mutationOptions<{ version: number }>(),
    onMutate: () => ({ version: presentationRef.current.version }),
    onSuccess: (_result, _input, context) => {
      if (context.version !== presentationRef.current.version) {
        return;
      }
      invalidatePresentation();
      setCreated(null);
      setFreshness({ kind: 'unchecked' });
      setActionError(null);
      notificationHaptic(Haptics.NotificationFeedbackType.Success);
      void invalidateShareState();
    },
    onError: (error, _input, context) => {
      if (context?.version !== presentationRef.current.version) {
        return;
      }
      setActionError(actionErrorMessage(error, t('sessionShare.revokeFailed')));
    },
  });

  const mutationBusy = shareMutation.isPending || unshareMutation.isPending;
  const running = distributionRef.current;
  const distribution =
    pendingDistribution !== null &&
    running !== null &&
    running.version === presentationRef.current.version
      ? pendingDistribution
      : null;
  const busy = mutationBusy || distribution !== null;

  const createLink = () => {
    setActionError(null);
    invalidatePresentation();
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
  const identityIsCurrent = async (operation: ShareOperation): Promise<boolean> => {
    const { link } = operation;
    if (link.publicId === null) {
      return true;
    }
    // A read that rejects settles nothing, so it is the same refusal as one
    // that answers in error: the sheet cannot vouch for the URL.
    const read = await shareStateQuery.refetch({ cancelRefetch: true }).catch(() => null);
    if (!owns(operation)) {
      return false;
    }
    if (read === null) {
      setFreshness({ kind: 'readFailed' });
      return false;
    }
    const settled = freshnessOf(link, read);
    setFreshness(settled);
    return settled.kind === 'current';
  };

  const copyLink = async (operation: ShareOperation): Promise<void> => {
    const { url } = operation.link;
    try {
      // Imported at press time for the same reason as `@/lib/config` above.
      const { setStringAsync } = await import('expo-clipboard');
      if (!owns(operation)) {
        return;
      }
      const copied = await setStringAsync(url);
      if (!owns(operation)) {
        return;
      }
      if (copied) {
        notificationHaptic(Haptics.NotificationFeedbackType.Success);
      }
      setCreated(held =>
        held?.url === url ? { ...held, copy: copied ? 'copied' : 'failed' } : held
      );
    } catch {
      if (!owns(operation)) {
        return;
      }
      setCreated(held => (held?.url === url ? { ...held, copy: 'failed' } : held));
    }
  };

  const shareLink = async (operation: ShareOperation): Promise<void> => {
    if (!owns(operation)) {
      return;
    }
    const { url } = operation.link;
    try {
      await Share.share({ message: url, url });
    } catch {
      if (!owns(operation)) {
        return;
      }
      setActionError(t('agentChat.chatLink.couldNotShareLink'));
    }
  };

  /*
   * One distribution at a time. The guard is the ref, not `busy`, because a
   * second press in the same tick renders nothing before it runs. Ownership is
   * rechecked after every await, so a read that answers after the sheet closed,
   * another session opened, or the link was replaced cannot set freshness, copy
   * to the clipboard, or open the share sheet.
   */
  const distribute = async (kind: ShareDistribution): Promise<void> => {
    const link = created;
    if (link === null) {
      return;
    }
    const version = presentationRef.current.version;
    if (distributionRef.current?.version === version) {
      return;
    }
    const operation: ShareOperation = { version, sessionId, kind, link };
    distributionRef.current = operation;
    setPendingDistribution(kind);
    try {
      if (!(await identityIsCurrent(operation))) {
        return;
      }
      await (kind === 'copy' ? copyLink(operation) : shareLink(operation));
    } finally {
      if (distributionRef.current === operation) {
        distributionRef.current = null;
        setPendingDistribution(null);
      }
    }
  };

  const retryRead = async (): Promise<void> => {
    setFreshness({ kind: 'unchecked' });
    try {
      await shareStateQuery.refetch();
    } catch {
      // The query keeps its error state, so the panel still offers Retry.
    }
  };

  const revokeLink = () => {
    confirm({
      title: t('sessionShare.revokeTitle'),
      message: t('sessionShare.revokeMessage'),
      confirmLabel: t('sessionShare.revoke'),
      onConfirm: () => {
        setActionError(null);
        invalidatePresentation();
        unshareMutation.mutate({ session_id: sessionId });
      },
    });
  };

  return (
    <View testID="session-share-section">
      <Section
        label={t('sessionShare.title')}
        notice={<Text variant="caption">{t('sessionShare.subtitle')}</Text>}
      >
        <SharePanelBody
          panel={panel}
          duration={duration}
          includeNewMessages={includeNewMessages}
          onDurationChange={setDuration}
          onIncludeNewMessagesChange={setIncludeNewMessages}
          busy={busy}
          creating={shareMutation.isPending}
          revoking={unshareMutation.isPending}
          distribution={distribution}
          retrying={shareStateQuery.isFetching}
          onCopy={() => {
            void distribute('copy');
          }}
          onShare={() => {
            void distribute('share');
          }}
          onCreate={createLink}
          onRetry={() => {
            void retryRead();
          }}
          onRevoke={revokeLink}
        />

        {actionError !== null ? (
          <Text variant="caption" className="text-destructive" testID="session-share-error">
            {actionError}
          </Text>
        ) : null}
      </Section>

      {dialog}
    </View>
  );
}
