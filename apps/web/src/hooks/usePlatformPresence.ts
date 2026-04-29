'use client';

import { useEffect, useState } from 'react';
import { presenceContextForPlatform } from '@kilocode/event-service';
import { usePresenceSubscription } from './usePresenceSubscription';

export function usePlatformPresence() {
  const [visible, setVisible] = useState(typeof document === 'undefined' ? true : !document.hidden);

  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  usePresenceSubscription(presenceContextForPlatform('web'), visible);
}
