import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Modal, Platform, Pressable, TextInput, View } from 'react-native';

import { SessionRow } from '@/components/ui/session-row';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseTimestamp, timeAgo } from '@/lib/utils';

type StoredSessionRowProps = {
  session: {
    session_id: string;
    title: string | null;
    git_url: string | null;
    cloud_agent_session_id: string | null;
    created_on_platform: string;
    updated_at: string;
    git_branch: string | null;
    status: string | null;
  };
  isLive: boolean;
  onPress: () => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
};

type RemoteSessionRowProps = {
  session: {
    id: string;
    title: string;
    status: string;
    gitBranch?: string;
  };
  onPress: () => void;
};

/**
 * Map backend `created_on_platform` strings to a pretty uppercase label
 * for the row eyebrow. The row's hue is hashed from this label.
 */
function platformLabel(platform: string): string {
  switch (platform) {
    case 'cloud-agent':
    case 'cloud-agent-web': {
      return 'CLOUD AGENT';
    }
    case 'vscode':
    case 'agent-manager': {
      return 'VSCODE';
    }
    case 'slack': {
      return 'SLACK';
    }
    case 'cli': {
      return 'CLI';
    }
    default: {
      return platform.toUpperCase();
    }
  }
}

function formatMeta(updatedAt: string): string {
  return timeAgo(parseTimestamp(updatedAt)).toUpperCase();
}

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
    'Rename Session',
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
  isLive,
  onPress,
  onDelete,
  onRename,
}: Readonly<StoredSessionRowProps>) {
  const colors = useThemeColors();
  const title = session.title && session.title.length > 0 ? session.title : 'Untitled session';
  const [renameVisible, setRenameVisible] = useState(false);
  const renameTextRef = useRef(title);
  const agentLabel = platformLabel(session.created_on_platform);

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
          options: ['Rename', 'Delete session', 'Cancel'],
          cancelButtonIndex: 2,
          destructiveButtonIndex: 1,
        },
        buttonIndex => {
          if (buttonIndex === 0) {
            showRenamePrompt(title, onRename);
          } else if (buttonIndex === 1) {
            showDeleteConfirm(onDelete);
          }
        }
      );
    } else {
      Alert.alert('Session actions', undefined, [
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

  return (
    <>
      <Pressable
        onPress={onPress}
        onLongPress={handleLongPress}
        accessibilityLabel={title}
        className="active:opacity-70"
      >
        <SessionRow
          agentLabel={agentLabel}
          title={title}
          subtitle={session.git_branch}
          meta={formatMeta(session.updated_at)}
          live={isLive}
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
            <Text className="text-base font-semibold">Rename Session</Text>
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
              >
                <Text className="text-sm text-muted-foreground">Cancel</Text>
              </Pressable>
              <Pressable onPress={handleRenameConfirm} hitSlop={8}>
                <Text className="text-sm font-semibold text-primary">Rename</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

export function RemoteSessionRow({ session, onPress }: Readonly<RemoteSessionRowProps>) {
  const title = session.title.length > 0 ? session.title : 'Untitled session';

  return (
    <Pressable onPress={onPress} accessibilityLabel={title} className="active:opacity-70">
      <SessionRow
        agentLabel="CLOUD AGENT"
        title={title}
        subtitle={session.gitBranch}
        meta={session.status.toUpperCase()}
        live
        stripMode="inline"
        className="pl-[22px] pr-[22px]"
      />
    </Pressable>
  );
}
