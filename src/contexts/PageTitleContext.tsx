'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

type PageTitleContextValue = {
  title: string;
  icon: ReactNode;
  extras: ReactNode;
  hidden: boolean;
  setTitle: (title: string) => void;
  setIcon: (icon: ReactNode) => void;
  setExtras: (extras: ReactNode) => void;
  setHidden: (hidden: boolean) => void;
};

const PageTitleContext = createContext<PageTitleContextValue | undefined>(undefined);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitleState] = useState('');
  const [icon, setIconState] = useState<ReactNode>(null);
  const [extras, setExtrasState] = useState<ReactNode>(null);
  const [hidden, setHiddenState] = useState(false);
  const setTitle = useCallback((next: string) => setTitleState(next), []);
  const setIcon = useCallback((next: ReactNode) => setIconState(next), []);
  const setExtras = useCallback((next: ReactNode) => setExtrasState(next), []);
  const setHidden = useCallback((next: boolean) => setHiddenState(next), []);
  return (
    <PageTitleContext.Provider
      value={{ title, icon, extras, hidden, setTitle, setIcon, setExtras, setHidden }}
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
