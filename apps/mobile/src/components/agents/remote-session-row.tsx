import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { glanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { useOrganization } from '@/lib/organization-context';
import { Platform, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RenameModal } from '@/components/rename-modal';
import { SessionRow } from '@/components/ui/session-row';
import { refreshActiveSessionsNow } from '@/lib/active-sessions-live-sync';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import { sessionDisplayTitle } from '@/lib/session-display-title';
import { useTRPC } from '@/lib/trpc';
import { exitRemoteSessionFromList } from './exit-remote-session-from-list';
import { showRemoteSessionExitConfirmation } from './remote-session-exit-alert';
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
import { type RowVariant } from './session-row';
import { copySessionId, showRenamePrompt, showSessionActionMenu } from './session-row-actions';
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

export const RemoteSessionRow = memo(function RemoteSessionRow({
  session,
  onPress,
  variant = 'list',
  interactive = true,
}: Readonly<RemoteSessionRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
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
  const [renameVisible, setRenameVisible] = useState(false);
  const canManage = interactive;

  const revision = useSessionAttentionRevision();
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

  // Every derivation below depends only on the session, the row shape and the
  // attention flag, so an unchanged payload reuses them instead of redoing the
  // Intl formatting per parent render. `t` changes identity with the language,
  // which re-derives the localized strings.
  const { title, agentLabel, canExit, statusKind, subtitle, spokenPrNumber, spokenMeta } =
    useMemo(() => {
      // Spoken meta mirrors the visible meta the row renders. When `needsInput`
      // wins, the right eyebrow shows `NEEDS INPUT` and meta is NOT rendered,
      // so the label omits it. Otherwise announce the same timestamp as
      // `remoteMeta` (prefer lastActivityAt, fall back to updatedAt).
      const metaTimestamp = activeSessionMetaTimestamp(session);
      const timeSpoken = metaTimestamp ? formatSpokenTimeAgo(metaTimestamp) : null;
      return {
        title: sessionDisplayTitle(session.title) ?? t('agents.sessionRow.untitled'),
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
        spokenMeta: selectRemoteRowSpokenMeta({
          needsInput,
          costSpoken: formatSpokenCost(session.totalCostMicrodollars),
          timeSpoken,
        }),
      };
    }, [session, variant, needsInput, t]);

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
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    showSessionActionMenu({
      showActionSheetWithOptions,
      bottomInset: bottom,
      onCopySessionId: () => {
        void copySessionId(session.id);
      },
      onRename: () => {
        if (Platform.OS === 'ios') {
          showRenamePrompt(title, newTitle => {
            renameSession(session.id, newTitle);
          });
        } else {
          setRenameVisible(true);
        }
      },
      onExit: canExit ? handleExit : undefined,
    });
  };

  return (
    <>
      <Pressable
        onPress={() => {
          onPress(session);
        }}
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
          statusKind={statusKind}
          needsInput={needsInput}
          metaWhileLive
          platformIcon={platformIcon}
          stripMode={variant === 'card' ? 'edge' : 'inline'}
          last={variant === 'card' ? true : undefined}
          className={variant === 'card' ? undefined : 'pl-[22px] pr-[22px]'}
        />
      </Pressable>

      {renameVisible && (
        <RenameModal
          title={t('agentChat.session.renameSession')}
          placeholder={t('agentChat.session.renamePlaceholder')}
          initialValue={title}
          onClose={() => {
            setRenameVisible(false);
          }}
          onSave={async name => {
            // Fire-and-forget: modal closes immediately like stored rows.
            // Mutation owns toast + cache rollback on error (r5b-3).
            renameSession(session.id, name);
            await Promise.resolve();
          }}
        />
      )}
    </>
  );
});
