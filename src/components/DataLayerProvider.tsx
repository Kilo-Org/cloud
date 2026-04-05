'use client';

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

    // Push user data to dataLayer for authenticated users
    if (status === 'authenticated' && session?.user?.email) {
      const evt = {
        event: 'data_layer_update',
        email: session.user.email,
        name: session.user.name,
        is_new_user: session.isNewUser || false,
      };
      window.dataLayer.push(evt);
    }
  }, [session, status]); // Rerun effect if session or status changes

  return null; // This component doesn't render anything
}
