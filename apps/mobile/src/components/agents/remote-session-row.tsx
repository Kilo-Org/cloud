import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, View } from 'react-native';

import { SessionRow } from '@/components/ui/session-row';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import { remoteMeta, remoteSessionEyebrowLabel } from './session-list-helpers';
import { selectRowPlatformPresentation, SessionPlatformIcon } from './session-platform-icon';
import { type RowVariant } from './session-row';
import { copySessionId } from './session-row-actions';
import {
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
  const title = session.title.length > 0 ? session.title : 'Untitled session';
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
  // so the label omits it. Otherwise announce the relative timestamp only
  // when `updatedAt` is present — never the CLI status (same as `remoteMeta`).
  const spokenMeta =
    !needsInput && session.updatedAt ? formatSpokenTimeAgo(session.updatedAt) : null;

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

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Copy session ID', 'Cancel'], cancelButtonIndex: 1 },
        buttonIndex => {
          if (buttonIndex === 0) {
            void copySessionId(session.id);
          }
        }
      );
    } else {
      Alert.alert('Session actions', undefined, [
        {
          text: 'Copy session ID',
          onPress: () => {
            void copySessionId(session.id);
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={canManage ? handleLongPress : undefined}
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
        meta={remoteMeta(session)}
        live
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
