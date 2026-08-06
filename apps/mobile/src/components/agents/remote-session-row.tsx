import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RenameModal } from '@/components/rename-modal';
import { SessionRow } from '@/components/ui/session-row';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { useAppActionSheet } from '@/lib/a11y/motion';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import {
  activeSessionMetaTimestamp,
  composeActiveSessionVisibleMeta,
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
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useAppActionSheet();
  const { renameSession } = useSessionMutations();
  const title = session.title.length > 0 ? session.title : 'Untitled session';
  const [renameVisible, setRenameVisible] = useState(false);
  const canManage = interactive;
  const agentLabel = remoteSessionEyebrowLabel(session);

  const revision = useSessionAttentionRevision();
  const raiseId = session.status;
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

  const { iconKind: platformIconKind, spokenPlatform } = selectRowPlatformPresentation({
    platform: session.createdOnPlatform,
    variant,
    needsInput,
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

  const handleLongPress = () => {
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
    });
  };

  return (
    <>
      <Pressable
        onPress={onPress}
        onLongPress={canManage ? handleLongPress : undefined}
        accessibilityRole="button"
        accessibilityLabel={sessionRowAccessibilityLabel({
          title,
          needsInput,
          badge: agentLabel,
          meta: spokenMeta,
          platform: spokenPlatform,
        })}
        className="active:opacity-70"
      >
        <SessionRow
          agentLabel={agentLabel}
          title={title}
          subtitle={session.gitBranch ?? null}
          meta={composeActiveSessionVisibleMeta(
            formatSessionTotalCost(session.totalCostMicrodollars),
            remoteMeta(session)
          )}
          live
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
          title="Rename session"
          placeholder="Session name"
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
}
