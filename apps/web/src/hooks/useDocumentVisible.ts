'use client';

import { useEffect, useState } from 'react';

/**
 * Returns whether the current document is visible (not hidden).
 * SSR-safe: returns `true` when `document` is undefined.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(typeof document === 'undefined' ? true : !document.hidden);

  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}
