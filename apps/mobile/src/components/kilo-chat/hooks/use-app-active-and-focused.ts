import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { useAppStateActive } from '@/lib/hooks/use-app-state-active';

/**
 * True only when the app is in the foreground AND the current expo-router
 * route is focused. Used to gate presence subscriptions so we hold them only
 * while the user is genuinely on a surface.
 */
export function useAppActiveAndFocused(): boolean {
  const appActive = useAppStateActive();
  const [focused, setFocused] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => {
        setFocused(false);
      };
    }, [])
  );

  return appActive && focused;
}
