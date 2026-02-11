'use client';

import { useEffect } from 'react';

/**
 * Invisible client component that calls the cookie refresh endpoint on mount.
 * Rendered by the layout only when the cookie is missing or expiring.
 * Fires once per page load -- no polling.
 */
export function CookieRefresher() {
  useEffect(() => {
    fetch('/api/kiloclaw/refresh-cookie', { method: 'POST' }).catch(() => {
      // best-effort -- if it fails the user can still navigate,
      // and the next page load will try again
    });
  }, []);

  return null;
}
