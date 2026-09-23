import { type ActionSheetOptions } from '@expo/react-native-action-sheet';
import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { type ThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';

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
          const trimmed = newName?.trim();
          // Same guard as `RenameModal`: a no-edit confirm must not persist the
          // seeded value. Without it, confirming the prefilled untitled copy
          // would store that localized string as the session's real title.
          if (trimmed && trimmed !== currentTitle.trim()) {
            onRename(trimmed);
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

/**
 * Copies the session's resume link — the same universal link the OS handoff
 * advertises (`sessionResumeUrl`), anchored at the position the transcript is
 * showing — and returns whether it succeeded. No toast: the copy-link row
 * lives inside the context sheet, whose Modal window hides app-root toasts, so
 * the caller renders the outcome inline from this result.
 */
export async function copySessionLink(
  sessionId: string,
  anchorMessageId: string | null
): Promise<boolean> {
  try {
    const copied = await Clipboard.setStringAsync(sessionResumeUrl({ sessionId, anchorMessageId }));
    if (!copied) {
      throw new Error('Clipboard rejected session link');
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return true;
  } catch {
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
  /** Themed sheet base options (`useThemedActionSheetOptions()`), spread first. */
  themedSheet: ThemedActionSheetOptions;
};

export type SessionActionMenuItem = {
  key: 'copyId' | 'rename' | 'exit' | 'delete';
  label: string;
  destructive: boolean;
  run: () => void;
};

export type SessionActionMenu = {
  items: SessionActionMenuItem[];
  cancelLabel: string;
};

/**
 * The one session action set, in today's order: Copy session ID, optional
 * Rename, optional Exit session, optional Delete session. Delete wins when
 * both exist; Exit is destructive only when Delete is absent. The panel and
 * the sheet both build from here so their order, copy and indices cannot
 * diverge.
 */
export function buildSessionActionMenuItems(input: {
  onCopySessionId: () => void;
  onRename?: () => void;
  onExit?: () => void;
  onDelete?: () => void;
}): SessionActionMenu {
  const items: SessionActionMenuItem[] = [
    {
      key: 'copyId',
      label: i18n.t('agents.sessionRow.copyId'),
      destructive: false,
      run: input.onCopySessionId,
    },
  ];

  if (input.onRename) {
    items.push({
      key: 'rename',
      label: i18n.t('common.rename'),
      destructive: false,
      run: input.onRename,
    });
  }
  if (input.onExit) {
    items.push({
      key: 'exit',
      label: i18n.t('agentChat.remoteSession.exitSession'),
      destructive: input.onDelete === undefined,
      run: input.onExit,
    });
  }
  if (input.onDelete) {
    items.push({
      key: 'delete',
      label: i18n.t('agents.sessionRow.deleteSession'),
      destructive: true,
      run: input.onDelete,
    });
  }

  return { items, cancelLabel: i18n.t('common.cancel') };
}

/**
 * Shared session long-press menu. Builds one options list — Copy session ID,
 * optional Rename, optional Exit session, optional Delete session, Cancel —
 * and dispatches by index. Exit session is additive when `onExit` is passed;
 * callers that omit it keep the old Copy / Rename / Delete / Cancel form.
 * iOS delegates to native ActionSheetIOS via @expo/react-native-action-sheet;
 * Android gets backdrop-tap and hardware-back dismiss from the library.
 */
export function showSessionActionMenu(opts: SessionActionMenuOptions): void {
  const { showActionSheetWithOptions, themedSheet } = opts;

  const { items, cancelLabel } = buildSessionActionMenuItems({
    onCopySessionId: opts.onCopySessionId,
    onRename: opts.onRename,
    onExit: opts.onExit,
    onDelete: opts.onDelete,
  });

  const options = [...items.map(item => item.label), cancelLabel];
  const cancelButtonIndex = options.length - 1;
  const destructiveButtonIndex = items.findIndex(item => item.destructive);

  showActionSheetWithOptions(
    {
      ...themedSheet,
      options,
      cancelButtonIndex,
      ...(destructiveButtonIndex !== -1 && { destructiveButtonIndex }),
    },
    index => {
      if (index === undefined || index === cancelButtonIndex) {
        return;
      }
      items[index]?.run();
    }
  );
}
