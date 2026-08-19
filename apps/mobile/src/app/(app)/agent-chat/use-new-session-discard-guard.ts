import { useNavigation } from 'expo-router';
import { type RefObject, useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { toast } from 'sonner-native';

/**
 * New-session discard confirm. Registers a single `beforeRemove` listener via
 * React Navigation, which fires for every way the screen can be removed —
 * header back, Android hardware back, and the iOS swipe-back gesture — so all
 * three paths get the same confirmation instead of only the header button.
 *
 * Mirrors the `beforeRemove` + `Alert.alert` pattern of
 * `useSettingsBackGuard` without any Security-specific helpers: when the
 * prompt is non-empty (`dirty`), the exit is intercepted and the user chooses
 * Keep editing (dismiss, draft intact) or Discard. On Discard the caller's
 * `onDiscard` runs first — clear the stored draft and reset the route-owned
 * prompt ref — and only then is the captured navigation action replayed.
 *
 * `skipNextGuardRef` is the caller's bypass: set it true right before a
 * successful Start/spawn navigation (`router.replace`) so the leave is not
 * intercepted as an abandon. The listener consumes it on the next removal.
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
  // Keep the latest onDiscard in a ref so the effect below doesn't depend on
  // it directly — onDiscard is a fresh closure every render, which would
  // otherwise tear down and re-register the listener on every render.
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;

  useEffect(
    () =>
      navigation.addListener('beforeRemove', event => {
        if (skipNextGuardRef.current) {
          skipNextGuardRef.current = false;
          return;
        }
        if (!dirty) {
          return;
        }
        event.preventDefault();
        const action = event.data.action;
        Alert.alert('Discard draft?', 'Your prompt will be lost.', [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await onDiscardRef.current();
                  navigation.dispatch(action);
                } catch {
                  // The clear failed: stay on the screen so the draft is kept
                  // and the user can retry or keep editing.
                  toast.error('Could not discard the draft. Please try again.');
                }
              })();
            },
          },
        ]);
      }),
    [navigation, dirty, skipNextGuardRef]
  );
}
