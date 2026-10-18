import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { useAppStateActive } from '@/lib/hooks/use-app-state-active';

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
