import { type ActionSheetOptions } from '@expo/react-native-action-sheet';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';
import { toast } from 'sonner-native';

export function showDeleteConfirm(onDelete: () => void) {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  Alert.alert('Delete session?', 'This cannot be undone.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onDelete },
  ]);
}

/** iOS-only — uses Alert.prompt which is unavailable on Android. */
export function showRenamePrompt(currentTitle: string, onRename: (newTitle: string) => void) {
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

export async function copySessionId(sessionId: string) {
  try {
    const copied = await Clipboard.setStringAsync(sessionId);
    if (!copied) {
      throw new Error('Clipboard rejected session ID');
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast.success('Session ID copied');
  } catch {
    toast.error('Could not copy session ID');
  }
}

type SessionActionMenuOptions = {
  showActionSheetWithOptions: (
    options: ActionSheetOptions,
    onSelect: (index?: number) => void
  ) => void;
  onCopySessionId: () => void;
  /** Omitted → no Rename entry. */
  onRename?: () => void;
  /** Omitted → no Delete entry. */
  onDelete?: () => void;
  /** `useSafeAreaInsets().bottom` — pads the Android custom sheet. */
  bottomInset: number;
};

/**
 * Shared session long-press menu. Builds one options list — Copy session ID,
 * optional Rename, optional Delete session, Cancel — and dispatches by index.
 * iOS delegates to native ActionSheetIOS via @expo/react-native-action-sheet;
 * Android gets backdrop-tap and hardware-back dismiss from the library.
 */
export function showSessionActionMenu(opts: SessionActionMenuOptions): void {
  const { showActionSheetWithOptions, onCopySessionId, onRename, onDelete, bottomInset } = opts;

  const options = ['Copy session ID'];
  const handlers: (() => void)[] = [onCopySessionId];

  if (onRename) {
    options.push('Rename');
    handlers.push(onRename);
  }
  if (onDelete) {
    options.push('Delete session');
    handlers.push(onDelete);
  }
  options.push('Cancel');

  const cancelButtonIndex = options.length - 1;
  const deleteIndex = options.indexOf('Delete session');
  const destructiveButtonIndex = deleteIndex === -1 ? undefined : deleteIndex;

  showActionSheetWithOptions(
    {
      options,
      cancelButtonIndex,
      ...(destructiveButtonIndex !== undefined && { destructiveButtonIndex }),
      containerStyle: { paddingBottom: bottomInset },
    },
    index => {
      if (index === undefined || index === cancelButtonIndex) {
        return;
      }
      handlers[index]?.();
    }
  );
}
