import { useNavigation, useRouter } from 'expo-router';
import { useCallback } from 'react';

/**
 * A `router.back()` that runs only while the calling route is still the
 * focused one.
 *
 * A save that the screen awaits can resolve after the user already left
 * (header Back, Android Back, or the iOS swipe). Popping then removes the
 * screen beneath instead, so a single Back closes two screens. Focus is read
 * imperatively at call time: the value captured when the save started is
 * still the pre-leave one, while a route the navigator already removed
 * reports itself unfocused.
 */
export function usePopWhenFocused(): () => void {
  const navigation = useNavigation();
  const router = useRouter();

  return useCallback(() => {
    if (navigation.isFocused()) {
      router.back();
    }
  }, [navigation, router]);
}
