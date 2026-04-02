'use client';

import { useEffect, type ReactNode } from 'react';
import { usePageTitle } from '@/contexts/PageTitleContext';

/** Renders nothing. Sets the topbar page title, icon, extras, and actions via context. */
export function SetPageTitle({
  title,
  icon,
  children,
  actions,
}: {
  title: string;
  icon?: ReactNode;
  /** Rendered adjacent to the title in the topbar (e.g. badges). */
  children?: ReactNode;
  /** Rendered at the far right of the topbar (e.g. action buttons). */
  actions?: ReactNode;
}) {
  const { setTitle, setIcon, setExtras, setActions } = usePageTitle();
  useEffect(() => {
    setTitle(title);
    return () => setTitle('');
  }, [title, setTitle]);
  useEffect(() => {
    setIcon(icon ?? null);
    return () => setIcon(null);
  }, [icon, setIcon]);
  useEffect(() => {
    setExtras(children ?? null);
    return () => setExtras(null);
  }, [children, setExtras]);
  useEffect(() => {
    setActions(actions ?? null);
    return () => setActions(null);
  }, [actions, setActions]);
  return null;
}
