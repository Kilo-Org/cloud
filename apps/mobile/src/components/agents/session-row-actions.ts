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
    { text: i18n.t('common.delete'), style: 'destructive', onPress: onDelete },
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
        text: i18n.t('common.rename'),
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

/**
 * Copies and reports the outcome through the app-root toast. Returns whether
 * the copy succeeded — a caller inside a full-window Modal (the sheet is one
 * on Android) gets an invisible toast, so it renders its own inline feedback
 * from this result.
 */
export async function copySessionId(sessionId: string): Promise<boolean> {
  try {
    const copied = await Clipboard.setStringAsync(sessionId);
    if (!copied) {
      throw new Error('Clipboard rejected session ID');
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast.success(i18n.t('agents.sessionRow.idCopied'));
    return true;
  } catch {
    toast.error(i18n.t('agents.sessionRow.couldNotCopyId'));
    return false;
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
  /**
   * Omitted → no Exit session entry. Additive for the running-session row:
   * the old menu form (Copy / Rename / Delete / Cancel) stays unchanged for
   * callers that omit `onExit`.
   */
  onExit?: () => void;
  /** Omitted → no Delete entry. */
  onDelete?: () => void;
  /** `useSafeAreaInsets().bottom` — pads the Android custom sheet. */
  bottomInset: number;
};

/**
 * Shared session long-press menu. Builds one options list — Copy session ID,
 * optional Rename, optional Exit session, optional Delete session, Cancel —
 * and dispatches by index. Exit session is additive when `onExit` is passed;
 * callers that omit it keep the old Copy / Rename / Delete / Cancel form.
 * iOS delegates to native ActionSheetIOS via @expo/react-native-action-sheet;
 * Android gets backdrop-tap and hardware-back dismiss from the library.
 */
export function showSessionActionMenu(opts: SessionActionMenuOptions): void {
  const { showActionSheetWithOptions, onCopySessionId, onRename, onExit, onDelete, bottomInset } =
    opts;

  const options = [i18n.t('agents.sessionRow.copyId')];
  const handlers: (() => void)[] = [onCopySessionId];

  if (onRename) {
    options.push(i18n.t('common.rename'));
    handlers.push(onRename);
  }
  if (onExit) {
    options.push(i18n.t('agentChat.remoteSession.exitSession'));
    handlers.push(onExit);
  }
  if (onDelete) {
    options.push(i18n.t('agents.sessionRow.deleteSession'));
    handlers.push(onDelete);
  }
  options.push(i18n.t('common.cancel'));

  const cancelButtonIndex = options.length - 1;
  const deleteIndex = options.indexOf(i18n.t('agents.sessionRow.deleteSession'));
  const exitIndex = options.indexOf(i18n.t('agentChat.remoteSession.exitSession'));
  // Delete wins when both exist; Exit is destructive only when Delete is absent.
  const destructiveButtonIndex = [deleteIndex, exitIndex].find(index => index !== -1);

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
