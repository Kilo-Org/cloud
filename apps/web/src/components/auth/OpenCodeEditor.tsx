'use client';

import { useEffect, useRef } from 'react';

export function OpenCodeEditor({ url }: { url: string }) {
  // This ref is used to ensure that we only redirect once in React StrictMode (which renders components twice)
  const hasRedirected = useRef(false);

  useEffect(() => {
    if (!hasRedirected.current) {
      hasRedirected.current = true;
      window.location.href = url; // router.push is for SPA navigation, but this is always an external url
      // see also https://github.com/Kilo-Org/kilocode-backend/issues/1587 for a router issue
    }
  }, [url]);

  return null;
}
