'use client';

import { hashDataLayerUserData } from '@/lib/data-layer-hashing';
import type {} from '@/types/datalayer';
import { useSession } from 'next-auth/react';
import { useEffect } from 'react';

export function DataLayerProvider() {
  return (
    <>
      <AddUserData />
    </>
  );
}

function AddUserData() {
  const { data: session, status } = useSession();

  useEffect(() => {
    // Ensure dataLayer object exists
    window.dataLayer = window.dataLayer || [];

    if (status !== 'authenticated' || !session?.user?.email) return;

    let cancelled = false;
    const baseEvent = {
      event: 'data_layer_update',
      is_new_user: session.isNewUser || false,
    };
    const pushDataLayerEvent = (event: Record<string, unknown>) => {
      if (cancelled) return;
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(event);
    };

    // Push hashed user data to dataLayer for authenticated users. These hashes are
    // intentionally unsalted so ad platforms can match them for client-side conversions.
    // Legacy `email`/`name` keys are still populated, but contain hashes rather than raw values.
    void hashDataLayerUserData({ email: session.user.email, name: session.user.name }).then(
      hashedUserData =>
        pushDataLayerEvent(hashedUserData ? { ...baseEvent, ...hashedUserData } : baseEvent),
      () => pushDataLayerEvent(baseEvent)
    );

    return () => {
      cancelled = true;
    };
  }, [session?.isNewUser, session?.user?.email, session?.user?.name, status]);

  return null; // This component doesn't render anything
}
