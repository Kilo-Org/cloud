import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Modal, Platform, Pressable, TextInput, View } from 'react-native';

import { SessionRow } from '@/components/ui/session-row';
import { Text } from '@/components/ui/text';
import { type AgentSessionSortBy, getAgentSessionTimestamp } from '@/lib/agent-session-sort';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import {
  composeStoredSessionSpokenMeta,
  composeStoredSessionVisibleMeta,
  formatMeta,
  formatSessionListCost,
  platformLabel,
} from './session-list-helpers';
import {
  formatSpokenCost,
  formatSpokenTimeAgo,
  sessionRowAccessibilityLabel,
} from './session-row-accessibility-label';
import { copySessionId } from './session-row-actions';

type StoredSessionRowProps = {
  session: {
    session_id: string;
    title: string | null;
    git_url: string | null;
    cloud_agent_session_id: string | null;
    created_on_platform: string;
    created_at: string;
    updated_at: string;
    git_branch: string | null;
    status: string | null;
    status_updated_at: string | null;
    total_cost_microdollars: number | null;
  };
  /**
   * Which timestamp drives the row's relative meta label. The list
   * section the session lands in and the timestamp shown here are
   * both computed from this same field, so the two never contradict.
   */
  sortBy: AgentSessionSortBy;
  onPress: () => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
};

function showDeleteConfirm(onDelete: () => void) {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  Alert.alert('Delete session?', 'This cannot be undone.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onDelete },
  ]);
}

/** iOS-only — uses Alert.prompt which is unavailable on Android. */
function showRenamePrompt(currentTitle: string, onRename: (newTitle: string) => void) {
  Alert.prompt(
    'Rename session',
    'Enter a new name for this session',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Rename',
        onPress: (newName: string | undefined) => {
          if (newName?.trim()) {
            onRename(newName.trim());
          }
        },
      },
    ],
    'plain-text',
    currentTitle
  );
}

export function StoredSessionRow({
  session,
  sortBy,
  onPress,
  onDelete,
  onRename,
}: Readonly<StoredSessionRowProps>) {
  const colors = useThemeColors();
  const title = session.title && session.title.length > 0 ? session.title : 'Untitled session';
  const [renameVisible, setRenameVisible] = useState(false);
  const renameTextRef = useRef(title);
  const agentLabel = platformLabel(session.created_on_platform);
  const timestamp = getAgentSessionTimestamp(session, sortBy);

  const revision = useSessionAttentionRevision();
  const raiseId = session.status_updated_at ?? session.status ?? null;
  const needsInput = shouldShowNeedsInput({
    status: session.status,
    raiseId,
    isAcked: isAttentionAcked(session.session_id, raiseId),
  });
  useEffect(() => {
    reconcileSessionAttention(session.session_id, session.status, session.status_updated_at);
  }, [session.session_id, session.status, session.status_updated_at, revision]);

  const handleRenameConfirm = () => {
    const newName = renameTextRef.current.trim();
    setRenameVisible(false);
    if (newName && newName !== title) {
      onRename(newName);
    }
  };

  const handleLongPress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Copy session ID', 'Rename', 'Delete session', 'Cancel'],
          cancelButtonIndex: 3,
          destructiveButtonIndex: 2,
        },
        buttonIndex => {
          if (buttonIndex === 0) {
            void copySessionId(session.session_id);
          } else if (buttonIndex === 1) {
            showRenamePrompt(title, onRename);
          } else if (buttonIndex === 2) {
            showDeleteConfirm(onDelete);
          }
        }
      );
    } else {
      Alert.alert('Session actions', undefined, [
        {
          text: 'Copy session ID',
          onPress: () => {
            void copySessionId(session.session_id);
          },
        },
        {
          text: 'Rename',
          onPress: () => {
            renameTextRef.current = title;
            setRenameVisible(true);
          },
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            showDeleteConfirm(onDelete);
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  // Visible and spoken meta mirror `formatMeta(timestamp)`. When `needsInput`
  // wins, the right eyebrow shows `NEEDS INPUT` and meta is NOT rendered.
  // When a cost is present, both forms fold it in first (matches the row's
  // "$0.12 · time" order). Needs-input sessions have no persisted cost.
  const visibleMeta = composeStoredSessionVisibleMeta(
    formatSessionListCost(session.total_cost_microdollars),
    formatMeta(timestamp)
  );
  const spokenMeta = needsInput
    ? null
    : composeStoredSessionSpokenMeta(
        formatSpokenCost(session.total_cost_microdollars),
        formatSpokenTimeAgo(timestamp)
      );

  return (
    <>
      <Pressable
        onPress={onPress}
        onLongPress={handleLongPress}
        accessibilityLabel={sessionRowAccessibilityLabel({
          title,
          needsInput,
          badge: agentLabel,
          meta: spokenMeta,
        })}
        className="active:opacity-70"
      >
        <SessionRow
          agentLabel={agentLabel}
          title={title}
          subtitle={session.git_branch}
          meta={visibleMeta}
          needsInput={needsInput}
          stripMode="inline"
          className="pl-[22px] pr-[22px]"
        />
      </Pressable>

      <Modal
        visible={renameVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setRenameVisible(false);
        }}
      >
        <View className="flex-1 items-center justify-center bg-black/50 px-8">
          <View className="w-full gap-4 rounded-xl bg-card p-5">
            <Text className="text-base font-semibold">Rename session</Text>
            <TextInput
              defaultValue={title}
              onChangeText={text => {
                renameTextRef.current = text;
              }}
              onSubmitEditing={handleRenameConfirm}
              returnKeyType="done"
              autoFocus
              className="rounded-lg border border-border px-3 py-2.5 text-sm leading-5 text-foreground"
              placeholderTextColor={colors.mutedForeground}
              selectionColor={colors.primary}
            />
            <View className="flex-row justify-end gap-4">
              <Pressable
                onPress={() => {
                  setRenameVisible(false);
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                className="active:opacity-70"
              >
                <Text className="text-sm text-muted-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleRenameConfirm}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Rename"
                className="active:opacity-70"
              >
                <Text className="text-sm font-semibold text-primary">Rename</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
