import { type ActionSheetOptions } from '@expo/react-native-action-sheet';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

export function showDeleteConfirm(onDelete: () => void) {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  Alert.alert(i18n.t('agents.sessionRow.deleteTitle'), i18n.t('agents.sessionRow.deleteMessage'), [
    { text: i18n.t('common.cancel'), style: 'cancel' },
    { text: i18n.t('agents.sessionRow.delete'), style: 'destructive', onPress: onDelete },
  ]);
}

/** iOS-only — uses Alert.prompt which is unavailable on Android. */
export function showRenamePrompt(currentTitle: string, onRename: (newTitle: string) => void) {
  Alert.prompt(
    i18n.t('agentChat.session.renameSession'),
    i18n.t('agents.sessionRow.renameMessage'),
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('agents.sessionRow.rename'),
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
    toast.success(i18n.t('agents.sessionRow.idCopied'));
  } catch {
    toast.error(i18n.t('agents.sessionRow.couldNotCopyId'));
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

  const options = [i18n.t('agents.sessionRow.copyId')];
  const handlers: (() => void)[] = [onCopySessionId];

  if (onRename) {
    options.push(i18n.t('agents.sessionRow.rename'));
    handlers.push(onRename);
  }
  if (onDelete) {
    options.push(i18n.t('agents.sessionRow.deleteSession'));
    handlers.push(onDelete);
  }
  options.push(i18n.t('common.cancel'));

  const cancelButtonIndex = options.length - 1;
  const deleteIndex = options.indexOf(i18n.t('agents.sessionRow.deleteSession'));
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
