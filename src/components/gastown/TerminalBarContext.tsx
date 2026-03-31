'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

export type TerminalPosition = 'bottom' | 'top' | 'right' | 'left';

type TerminalTab = {
  id: string;
  label: string;
  kind: 'mayor' | 'agent' | 'status';
  agentId: string;
};

const COLLAPSED_SIZE = 38;
const DEFAULT_EXPANDED_SIZE = 300;
const MIN_SIZE_HORIZONTAL = 100;
const MAX_SIZE_HORIZONTAL_RATIO = 0.7;
const MIN_SIZE_VERTICAL = 200;
const MAX_SIZE_VERTICAL_RATIO = 0.5;

const LS_KEY_POSITION = 'gastown-terminal-position';
const LS_KEY_SIZE = 'gastown-terminal-size';

export { COLLAPSED_SIZE, DEFAULT_EXPANDED_SIZE };

function isHorizontal(p: TerminalPosition) {
  return p === 'bottom' || p === 'top';
}

export { isHorizontal };

function readStoredPosition(): TerminalPosition {
  if (typeof window === 'undefined') return 'bottom';
  const stored = localStorage.getItem(LS_KEY_POSITION);
  if (stored === 'bottom' || stored === 'top' || stored === 'right' || stored === 'left') {
    return stored;
  }
  return 'bottom';
}

function readStoredSize(): number {
  if (typeof window === 'undefined') return DEFAULT_EXPANDED_SIZE;
  const stored = localStorage.getItem(LS_KEY_SIZE);
  if (stored) {
    const n = parseInt(stored, 10);
    if (!isNaN(n) && n >= MIN_SIZE_HORIZONTAL) return n;
  }
  return DEFAULT_EXPANDED_SIZE;
}

export function clampSize(size: number, position: TerminalPosition): number {
  if (isHorizontal(position)) {
    const max =
      typeof window !== 'undefined' ? window.innerHeight * MAX_SIZE_HORIZONTAL_RATIO : 600;
    return Math.max(MIN_SIZE_HORIZONTAL, Math.min(size, max));
  }
  const max = typeof window !== 'undefined' ? window.innerWidth * MAX_SIZE_VERTICAL_RATIO : 800;
  return Math.max(MIN_SIZE_VERTICAL, Math.min(size, max));
}

type TerminalBarContextValue = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  collapsed: boolean;
  position: TerminalPosition;
  size: number;
  openAgentTab: (agentId: string, agentName: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (id: string) => void;
  setCollapsed: (collapsed: boolean) => void;
  setPosition: (position: TerminalPosition) => void;
  setSize: (size: number) => void;
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
  const [position, setPositionState] = useState<TerminalPosition>('bottom');
  const [size, setSizeState] = useState(DEFAULT_EXPANDED_SIZE);

  // Hydrate from localStorage on mount
  useEffect(() => {
    setPositionState(readStoredPosition());
    setSizeState(readStoredSize());
  }, []);

  const setPosition = useCallback((p: TerminalPosition) => {
    setPositionState(p);
    localStorage.setItem(LS_KEY_POSITION, p);
    // Re-clamp size for the new orientation's constraints
    setSizeState(prev => {
      const clamped = clampSize(prev, p);
      localStorage.setItem(LS_KEY_SIZE, String(clamped));
      return clamped;
    });
  }, []);

  const setSize = useCallback(
    (s: number, pos?: TerminalPosition) => {
      const val = clampSize(s, pos ?? position);
      setSizeState(val);
      localStorage.setItem(LS_KEY_SIZE, String(val));
    },
    [position]
  );

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
      value={{
        tabs,
        activeTabId,
        collapsed,
        position,
        size,
        openAgentTab,
        closeTab,
        setActiveTabId,
        setCollapsed,
        setPosition,
        setSize,
      }}
    >
      {children}
    </TerminalBarContext.Provider>
  );
}
