'use client';

import { useEffect } from 'react';
import { usePageTitle } from '@/contexts/PageTitleContext';

export function HideAppTopbar() {
  const { setHideTopbar } = usePageTitle();

  useEffect(() => {
    setHideTopbar(true);
    return () => setHideTopbar(false);
  }, [setHideTopbar]);

  return null;
}
