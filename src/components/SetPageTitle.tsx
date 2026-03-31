'use client';

import { useEffect, type ReactNode } from 'react';
import { usePageTitle } from '@/contexts/PageTitleContext';

/** Renders nothing. Sets the topbar page title, icon, and optional extras via context. */
export function SetPageTitle({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const { setTitle, setIcon, setExtras } = usePageTitle();
  useEffect(() => {
    setTitle(title);
    return () => setTitle('');
  }, [title, setTitle]);
  useEffect(() => {
    setIcon(icon ?? null);
    return () => setIcon(null);
  }, [icon, setExtras]);
  useEffect(() => {
    setExtras(children ?? null);
    return () => setExtras(null);
  }, [children, setExtras]);
  return null;
}
