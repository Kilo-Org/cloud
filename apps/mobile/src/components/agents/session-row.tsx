import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Modal, Platform, Pressable, TextInput, View } from 'react-native';
import { MoreVertical } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

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
  };
  onPress: () => void;
};

function LiveDot() {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.4, { duration: 1000 }), -1, true);
  }, [opacity]);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return <Animated.View style={pulseStyle} className="h-2 w-2 rounded-full bg-green-500" />;
}

function formatSubtitle(session: StoredSessionRowProps['session']): string {
  const parts: string[] = [];
  if (session.status) {
    parts.push(session.status);
  }
  if (session.git_branch) {
    parts.push(session.git_branch);
  }
  parts.push(session.created_on_platform);
  return parts.join(' · ');
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

  const handleRenameConfirm = () => {
    const newName = renameTextRef.current.trim();
    setRenameVisible(false);
    if (newName && newName !== title) {
      onRename(newName);
    }
  };

  const handleMorePress = () => {
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
        className="flex-row items-center gap-3 px-4 py-3 active:bg-secondary"
        onPress={onPress}
        onLongPress={handleMorePress}
        accessibilityLabel={title}
      >
        {isLive ? <LiveDot /> : <View className="h-2 w-2" />}
        <View className="flex-1 gap-0.5">
          <Text className="text-sm font-medium" numberOfLines={1}>
            {title}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {formatSubtitle(session)}
          </Text>
        </View>
        <View className="flex-row items-center gap-1">
          <Text className="text-xs text-muted-foreground">
            {timeAgo(parseTimestamp(session.updated_at))}
          </Text>
          <Pressable
            onPress={e => {
              e.stopPropagation();
              handleMorePress();
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Session actions"
          >
            <MoreVertical size={16} color={colors.mutedForeground} />
          </Pressable>
        </View>
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
          <View className="w-full rounded-xl bg-card p-5 gap-4">
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
    <Pressable
      className="flex-row items-center gap-3 px-4 py-3 active:bg-secondary"
      onPress={onPress}
      accessibilityLabel={title}
    >
      <LiveDot />
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-medium" numberOfLines={1}>
          {title}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {session.status}
        </Text>
      </View>
    </Pressable>
  );
}
