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

import { RenameModal } from '@/components/rename-modal';
import { SessionRow } from '@/components/ui/session-row';
import { refreshActiveSessionsNow } from '@/lib/active-sessions-live-sync';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import { useTRPC } from '@/lib/trpc';
import { exitRemoteSessionFromList } from './exit-remote-session-from-list';
import { showRemoteSessionExitConfirmation } from './remote-session-exit-alert';
import {
  namedSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
  useUserSessionTitlesRevision,
} from './session-detail-rename-state';
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
  const themedSheet = useThemedActionSheetOptions();
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
  const [renameVisible, setRenameVisible] = useState(false);
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

  // Every derivation below depends only on the session, the row shape, the
  // attention flag, the recorded-titles revision and the sampled clock, so an
  // unchanged payload reuses them instead of redoing the Intl formatting per
  // parent render. `t` changes identity with the language, which re-derives the
  // localized strings.
  const { title, agentLabel, canExit, statusKind, subtitle, spokenPrNumber, spokenMeta } =
    useMemo(() => {
      // Spoken meta mirrors the visible meta the row renders. When `needsInput`
      // wins, the right eyebrow shows `NEEDS INPUT` and meta is NOT rendered,
      // so the label omits it. Otherwise announce the same timestamp as
      // `remoteMeta` (prefer lastActivityAt, fall back to updatedAt).
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
        spokenMeta: selectRemoteRowSpokenMeta({
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
      themedSheet,
      onCopySessionId: () => {
        void copySessionId(session.id);
      },
      onRename: () => {
        if (Platform.OS === 'ios') {
          showRenamePrompt(renameInitialValue, newTitle => {
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
            remoteMeta(session, now)
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
          initialValue={renameInitialValue}
          maxLength={SESSION_TITLE_MAX_LENGTH}
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
