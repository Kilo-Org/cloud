import { useNavigation, usePreventRemove, useRouter } from 'expo-router';
import {
  createElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AppState, type HostInstance, Keyboard, Platform, TextInput } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { toast } from 'sonner-native';

import { DestructiveConfirmDialog } from '@/components/destructive-confirm-dialog';
import { usePickerRouteOnTop } from '@/components/agents/use-picker-above-guard';
import { i18n } from '@/i18n';
import { isLeaveAction } from '@/lib/navigation/leave-actions';
import { pickerRouteOnTop } from '@/lib/picker-routes';

type NewSessionDiscardGuard = {
  /** The native discard sheet; null while closed. */
  discardConfirm: ReactNode;
};

type ConfirmPhase = 'closed' | 'awaiting-keyboard' | 'open';

/**
 * Focuses an input once the app window holds focus. Android reports the sheet's
 * dismissal while the sheet's dialog window still holds focus, and it ignores a
 * keyboard request from an unfocused window, so the refocus waits for the
 * window's own focus event there.
 */
function useFocusInputInFocusedWindow(): (input: HostInstance) => void {
  const windowFocusedRef = useRef(true);
  const queuedInputRef = useRef<HostInstance | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const subscriptions = [
      AppState.addEventListener('blur', () => {
        windowFocusedRef.current = false;
      }),
      AppState.addEventListener('focus', () => {
        windowFocusedRef.current = true;
        const input = queuedInputRef.current;
        queuedInputRef.current = null;
        if (input) {
          TextInput.State.focusTextInput(input);
        }
      }),
    ];
    return () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
    };
  }, []);

  return useCallback((input: HostInstance) => {
    if (windowFocusedRef.current) {
      TextInput.State.focusTextInput(input);
      return;
    }
    queuedInputRef.current = input;
  }, []);
}

/**
 * Protect drafts and opening pickers only. Cancelling and replaying an ordinary
 * native Back reverses its transition before removing the screen again.
 *
 * The confirm waits for the keyboard to finish closing: a sheet presented over
 * the keyboard takes window focus, which drops the keyboard in one frame and
 * moves the sheet down after it. Keep editing refocuses the prompt only after
 * the sheet's own dismissal, so the keyboard never rises behind a leaving sheet.
 */
export function useNewSessionDiscardGuard({
  dirty,
  hasUnclaimedAttachments = false,
  onDiscard,
  onSaveAsTodo,
  skipNextGuardRef,
}: Readonly<{
  dirty: boolean;
  /** True when the composer holds admitted-but-unsent uploads; names them in the copy. */
  hasUnclaimedAttachments?: boolean;
  onDiscard: () => Promise<void>;
  /**
   * Offers "Save as to-do" beside Discard. The caller saves the draft, then
   * calls `leave`, which discards the draft and replays the intercepted leave.
   */
  onSaveAsTodo?: (leave: () => void) => void;
  skipNextGuardRef: RefObject<boolean>;
}>): NewSessionDiscardGuard {
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;

  const [confirmPhase, setConfirmPhase] = useState<ConfirmPhase>('closed');
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);
  const focusedInputRef = useRef<HostInstance | null | undefined>(null);
  const replayRef = useRef<(() => void) | null>(null);
  const [leaveCount, setLeaveCount] = useState(0);
  const pickerOpen = usePickerRouteOnTop();
  const keyboardVisible = useKeyboardState(state => state.isVisible);
  const focusInput = useFocusInputInFocusedWindow();

  if (confirmPhase === 'awaiting-keyboard' && !keyboardVisible) {
    setConfirmPhase('open');
  }

  useEffect(() => {
    if (confirmPhase !== 'awaiting-keyboard') {
      return undefined;
    }
    // An interactive hide can miss its completion event. Never trap the draft
    // behind that event; a repeated Back also opens the confirm immediately.
    const timeout = setTimeout(() => {
      setConfirmPhase('open');
    }, 1000);
    return () => {
      clearTimeout(timeout);
    };
  }, [confirmPhase]);

  const closeConfirm = useCallback(() => {
    pendingLeaveRef.current = null;
    focusedInputRef.current = null;
    setConfirmPhase('closed');
  }, []);

  const keepEditing = useCallback(() => {
    const input = focusedInputRef.current;
    closeConfirm();
    if (input) {
      focusInput(input);
    }
  }, [closeConfirm, focusInput]);

  const discardAndLeave = useCallback((leave: () => void) => {
    void (async () => {
      try {
        await onDiscardRef.current();
        leave();
      } catch {
        toast.error(i18n.t('agentChat.newSession.discardFailed'));
      }
    })();
  }, []);

  const confirmDiscard = useCallback(() => {
    const leave = pendingLeaveRef.current;
    if (leave === null) {
      return;
    }
    closeConfirm();
    discardAndLeave(leave);
  }, [closeConfirm, discardAndLeave]);

  const saveAsTodo = useCallback(() => {
    const leave = pendingLeaveRef.current;
    if (leave === null || !onSaveAsTodo) {
      return;
    }
    closeConfirm();
    onSaveAsTodo(() => {
      discardAndLeave(leave);
    });
  }, [closeConfirm, discardAndLeave, onSaveAsTodo]);

  const navigation = useNavigation();
  const router = useRouter();

  usePreventRemove((dirty || pickerOpen) && !leaveAllowed, ({ data, repeat }) => {
    const leave = () => {
      replayRef.current = repeat;
      setLeaveAllowed(true);
      setLeaveCount(count => count + 1);
    };
    if (isLeaveAction(data.action.type) && pickerRouteOnTop(navigation.getState())) {
      // Back while the picker is still presenting: pop the picker, the path
      // its own Done control uses. This screen and its draft stay.
      router.back();
      return;
    }
    if (skipNextGuardRef.current) {
      skipNextGuardRef.current = false;
      leave();
      return;
    }
    if (!dirty || !isLeaveAction(data.action.type)) {
      leave();
      return;
    }
    pendingLeaveRef.current = leave;
    if (confirmPhase === 'awaiting-keyboard') {
      setConfirmPhase('open');
      return;
    }
    if (confirmPhase === 'open') {
      return;
    }
    if (!keyboardVisible) {
      setConfirmPhase('open');
      return;
    }
    focusedInputRef.current = TextInput.State.currentlyFocusedInput();
    Keyboard.dismiss();
    setConfirmPhase('awaiting-keyboard');
  });

  useEffect(() => {
    const replay = replayRef.current;
    replayRef.current = null;
    replay?.();
  }, [leaveCount]);

  return {
    discardConfirm:
      confirmPhase === 'open'
        ? createElement(DestructiveConfirmDialog, {
            title: i18n.t('agentChat.newSession.discardDraftTitle'),
            message: i18n.t(
              hasUnclaimedAttachments
                ? 'agentChat.newSession.discardWithUploadsMessage'
                : 'agentChat.newSession.discardDraftMessage'
            ),
            confirmLabel: i18n.t('common.discard'),
            cancelLabel: i18n.t('common.keepEditing'),
            extraAction: onSaveAsTodo
              ? { label: i18n.t('todos.saveAsTodo'), onPress: saveAsTodo }
              : undefined,
            onConfirm: confirmDiscard,
            onCancel: keepEditing,
          })
        : null,
  };
}
