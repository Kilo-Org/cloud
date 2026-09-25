import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { glanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { useOrganization } from '@/lib/organization-context';
import { type AccessibilityActionEvent, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SessionRow } from '@/components/ui/session-row';
import { refreshActiveSessionsNow } from '@/lib/active-sessions-live-sync';
import { prefetchSessionTranscript } from '@/lib/agent-session-cache';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
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
import { showRemoteSessionExitConfirmation } from './remote-session-exit-alert';
import { namedSessionTitle, useUserSessionTitlesRevision } from './session-detail-rename-state';
import {
  activeSessionMetaTimestamp,
  canExitSessionFromList,
  composeActiveSessionVisibleMeta,
  composeSessionProvenanceSubtitle,
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
  onPress: () => void;
  /** Container shape: see `RowVariant`. Defaults to `'list'`. */
  variant?: RowVariant;
  /** See `StoredSessionRowProps.interactive`. Defaults to `true`. */
  interactive?: boolean;
};

export function RemoteSessionRow({
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
  useUserSessionTitlesRevision();
  const title = namedSessionTitle(session.title, session.id) ?? t('agents.sessionRow.untitled');
  // Same seeding as the stored row: a session the backend has not named yet
  // opens an empty rename field instead of the `New session - <ISO>` machine
  // string, and the save paths reject an unchanged or blank value. A title the
  // user's own rename wrote is still seeded, so a chosen name is not blanked.
  const renameInitialValue = namedSessionTitle(session.title, session.id) ?? '';
  const canManage = interactive;
  const agentLabel = remoteSessionEyebrowLabel(session);

  const revision = useSessionAttentionRevision();
  const raiseId = session.status;
  const canExit = canExitSessionFromList(session);
  const needsInput = shouldShowNeedsInput({
    status: session.status,
    raiseId,
    isAcked: isAttentionAcked(session.id, raiseId),
  });
  useEffect(() => {
    reconcileSessionAttention(session.id, session.status, null);
  }, [session.id, session.status, revision]);

  // Spoken meta mirrors the visible meta the row renders. When `needsInput`
  // wins, the right eyebrow shows `NEEDS INPUT` and meta is NOT rendered,
  // so the label omits it. Otherwise announce the same timestamp as
  // `remoteMeta` (prefer lastActivityAt, fall back to updatedAt).
  const metaTimestamp = activeSessionMetaTimestamp(session);
  const costSpoken = formatSpokenCost(session.totalCostMicrodollars);
  const timeSpoken = metaTimestamp ? formatSpokenTimeAgo(metaTimestamp) : null;
  const spokenMeta = selectRemoteRowSpokenMeta({
    needsInput,
    costSpoken,
    timeSpoken,
  });

  // Provenance subtitle: list rows show "branch · #N", card rows keep the
  // branch-only subtitle. The spoken label mirrors this, with the PR phrase
  // only on the list variant.
  const subtitle =
    variant === 'card'
      ? (session.gitBranch ?? null)
      : composeSessionProvenanceSubtitle({
          branch: session.gitBranch,
          prNumber: session.associatedPr?.number,
        });
  const spokenPrNumber = variant === 'card' ? null : (session.associatedPr?.number ?? null);

  // Tray rows are always live: the eyebrow draws the status glyph from the
  // shared derivation, so the platform glyph has no slot beside it (and the
  // spoken label withholds the platform with the icon).
  const { iconKind: platformIconKind, spokenPlatform } = selectRowPlatformPresentation({
    platform: session.createdOnPlatform,
    variant,
    needsInput,
    statusGlyph: true,
    gitUrl: session.gitUrl,
  });
  const platformIcon =
    platformIconKind != null ? (
      <View accessible={false} testID={`platform-icon-${platformIconKind}`}>
        <SessionPlatformIcon
          platform={session.createdOnPlatform}
          size={12}
          color={colors.mutedSoft}
        />
      </View>
    ) : undefined;

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
      confirm: showRemoteSessionExitConfirmation,
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
      live: true,
      statusKind: glanceableStatusKind(session.status),
      needsInput,
      totalCostMicrodollars: session.totalCostMicrodollars ?? null,
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
      onPress={onPress}
      onPressIn={handlePressIn}
      onLongPress={canManage ? handleLongPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={sessionRowAccessibilityLabel({
        title,
        needsInput,
        // Tray rows are always live: the glyph below draws the shared
        // derivation's kind, and the spoken label names the same state.
        live: true,
        statusKind: glanceableStatusKind(session.status),
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
          remoteMeta(session)
        )}
        live
        statusKind={glanceableStatusKind(session.status)}
        needsInput={needsInput}
        metaWhileLive
        platformIcon={platformIcon}
        stripMode={variant === 'card' ? 'edge' : 'inline'}
        last={variant === 'card' ? true : undefined}
        className={variant === 'card' ? undefined : 'pl-[22px] pr-[22px]'}
      />
    </Pressable>
  );
}
