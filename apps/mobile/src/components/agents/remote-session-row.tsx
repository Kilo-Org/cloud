import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable } from 'react-native';

import { SessionRow } from '@/components/ui/session-row';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import { remoteAgentLabel, remoteMeta } from './session-list-helpers';
import { copySessionId } from './session-row-actions';
import {
  formatSpokenTimeAgo,
  sessionRowAccessibilityLabel,
} from './session-row-accessibility-label';

type RemoteSessionRowProps = {
  session: ActiveSession;
  onPress: () => void;
};

export function RemoteSessionRow({ session, onPress }: Readonly<RemoteSessionRowProps>) {
  const title = session.title.length > 0 ? session.title : 'Untitled session';

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
  // so the label omits it. The remote row's `live` eyebrow (`live-and-meta`)
  // renders the timestamp when `updatedAt` is present, otherwise the
  // uppercased status. For speech we expand the timestamp via
  // `formatSpokenTimeAgo` and lowercase/underscore-strip the status so
  // VoiceOver doesn't read it letter-by-letter.
  let spokenMeta: string | null = null;
  if (!needsInput) {
    spokenMeta = session.updatedAt
      ? formatSpokenTimeAgo(session.updatedAt)
      : session.status.toLowerCase().replaceAll('_', ' ');
  }

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
      onLongPress={handleLongPress}
      accessibilityLabel={sessionRowAccessibilityLabel({
        title,
        needsInput,
        badge: remoteAgentLabel(session.createdOnPlatform),
        meta: spokenMeta,
      })}
      className="active:opacity-70"
    >
      <SessionRow
        agentLabel={remoteAgentLabel(session.createdOnPlatform)}
        title={title}
        subtitle={session.gitBranch ?? null}
        meta={remoteMeta(session)}
        live
        needsInput={needsInput}
        metaWhileLive
        stripMode="inline"
        className="pl-[22px] pr-[22px]"
      />
    </Pressable>
  );
}
