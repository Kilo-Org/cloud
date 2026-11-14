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

/** A link this sheet created, and what is known about it. */
type CreatedLink = {
  readonly url: string;
  /** The identity the worker created. `null` only while a worker older than the app answers. */
  readonly publicId: string | null;
  /** When the create landed, so a read that started before it cannot judge the link. */
  readonly at: number;
  readonly copy: ShareCopyState;
};

/**
 * What the sheet offers, as one state rather than a URL plus four booleans.
 *
 * `linkSuperseded` is the case the old shape could not name: this sheet's URL is
 * no longer the live one — another device replaced it — so Copy and Share would
 * hand out a dead link. It keeps Revoke, which revokes the **current** link, and
 * says so.
 */
type SharePanel =
  | { readonly kind: 'reading' }
  | { readonly kind: 'readFailed' }
  | { readonly kind: 'noLink' }
  | { readonly kind: 'linkElsewhere' }
  | { readonly kind: 'linkCreated'; readonly url: string; readonly copy: ShareCopyState }
  | { readonly kind: 'linkSuperseded' };

/**
 * The session's public share link: create it with the same choice the web
 * offers (how long it lives, whether later messages are included), then copy
 * it, hand it to the system share sheet, or revoke it.
 *
 * The sheet shows one of the panel's six states:
 * - no link: the duration row, the include-later-messages toggle and the
 *   create action;
 * - a link created in this session: the URL, its lifetime, copy and share, and
 *   revoke — until a later read says the link it made is no longer the live
 *   one, which is `linkSuperseded`;
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
  /** The link this sheet made, or null. Everything the panel draws about it is on it. */
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const shareStateQuery = useQuery(
    trpc.cliSessionsV2.get.queryOptions(
      { session_id: sessionId },
      { enabled: visible, staleTime: 30_000 }
    )
  );
  // Until the session row has been read, whether this session already has a
  // link is unknown — and treating that as "no link" offers a create action
  // whose mutation rotates the share generation and revokes the previous link.
  const shareStateLoaded = !shareStateQuery.isPending && !shareStateQuery.isError;
  // Existence only: the row records that a link was issued, not whether it has
  // since expired.
  const hasPublicLink = shareStateQuery.data?.public_id != null;

  // Closing the sheet drops the transient outcomes, so a reopen starts from the
  // action rather than from the last attempt's feedback. The created URL is one
  // of them: the server stores only the token's identity, so keeping it across a
  // close would offer Copy/Share for a link that may since have been revoked.
  useEffect(() => {
    if (!visible) {
      setCreated(null);
      setActionError(null);
    }
  }, [visible]);

  /* The read that can judge this sheet's link is one taken after the create: a
     read older than the link cannot know it exists, and one still in flight has
     no answer yet. Its answer either names the link this sheet made — still live
     — or a different (or no) identity, which means the link shown was replaced
     somewhere else. A worker older than the app answers no identity at all, so
     there is nothing to compare and the URL is shown as it always was. */
  const superseded =
    created !== null &&
    created.publicId !== null &&
    shareStateQuery.isSuccess &&
    !shareStateQuery.isFetching &&
    shareStateQuery.dataUpdatedAt > created.at &&
    (shareStateQuery.data.public_id ?? null) !== created.publicId;

  const panel: SharePanel = shareStateQuery.isError
    ? // A read in error cannot vouch for a URL, so it takes over the panel: the
      // link may be dead and this sheet cannot say.
      { kind: 'readFailed' }
    : created !== null
      ? superseded
        ? { kind: 'linkSuperseded' }
        : { kind: 'linkCreated', url: created.url, copy: created.copy }
      : !shareStateLoaded
        ? { kind: 'reading' }
        : hasPublicLink
          ? { kind: 'linkElsewhere' }
          : { kind: 'noLink' };

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
        publicId: shared.public_id,
        at: Date.now(),
        copy: 'idle',
      });
      setActionError(null);
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

  const copyLink = async () => {
    if (created === null) {
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
    if (created === null) {
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

  const durationLabels = SHARE_DURATIONS.map(value => ({
    value,
    label: t(DURATION_LABEL_KEYS[value]),
  }));

  // The configuration a link is created with: its duration and whether later
  // messages join the share. It is shown in both the create state and the
  // existing-link state, because replacing an existing link uses exactly this
  // choice — hiding it there would replace the link with the defaults instead
  // of what the person picked.
  const shareConfiguration = (
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
    </View>
  );

  let actions: ReactNode = null;
  switch (panel.kind) {
    case 'linkCreated':
      actions = (
        <ShareActiveLink
          url={panel.url}
          lifetime={duration}
          includeNewMessages={includeNewMessages}
          copyState={panel.copy}
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
      break;
    case 'linkSuperseded':
      /* This sheet's URL is no longer the live one. Offering Copy or Share would
         hand out a link that no longer works, so the panel says that and offers
         a fresh link — and Revoke, which ends the link that is live now and
         says so in its own confirmation. */
      actions = (
        <View className="gap-3">
          <Text variant="muted" className="text-xs" testID="session-share-superseded">
            {t('sessionShare.superseded')}
          </Text>
          {shareConfiguration}
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
      break;
    case 'readFailed':
      // The session row could not be read, so this sheet cannot tell whether a
      // link exists or whether the one it made is still live. Offer the read
      // again instead of an action that would silently rotate a link another
      // device may hold.
      actions = (
        <View className="gap-3">
          <Text className="text-xs text-destructive" testID="session-share-state-error">
            {t('common.somethingWentWrong')}
          </Text>
          <Button
            variant="outline"
            className="w-full"
            loading={shareStateQuery.isFetching}
            onPress={() => {
              void shareStateQuery.refetch();
            }}
            testID="session-share-state-retry"
          >
            {t('common.retry')}
          </Button>
        </View>
      );
      break;
    case 'reading':
      actions = (
        <Text variant="muted" className="text-xs" testID="session-share-state-loading">
          {t('common.loading')}
        </Text>
      );
      break;
    case 'linkElsewhere':
      // The state names that a link exists, not that it works: `cli_sessions_v2`
      // stores only `public_id`, and a share token's expiry never reaches the
      // client, so an expired link is indistinguishable from a live one here.
      // Replacing it uses the configuration above instead of silent defaults.
      actions = (
        <View className="gap-3">
          <Text className="text-sm font-medium text-foreground" testID="session-share-existing">
            {t('sessionShare.existingTitle')}
          </Text>
          <Text variant="muted" className="text-xs">
            {t('sessionShare.existingDescription')}
          </Text>
          {shareConfiguration}
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
      break;
    case 'noLink':
      actions = (
        <View className="gap-3">
          {shareConfiguration}
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
      break;
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
