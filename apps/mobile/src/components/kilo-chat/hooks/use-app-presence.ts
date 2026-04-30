import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { presenceContextForPlatform } from '@kilocode/event-service';

import { usePresenceSubscription } from './use-presence-subscription';

export function useAppPresence() {
  const [active, setActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      setActive(state === 'active');
    });
    return () => sub.remove();
  }, []);

  usePresenceSubscription(presenceContextForPlatform('app'), active);
}
