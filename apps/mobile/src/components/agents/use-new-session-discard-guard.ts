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

/**
 * Protect drafts and opening pickers only. Cancelling and replaying an ordinary
 * native Back reverses its transition before removing the screen again.
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

  const [confirmVisible, setConfirmVisible] = useState(false);
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);
  const replayRef = useRef<(() => void) | null>(null);
  const [leaveCount, setLeaveCount] = useState(0);
  const pickerOpen = usePickerRouteOnTop();

  const closeConfirm = useCallback(() => {
    pendingLeaveRef.current = null;
    setConfirmVisible(false);
  }, []);

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
    setConfirmVisible(true);
  });

  useEffect(() => {
    const replay = replayRef.current;
    replayRef.current = null;
    replay?.();
  }, [leaveCount]);

  return {
    discardConfirm: confirmVisible
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
          onCancel: closeConfirm,
        })
      : null,
  };
}
