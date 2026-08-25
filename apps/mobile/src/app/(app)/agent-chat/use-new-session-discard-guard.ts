import { useNavigation } from 'expo-router';
import { type RefObject, useRef } from 'react';
import { Alert } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { usePreventRemove } from '@/lib/navigation/prevent-remove';

/**
 * New-session discard confirm. Registers a predictive-Back-safe guard via
 * `usePreventRemove`, which fires for every way the screen can be removed —
 * header back, Android hardware back, and the iOS swipe-back gesture — so all
 * three paths get the same confirmation instead of only the header button.
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
 */
export function useNewSessionDiscardGuard({
  dirty,
  onDiscard,
  skipNextGuardRef,
}: Readonly<{
  dirty: boolean;
  onDiscard: () => Promise<void>;
  skipNextGuardRef: RefObject<boolean>;
}>): void {
  const navigation = useNavigation();
  // Keep the latest onDiscard in a ref so the callback below doesn't depend on
  // it directly — onDiscard is a fresh closure every render. usePreventRemove
  // already keeps the callback itself fresh via useLatestCallback, but the ref
  // keeps onDiscard stable without re-registering.
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;

  usePreventRemove(dirty, ({ data }) => {
    if (skipNextGuardRef.current) {
      skipNextGuardRef.current = false;
      navigation.dispatch(data.action);
      return;
    }
    const action = data.action;
    Alert.alert(
      i18n.t('agentChat.newSession.discardDraftTitle'),
      i18n.t('agentChat.newSession.discardDraftMessage'),
      [
        { text: i18n.t('agentChat.newSession.keepEditing'), style: 'cancel' },
        {
          text: i18n.t('agentChat.newSession.discard'),
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
}
