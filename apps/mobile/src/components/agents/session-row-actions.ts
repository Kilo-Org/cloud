import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';
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
 * both exist; Exit is destructive only when Delete is absent. The preview
 * panel builds from here so its order, copy and indices cannot diverge.
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
