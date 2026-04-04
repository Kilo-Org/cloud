'use client';

import { useEffect } from 'react';
import { useUser } from '@/hooks/useUser';

async function sha1Hex(value: string): Promise<string> {
  const normalized = value.trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function ImpactIdentify() {
  const { data: user } = useUser();

  useEffect(() => {
    if (!user || typeof window.ire !== 'function') return;

    let cancelled = false;

    void sha1Hex(user.google_user_email).then(hashedEmail => {
      if (cancelled || typeof window.ire !== 'function') return;

      window.ire('identify', {
        customerId: user.id,
        customerEmail: hashedEmail,
        customProfileId: '',
      });
    });

    return () => {
      cancelled = true;
    };
  }, [user]);

  return null;
}
