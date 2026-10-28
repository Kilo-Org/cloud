'use client';

import { useEffect, type ReactNode } from 'react';
import { usePageTitle } from '@/contexts/PageTitleContext';

/** Renders nothing. Puts controls at the right end of the topbar while mounted. */
export function SetPageActions({ children }: { children: ReactNode }) {
  const { setActions } = usePageTitle();
  useEffect(() => {
    setActions(children);
    return () => setActions(null);
  }, [children, setActions]);
  return null;
}
