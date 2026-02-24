'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

type TerminalTab = {
  id: string;
  label: string;
  kind: 'mayor' | 'agent';
  agentId: string;
};

type TerminalBarContextValue = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  collapsed: boolean;
  openAgentTab: (agentId: string, agentName: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (id: string) => void;
  setCollapsed: (collapsed: boolean) => void;
};

const TerminalBarContext = createContext<TerminalBarContextValue | null>(null);

export function useTerminalBar() {
  const ctx = useContext(TerminalBarContext);
  if (!ctx) throw new Error('useTerminalBar must be used within TerminalBarProvider');
  return ctx;
}

export function TerminalBarProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const openAgentTab = useCallback((agentId: string, agentName: string) => {
    const tabId = `agent:${agentId}`;
    setTabs(prev => {
      if (prev.some(t => t.id === tabId)) return prev;
      return [...prev, { id: tabId, label: agentName, kind: 'agent', agentId }];
    });
    setActiveTabId(tabId);
    setCollapsed(false);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      return next;
    });
    setActiveTabId(prev => {
      if (prev !== tabId) return prev;
      // Fall back to mayor tab
      return 'mayor';
    });
  }, []);

  return (
    <TerminalBarContext.Provider
      value={{ tabs, activeTabId, collapsed, openAgentTab, closeTab, setActiveTabId, setCollapsed }}
    >
      {children}
    </TerminalBarContext.Provider>
  );
}
