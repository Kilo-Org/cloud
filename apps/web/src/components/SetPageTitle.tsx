'use client';

import { useEffect, type ReactNode } from 'react';
import { usePageTitle } from '@/contexts/PageTitleContext';

export function SetPageTitle({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const { setTitle, setSubtitle, setIcon, setExtras } = usePageTitle();
  useEffect(() => {
    setTitle(title);
    return () => setTitle('');
  }, [title, setTitle]);
  useEffect(() => {
    setSubtitle(subtitle ?? null);
    return () => setSubtitle(null);
  }, [subtitle, setSubtitle]);
  useEffect(() => {
    setIcon(icon ?? null);
    return () => setIcon(null);
  }, [icon, setIcon]);
  useEffect(() => {
    setExtras(children ?? null);
    return () => setExtras(null);
  }, [children, setExtras]);
  return null;
}
