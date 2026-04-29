'use client';

import { useEffect, useState } from 'react';
import { presenceContextForInstance } from '@kilocode/event-service';
import { usePresenceSubscription } from './usePresenceSubscription';

export function useInstancePresence(sandboxId: string | undefined, enabled = true) {
  const [visible, setVisible] = useState(
    typeof document === 'undefined' ? true : !document.hidden
  );

  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  usePresenceSubscription(
    sandboxId ? presenceContextForInstance(sandboxId) : '',
    Boolean(sandboxId) && enabled && visible
  );
}
