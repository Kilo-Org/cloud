import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * True only when the app is in the foreground AND the current expo-router
 * route is focused. Used to gate presence subscriptions so we hold them only
 * while the user is genuinely on a surface.
 */
export function useAppActiveAndFocused(): boolean {
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      setAppActive(state === 'active');
    });
    return () => {
      sub.remove();
    };
  }, []);

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
