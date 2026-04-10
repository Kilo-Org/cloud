'use client';

import { useEffect } from 'react';
import { usePageTitle } from '@/contexts/PageTitleContext';

/**
 * Hides the app-level top bar (AppTopbar) while this component is mounted.
 * Used by gastown town pages which render their own page-level header
 * with a sidebar toggle built in.
 */
export function HideAppTopbar() {
  const { setHideTopbar } = usePageTitle();

  useEffect(() => {
    setHideTopbar(true);
    return () => setHideTopbar(false);
  }, [setHideTopbar]);

  return null;
}
