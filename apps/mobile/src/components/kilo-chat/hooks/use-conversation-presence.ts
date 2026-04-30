import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { presenceContextForConversation } from '@kilocode/event-service';

import { usePresenceSubscription } from './use-presence-subscription';

export function useConversationPresence(
  sandboxId: string | undefined,
  conversationId: string | undefined
) {
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
    sandboxId && conversationId
      ? presenceContextForConversation(sandboxId, conversationId)
      : null,
    Boolean(sandboxId && conversationId) && appActive && focused
  );
}
