import { useNavigation } from 'expo-router';
import {
  createElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from 'react';
import { Alert, Platform } from 'react-native';
import { toast } from 'sonner-native';

import { DestructiveConfirmDialog } from '@/components/destructive-confirm-dialog';
import { i18n } from '@/i18n';
import { usePreventRemove } from '@/lib/navigation/prevent-remove';

/**
 * The captured navigation action the confirm will replay. Derived from
 * `usePreventRemove`'s own callback type so this file keeps the single deep
 * import (see `prevent-remove.ts`) instead of reaching into react-navigation.
 */
type PreventedLeaveAction = Parameters<Parameters<typeof usePreventRemove>[1]>[0]['data']['action'];

type NewSessionDiscardGuard = {
  /**
   * The Android discard confirm the screen mounts once (a Modal overlay, so the
   * composer behind it keeps its layout); null on iOS and while the confirm is
   * closed.
   */
  discardConfirm: ReactNode;
};

/**
 * Navigation action types that mean "the user is leaving this screen": the
 * header back button and Android hardware back (`GO_BACK`), the iOS swipe-back
 * gesture and programmatic `router.back()` (`POP`). Every other action that
 * can remove this screen — a `NAVIGATE`/`PUSH` to another route (e.g. tapping
 * Preferences from the tab bar behind this screen), a `RESET` — is forward
 * navigation: the user is going somewhere else, not abandoning the prompt.
 * The draft is durable (saved on every change), so a forward leave loses
 * nothing and must not be blocked by a discard confirm (spot check
 * e12-tap-prefs: the confirm hijacked a Preferences push and the screen never
 * opened).
 */
const LEAVE_ACTION_TYPES: ReadonlySet<string> = new Set(['GO_BACK', 'POP', 'POP_TO', 'POP_TO_TOP']);

/**
 * New-session discard confirm. Registers a predictive-Back-safe guard via
 * `usePreventRemove`, which fires for every way the screen can be removed —
 * header back, Android hardware back, and the iOS swipe-back gesture — so all
 * three paths get the same confirmation instead of only the header button.
 * Forward navigation (any other action type) is replayed unconfirmed: the
 * durable draft survives the leave.
 *
 * Mirrors the `usePreventRemove` + `Alert.alert` pattern of
 * `useSettingsBackGuard` without any Security-specific helpers: when the
 * prompt is non-empty (`dirty`), the exit is intercepted and the user chooses
 * Keep editing (dismiss, draft intact) or Discard. On Discard the caller's
 * `onDiscard` runs first — clear the stored draft and reset the route-owned
 * prompt ref — and only then is the captured navigation action replayed.
 *
 * `skipNextGuardRef` is the caller's bypass: set it true right before a
 * successful Start/spawn navigation (`router.replace`) so the leave is not
 * intercepted as an abandon. The callback consumes it on the next removal and
 * replays the action, because the removal was already prevented.
 *
 * A Discard whose `onDiscard` rejects keeps the screen (no dispatch) and
 * toasts, so a failed draft clear never loses the prompt.
 *
 * Android's native `AlertDialog` paints every button with the theme accent, so
 * `Alert.alert`'s `style: 'destructive'` never reaches the screen there (iOS
 * honors it and keeps the native alert). The hook therefore forks on platform:
 * the iOS leave path is unchanged, while Android holds the captured action and
 * returns a `DestructiveConfirmDialog` node the caller renders — the same
 * #6393 affordance `profile-screen.tsx` uses for sign-out. The returned
 * `discardConfirm` is null on iOS and whenever the Android confirm is closed.
 */
export function useNewSessionDiscardGuard({
  dirty,
  hasUnclaimedAttachments = false,
  onDiscard,
  skipNextGuardRef,
}: Readonly<{
  dirty: boolean;
  /** True when the composer holds admitted-but-unsent uploads; names them in the copy. */
  hasUnclaimedAttachments?: boolean;
  onDiscard: () => Promise<void>;
  skipNextGuardRef: RefObject<boolean>;
}>): NewSessionDiscardGuard {
  const navigation = useNavigation();
  // Keep the latest onDiscard in a ref so the callback below doesn't depend on
  // it directly — onDiscard is a fresh closure every render. usePreventRemove
  // already keeps the callback itself fresh via useLatestCallback, but the ref
  // keeps onDiscard stable without re-registering.
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;

  // Android holds the intercepted leave here until the in-app confirm resolves.
  const [confirmVisible, setConfirmVisible] = useState(false);
  const pendingActionRef = useRef<PreventedLeaveAction | null>(null);

  const closeConfirm = useCallback(() => {
    pendingActionRef.current = null;
    setConfirmVisible(false);
  }, []);

  const confirmDiscard = useCallback(() => {
    const action = pendingActionRef.current;
    if (action === null) {
      return;
    }
    // Close first, exactly as the native alert dismissed on press: the choice
    // is made, and a second press must not clear or leave twice.
    closeConfirm();
    void (async () => {
      try {
        await onDiscardRef.current();
        navigation.dispatch(action);
      } catch {
        // The clear failed: stay on the screen so the draft is kept and the
        // user can retry by leaving again or keep editing.
        toast.error(i18n.t('agentChat.newSession.discardFailed'));
      }
    })();
  }, [closeConfirm, navigation]);

  usePreventRemove(dirty, ({ data }) => {
    if (skipNextGuardRef.current) {
      skipNextGuardRef.current = false;
      navigation.dispatch(data.action);
      return;
    }
    const action = data.action;
    if (!LEAVE_ACTION_TYPES.has(action.type)) {
      // Forward navigation (push/navigate/reset): replay it now. The durable
      // draft keeps the prompt, so there is nothing to confirm away.
      navigation.dispatch(data.action);
      return;
    }
    if (Platform.OS === 'android') {
      pendingActionRef.current = action;
      setConfirmVisible(true);
      return;
    }
    Alert.alert(
      i18n.t('agentChat.newSession.discardDraftTitle'),
      i18n.t(
        hasUnclaimedAttachments
          ? 'agentChat.newSession.discardWithUploadsMessage'
          : 'agentChat.newSession.discardDraftMessage'
      ),
      [
        { text: i18n.t('common.keepEditing'), style: 'cancel' },
        {
          text: i18n.t('common.discard'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await onDiscardRef.current();
                navigation.dispatch(action);
              } catch {
                // The clear failed: stay on the screen so the draft is kept
                // and the user can retry or keep editing.
                toast.error(i18n.t('agentChat.newSession.discardFailed'));
              }
            })();
          },
        },
      ]
    );
  });

  return {
    discardConfirm:
      Platform.OS === 'android' && confirmVisible
        ? createElement(DestructiveConfirmDialog, {
            title: i18n.t('agentChat.newSession.discardDraftTitle'),
            message: i18n.t(
              hasUnclaimedAttachments
                ? 'agentChat.newSession.discardWithUploadsMessage'
                : 'agentChat.newSession.discardDraftMessage'
            ),
            confirmLabel: i18n.t('common.discard'),
            cancelLabel: i18n.t('common.keepEditing'),
            onConfirm: confirmDiscard,
            onCancel: closeConfirm,
          })
        : null,
  };
}
