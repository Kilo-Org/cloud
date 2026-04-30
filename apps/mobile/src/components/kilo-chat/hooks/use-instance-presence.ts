import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { presenceContextForInstance } from '@kilocode/event-service';

import { usePresenceSubscription } from './use-presence-subscription';

export function useInstancePresence(sandboxId: string | undefined) {
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      setAppActive(state === 'active');
    });
    return () => sub.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, [])
  );

  usePresenceSubscription(
    sandboxId ? presenceContextForInstance(sandboxId) : null,
    Boolean(sandboxId) && appActive && focused
  );
}
