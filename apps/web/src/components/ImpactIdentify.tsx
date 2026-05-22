'use client';

import { useEffect } from 'react';
import { useUser } from '@/hooks/useUser';
import { logImpactReferralDebug } from '@/lib/impact/debug';
import { IMPACT_CUSTOM_PROFILE_ID_STORAGE_KEY } from '@/lib/impact/referral-utils';

async function sha1Hex(value: string): Promise<string> {
  const normalized = value.trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function getStableAnonymousProfileId(): string {
  const existing = window.localStorage.getItem(IMPACT_CUSTOM_PROFILE_ID_STORAGE_KEY)?.trim();
  if (existing) {
    return existing;
  }

  const generated = `kilo-anon:${crypto.randomUUID()}`;
  window.localStorage.setItem(IMPACT_CUSTOM_PROFILE_ID_STORAGE_KEY, generated);
  return generated;
}

export function ImpactIdentify() {
  const { data: user } = useUser();

  useEffect(() => {
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    const runIdentify = async (retriesRemaining: number): Promise<void> => {
      if (cancelled) return;

      if (typeof window.ire !== 'function') {
        if (retriesRemaining <= 0) {
          logImpactReferralDebug('Impact UTT identify skipped; window.ire unavailable', {
            userId: user?.id ?? null,
          });
          return;
        }

        retryTimeout = setTimeout(() => {
          void runIdentify(retriesRemaining - 1);
        }, 250);
        return;
      }

      const customProfileId = user?.id ? `kilo-user:${user.id}` : getStableAnonymousProfileId();
      const customerId = user?.id ?? '';
      const customerEmail = user ? await sha1Hex(user.google_user_email) : '';

      if (cancelled || typeof window.ire !== 'function') return;

      logImpactReferralDebug('Calling Impact UTT identify', {
        userId: user?.id ?? null,
        customerIdPresent: Boolean(customerId),
        customerEmailHashPresent: Boolean(customerEmail),
        customProfileIdPresent: Boolean(customProfileId),
      });

      window.ire('identify', {
        customerId,
        customerEmail,
        customProfileId,
      });
    };

    void runIdentify(10).catch(error => {
      console.error('ImpactIdentify failed', error);
    });

    return () => {
      cancelled = true;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, [user?.google_user_email, user?.id]);

  return null;
}
