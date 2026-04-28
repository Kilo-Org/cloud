import { useCallback, useEffect, useRef, useState } from 'react';

import { presenceContextForConversation } from '@kilocode/notifications';
import { useFocusEffect } from 'expo-router';
import { AppState, type AppStateStatus } from 'react-native';

import { useKiloChat } from '../kilo-chat-provider';

export function usePresenceSubscription(conversationId: string) {
  const { eventService } = useKiloChat();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const focusedRef = useRef(false);
  const subscribedRef = useRef(false);

  // Track AppState (foreground vs background)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      setAppActive(s === 'active');
    });
    return () => {
      sub.remove();
    };
  }, []);

  // Reconcile: subscribe only when both focused AND app is active
  const reconcile = useCallback(() => {
    const shouldSubscribe = focusedRef.current && appActive;
    const ctx = presenceContextForConversation(conversationId);
    if (shouldSubscribe && !subscribedRef.current) {
      eventService.subscribe([ctx]);
      subscribedRef.current = true;
    } else if (!shouldSubscribe && subscribedRef.current) {
      eventService.unsubscribe([ctx]);
      subscribedRef.current = false;
    }
  }, [appActive, conversationId, eventService]);

  // Re-reconcile whenever appActive changes
  useEffect(() => {
    reconcile();
  }, [reconcile]);

  // Track screen focus via expo-router
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      reconcile();
      return () => {
        focusedRef.current = false;
        reconcile();
      };
    }, [reconcile])
  );

  // Cleanup subscription when conversationId changes or component unmounts
  useEffect(
    () => () => {
      if (subscribedRef.current) {
        eventService.unsubscribe([presenceContextForConversation(conversationId)]);
        subscribedRef.current = false;
      }
    },
    [conversationId, eventService]
  );
}
