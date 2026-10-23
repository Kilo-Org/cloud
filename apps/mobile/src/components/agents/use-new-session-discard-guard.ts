import { useNavigation, usePreventRemove, useRouter } from 'expo-router';
import {
  createElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner-native';

import { DestructiveConfirmDialog } from '@/components/destructive-confirm-dialog';
import { i18n } from '@/i18n';
import { isLeaveAction } from '@/lib/navigation/leave-actions';
import { pickerRouteOnTop } from '@/lib/picker-routes';

type NewSessionDiscardGuard = {
  /**
   * The discard confirm the screen mounts once (a Modal overlay, so the
   * composer behind it keeps its layout); null while the confirm is closed.
   */
  discardConfirm: ReactNode;
};

/**
 * New-session discard confirm. Registers a predictive-Back-safe guard via
 * `usePreventRemove`, which fires for every way the screen can be removed —
 * header back, Android hardware back, and the iOS swipe-back gesture — so all
 * three paths get the same confirmation instead of only the header button.
 * Forward navigation (any other action type) is replayed unconfirmed: the
 * durable draft survives the leave.
 *
 * Follows the `usePreventRemove` interception of `useSettingsBackGuard` without
 * any Security-specific helpers, but renders the in-app confirm instead of
 * `Alert.alert`: when the prompt is non-empty (`dirty`), the exit is intercepted
 * and the user chooses Keep editing (dismiss, draft intact) or Discard. On
 * Discard the caller's `onDiscard` runs first — clear the stored draft and reset
 * the route-owned prompt ref — and only then is the captured navigation action
 * replayed.
 *
 * `skipNextGuardRef` is the caller's bypass: set it true right before a
 * successful Start/spawn navigation (`router.replace`) so the leave is not
 * intercepted as an abandon. The callback consumes it on the next removal and
 * replays the action, because the removal was already prevented.
 *
 * A Discard whose `onDiscard` rejects keeps the screen (no dispatch) and
 * toasts, so a failed draft clear never loses the prompt.
 *
 * The confirm is the in-app `DestructiveConfirmDialog` on both iOS and
 * Android — one implementation, not the native `Alert.alert`. A platform fork
 * would be needed only if a platform lacked the capability, and the reason we
 * cannot use the native alert is a platform limitation on Android: its native
 * `AlertDialog` paints every button with the theme accent, so `Alert.alert`'s
 * `style: 'destructive'` never reaches the screen there and the discarding
 * choice loses its red affordance. iOS honors `style: 'destructive'`, but one
 * cross-platform dialog keeps the affordance identical on both. It carries the
 * destructive red fill and a neutral outline, with `common.keepEditing` as the
 * safe choice here. The hook holds the intercepted leave
 * while the confirm is open and returns the `discardConfirm` node the caller
 * mounts; it is null while the confirm is closed.
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
  // Keep the latest onDiscard in a ref so the callback below doesn't depend on
  // it directly — onDiscard is a fresh closure every render. usePreventRemove
  // already keeps the callback itself fresh via useLatestCallback, but the ref
  // keeps onDiscard stable without re-registering.
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;

  // The intercepted leave is held here until the in-app confirm resolves.
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);

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
        // The clear failed: stay on the screen so the draft is kept and the
        // user can retry by leaving again or keep editing.
        toast.error(i18n.t('agentChat.newSession.discardFailed'));
      }
    })();
  }, []);

  const confirmDiscard = useCallback(() => {
    const leave = pendingLeaveRef.current;
    if (leave === null) {
      return;
    }
    // Close first: the choice is made, and a second press must not clear or
    // leave twice.
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

  // Armed for every removal, not only while the prompt is non-empty: a Back
  // that lands while one of this screen's pickers is still presenting arrives
  // before this screen has re-rendered, so the picker can only be read from the
  // live navigation state at that moment. Every other removal is replayed.
  usePreventRemove(!leaveAllowed, ({ data, repeat }) => {
    const leave = () => {
      setLeaveAllowed(true);
      repeat();
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
