'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

type PageTitleContextValue = {
  title: string;
  icon: ReactNode;
  extras: ReactNode;
  /** Right-aligned topbar controls. Independent of the title, so a page can set one without the other. */
  actions: ReactNode;
  hideTopbar: boolean;
  setTitle: (title: string) => void;
  setIcon: (icon: ReactNode) => void;
  setExtras: (extras: ReactNode) => void;
  setActions: (actions: ReactNode) => void;
  setHideTopbar: (hide: boolean) => void;
};

const PageTitleContext = createContext<PageTitleContextValue | undefined>(undefined);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitleState] = useState('');
  const [icon, setIconState] = useState<ReactNode>(null);
  const [extras, setExtrasState] = useState<ReactNode>(null);
  const [actions, setActionsState] = useState<ReactNode>(null);
  const [hideTopbar, setHideTopbarState] = useState(false);
  const setTitle = useCallback((next: string) => setTitleState(next), []);
  const setIcon = useCallback((next: ReactNode) => setIconState(next), []);
  const setExtras = useCallback((next: ReactNode) => setExtrasState(next), []);
  const setActions = useCallback((next: ReactNode) => setActionsState(next), []);
  const setHideTopbar = useCallback((next: boolean) => setHideTopbarState(next), []);
  return (
    <PageTitleContext.Provider
      value={{
        title,
        icon,
        extras,
        actions,
        hideTopbar,
        setTitle,
        setIcon,
        setExtras,
        setActions,
        setHideTopbar,
      }}
    >
      {children}
    </PageTitleContext.Provider>
  );
}

export function usePageTitle() {
  const ctx = useContext(PageTitleContext);
  if (!ctx) {
    throw new Error('usePageTitle must be used within a PageTitleProvider');
  }
  return ctx;
}
