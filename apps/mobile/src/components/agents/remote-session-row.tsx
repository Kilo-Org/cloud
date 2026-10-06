import { useQueryClient } from '@tanstack/react-query';
import { memo, useEffect, useMemo, useRef } from 'react';

import { glanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { useOrganization } from '@/lib/organization-context';
import { resolveSessionPrPressTarget } from '@/lib/session-pr-navigation';
import { type AccessibilityActionEvent, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SessionRow } from '@/components/ui/session-row';
import { refreshActiveSessionsNow } from '@/lib/active-sessions-live-sync';
import { prefetchSessionTranscript } from '@/lib/agent-session-cache';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import { useTRPC } from '@/lib/trpc';
import { exitRemoteSessionFromList } from './exit-remote-session-from-list';
import { useRemoteSessionExitConfirmation } from './remote-session-exit-alert';
import { namedSessionTitle, useUserSessionTitlesRevision } from './session-detail-rename-state';
import {
  activeSessionMetaTimestamp,
  canExitSessionFromList,
  composeActiveSessionVisibleMeta,
  composeSessionProvenanceSubtitle,
  formatScheduledWake,
  formatSessionTotalCost,
  remoteMeta,
  remoteSessionEyebrowLabel,
  selectRemoteRowSpokenMeta,
} from './session-list-helpers';
import { selectRowPlatformPresentation, SessionPlatformIcon } from './session-platform-icon';
import { openSessionPreviewStore } from './session-preview-state';
import { type RowVariant } from './session-row';
import {
  formatSpokenCost,
  formatSpokenTimeAgo,
  sessionRowAccessibilityLabel,
} from './session-row-accessibility-label';
import { useUserWebConnection } from './user-web-connection-provider';

type RemoteSessionRowProps = {
  session: ActiveSession;
  onPress: (session: ActiveSession) => void;
  /** Container shape: see `RowVariant`. Defaults to `'list'`. */
  variant?: RowVariant;
  /** See `StoredSessionRowProps.interactive`. Defaults to `true`. */
  interactive?: boolean;
};

/**
 * Opens a session's associated PR through the provider-aware, flag-aware route.
 * The native router and browser imports are lazy: they cannot load under the
 * mounted row tests' node environment, and only the long-press entry reaches
 * them.
 */
async function openSessionPr(url: string | null | undefined, label: string): Promise<void> {
  const target = await resolveSessionPrPressTarget({ url });
  if (target.kind === 'in-app') {
    const { router } = await import('expo-router');
    router.push(target.href);
    return;
  }
  const { openExternalUrl } = await import('@/lib/external-link');
  await openExternalUrl(target.url, { label });
}

export const RemoteSessionRow = memo(function RemoteSessionRow({
  session,
  onPress,
  variant = 'list',
  interactive = true,
}: Readonly<RemoteSessionRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { renameSession } = useSessionMutations();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const connection = useUserWebConnection();
  const { confirmExit, exitDialog } = useRemoteSessionExitConfirmation();
  const { organizationId, isLoaded } = useOrganization();
  const authEpoch = currentAuthEpoch();
  const refreshScope = useMemo(
    () => ({
      queryKey: trpc.activeSessions.list.queryKey(buildActiveSessionsTrayInput(organizationId)),
      authEpoch,
      isLoaded,
    }),
    [trpc, organizationId, authEpoch, isLoaded]
  );
  const currentRefreshScope = useRef<typeof refreshScope | null>(refreshScope);
  currentRefreshScope.current = refreshScope;
  useEffect(() => {
    currentRefreshScope.current = refreshScope;
    return () => {
      currentRefreshScope.current = null;
    };
  }, [refreshScope]);
  const exitingRef = useRef(false);
  // One derivation for the visible label, the spoken label and the rename
  // prompt: the server's creation-default title (`New session - <ISO
  // timestamp>`) is an internal marker, never row copy, so a creation
  // placeholder title reads as "Untitled session" — the row falls back to the
  // localized unnamed name the same way the session header does.
  // `namedSessionTitle` makes that judgement through the shared
  // `sessionDisplayTitle` helper and additionally keeps a placeholder-shaped
  // title the user's own rename wrote, so the same label feeds the row, the
  // accessibility label, and the rename prompt. The subscription repaints the
  // row once the durable record hydrates after a cold start.
  const titlesRevision = useUserSessionTitlesRevision();
  // Same seeding as the stored row: a session the backend has not named yet
  // opens an empty rename field instead of the `New session - <ISO>` machine
  // string, and the save paths reject an unchanged or blank value. A title the
  // user's own rename wrote is still seeded, so a chosen name is not blanked.
  const renameInitialValue = namedSessionTitle(session.title, session.id) ?? '';
  const canManage = interactive;

  const revision = useSessionAttentionRevision();
  // A live row's timestamp is minute-bucketed, so the clock is sampled at
  // least twice per bucket. The tick re-renders this row from the inside:
  // `memo` keeps the row out of a parent poll that changes no prop, so an
  // unchanged session would otherwise keep the label it drew when its payload
  // last changed. The shared interval means every row that reads the clock
  // shares one timer (see `lib/hooks/now-ticker-store`).
  const now = useNowTicker(10_000);
  // The ack store is the one input to the row that is not `session`: an ack
  // bumps the shared revision, so the flag re-derives when it ticks. A parent
  // re-render with an unchanged payload and no ack reuses this result.
  const needsInput = useMemo(
    () =>
      shouldShowNeedsInput({
        status: session.status,
        raiseId: session.status,
        isAcked: isAttentionAcked(session.id, session.status),
      }),
    // eslint-disable-next-line react/exhaustive-deps -- the revision is a real input: `isAttentionAcked` reads the ack store, so the flag must re-derive when that store ticks.
    [session, revision]
  );
  useEffect(() => {
    reconcileSessionAttention(session.id, session.status, null);
  }, [session.id, session.status, revision]);

  const {
    title,
    agentLabel,
    canExit,
    statusKind,
    subtitle,
    spokenPrNumber,
    scheduledWake,
    spokenMeta,
  } = useMemo(() => {
    // Spoken meta mirrors the visible meta the row renders. When `needsInput`
    // wins, the right eyebrow shows `NEEDS INPUT` and meta is NOT rendered,
    // so the label omits it. A scheduled row renders `SCHEDULED · <wake>`, so
    // the label speaks the wake beside `Scheduled` instead of a timestamp.
    // Otherwise announce the same timestamp as `remoteMeta` (prefer
    // lastActivityAt, fall back to updatedAt).
    const isScheduled = session.status === 'scheduled';
    const scheduledWakeValue =
      isScheduled && session.scheduledAt ? formatScheduledWake(session.scheduledAt) : null;
    const metaTimestamp = activeSessionMetaTimestamp(session);
    const timeSpoken = metaTimestamp ? formatSpokenTimeAgo(metaTimestamp, now) : null;
    return {
      title: namedSessionTitle(session.title, session.id) ?? t('agents.sessionRow.untitled'),
      agentLabel: remoteSessionEyebrowLabel(session),
      canExit: canExitSessionFromList(session),
      statusKind: glanceableStatusKind(session.status),
      // Provenance subtitle: list rows show "branch · #N", card rows keep the
      // branch-only subtitle. The spoken label mirrors this, with the PR phrase
      // only on the list variant.
      subtitle:
        variant === 'card'
          ? (session.gitBranch ?? null)
          : composeSessionProvenanceSubtitle({
              branch: session.gitBranch,
              prNumber: session.associatedPr?.number,
            }),
      spokenPrNumber: variant === 'card' ? null : (session.associatedPr?.number ?? null),
      scheduledWake: scheduledWakeValue,
      spokenMeta: isScheduled
        ? scheduledWakeValue
        : selectRemoteRowSpokenMeta({
            needsInput,
            costSpoken: formatSpokenCost(session.totalCostMicrodollars),
            timeSpoken,
          }),
    };
    // eslint-disable-next-line react/exhaustive-deps -- the titles revision and the sampled clock are real inputs: `namedSessionTitle` reads the recorded-titles store, and `formatSpokenTimeAgo` reads the clock, so both must re-derive when they tick.
  }, [session, variant, needsInput, t, titlesRevision, now]);

  // Tray rows are always live: the eyebrow draws the status glyph from the
  // shared derivation, so the platform glyph has no slot beside it (and the
  // spoken label withholds the platform with the icon).
  const { iconKind: platformIconKind, spokenPlatform } = useMemo(
    () =>
      selectRowPlatformPresentation({
        platform: session.createdOnPlatform,
        variant,
        needsInput,
        statusGlyph: true,
        gitUrl: session.gitUrl,
      }),
    [session, variant, needsInput]
  );
  const platformIcon = useMemo(
    () =>
      platformIconKind != null ? (
        <View accessible={false} testID={`platform-icon-${platformIconKind}`}>
          <SessionPlatformIcon
            platform={session.createdOnPlatform}
            size={12}
            color={colors.mutedSoft}
          />
        </View>
      ) : undefined,
    [platformIconKind, session.createdOnPlatform, colors.mutedSoft]
  );

  const refreshActiveList = async () => {
    const { queryKey } = refreshScope;
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    const isCurrent = () =>
      refreshScope.isLoaded &&
      currentRefreshScope.current === refreshScope &&
      isCurrentAuthEpoch(refreshScope.authEpoch) &&
      !isSignOutActive() &&
      query === queryClient.getQueryCache().find({ queryKey, exact: true });
    if (!isCurrent()) {
      return;
    }
    if (await refreshActiveSessionsNow(queryKey)) {
      return;
    }
    if (isCurrent()) {
      await queryClient.invalidateQueries({ queryKey, exact: true });
    }
  };

  const handleExit = () => {
    void exitRemoteSessionFromList({
      confirm: confirmExit,
      sendExit: async () => {
        await connection.sendCommand(
          session.id,
          'exit_cli',
          { protocolVersion: 1 },
          session.connectionId
        );
      },
      refreshActiveList,
      inFlight: exitingRef,
    });
  };

  const handleLongPress = () => {
    if (exitingRef.current) {
      return;
    }
    openSessionPreviewStore({
      sessionId: session.id,
      title,
      initialRenameValue: renameInitialValue,
      onOpen: () => {
        onPress(session);
      },
      live: true,
      statusKind: glanceableStatusKind(session.status),
      needsInput,
      totalCostMicrodollars: session.totalCostMicrodollars ?? null,
      onCopySessionId: () => {
        // Load the clipboard/action module at press time: the mounted row test
        // runs in a node environment that cannot load `expo-clipboard`.
        void (async () => {
          const { copySessionId } = await import('./session-row-actions');
          await copySessionId(session.id);
        })();
      },
      onViewPr: session.associatedPr
        ? () => {
            void openSessionPr(session.associatedPr?.url, t('common.pullRequest'));
          }
        : undefined,
      onRename: newTitle => {
        renameSession(session.id, newTitle);
      },
      onExit: canExit ? handleExit : undefined,
    });
  };

  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'manage') {
      handleLongPress();
    }
  };

  const handlePressIn = canManage
    ? () => {
        void prefetchSessionTranscript(
          queryClient,
          trpc.cliSessionsV2.getSessionMessages.queryOptions({ session_id: session.id })
        );
      }
    : undefined;

  return (
    <Pressable
      onPress={() => {
        onPress(session);
      }}
      onPressIn={handlePressIn}
      onLongPress={canManage ? handleLongPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={sessionRowAccessibilityLabel({
        title,
        needsInput,
        // Tray rows are always live: the glyph below draws the shared
        // derivation's kind, and the spoken label names the same state.
        live: true,
        statusKind,
        badge: agentLabel,
        meta: spokenMeta,
        subtitle: session.gitBranch ?? null,
        prNumber: spokenPrNumber,
        platform: spokenPlatform,
      })}
      accessibilityActions={
        canManage ? [{ name: 'manage', label: t('agents.sessionRow.actions') }] : undefined
      }
      onAccessibilityAction={canManage ? handleAccessibilityAction : undefined}
      className="active:opacity-70"
    >
      <SessionRow
        agentLabel={agentLabel}
        title={title}
        subtitle={subtitle}
        meta={composeActiveSessionVisibleMeta(
          formatSessionTotalCost(session.totalCostMicrodollars),
          remoteMeta(session, now)
        )}
        live
        statusKind={statusKind}
        scheduledWake={scheduledWake}
        needsInput={needsInput}
        metaWhileLive
        platformIcon={platformIcon}
        stripMode={variant === 'card' ? 'edge' : 'inline'}
        last={variant === 'card' ? true : undefined}
        className={variant === 'card' ? undefined : 'pl-[22px] pr-[22px]'}
      />
      {exitDialog}
    </Pressable>
  );
});
