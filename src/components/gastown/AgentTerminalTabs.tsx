'use client';

import { useState } from 'react';
import { AgentTerminal } from './AgentTerminal';
import { useSidebar } from '@/components/ui/sidebar';
import { ChevronDown, ChevronUp, X, Terminal as TerminalIcon } from 'lucide-react';

type TerminalTab = {
  agentId: string;
  agentName: string;
};

type AgentTerminalTabsProps = {
  townId: string;
  tabs: TerminalTab[];
  onCloseTab: (agentId: string) => void;
  onCloseAll: () => void;
};

const COLLAPSED_HEIGHT = 36;
const EXPANDED_HEIGHT = 300;

export function AgentTerminalTabs({
  townId,
  tabs,
  onCloseTab,
  onCloseAll,
}: AgentTerminalTabsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string | null>(tabs[0]?.agentId ?? null);
  const { state: sidebarState, isMobile } = useSidebar();

  // If the active tab gets closed, select the last remaining tab
  const activeTab = tabs.find(t => t.agentId === activeTabId);
  if (!activeTab && tabs.length > 0 && activeTabId !== tabs[tabs.length - 1].agentId) {
    setActiveTabId(tabs[tabs.length - 1].agentId);
  }

  if (tabs.length === 0) return null;

  const sidebarLeft = isMobile ? '0px' : sidebarState === 'expanded' ? '16rem' : '3rem';

  return (
    <div
      className="fixed right-0 bottom-0 z-40 border-t border-white/[0.08] bg-[oklch(0.08_0_0)]"
      style={{
        left: sidebarLeft,
        height: collapsed ? COLLAPSED_HEIGHT : COLLAPSED_HEIGHT + EXPANDED_HEIGHT,
        transition: 'left 200ms linear, height 150ms ease',
      }}
    >
      {/* Tab bar */}
      <div
        className="flex items-center border-b border-white/[0.06]"
        style={{ height: COLLAPSED_HEIGHT }}
      >
        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="flex h-full items-center gap-1.5 px-3 text-white/40 transition-colors hover:text-white/60"
        >
          <TerminalIcon className="size-3" />
          {collapsed ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>

        {/* Tabs */}
        <div className="flex flex-1 items-center gap-0.5 overflow-x-auto px-1">
          {tabs.map(tab => (
            <div
              key={tab.agentId}
              onClick={() => {
                setActiveTabId(tab.agentId);
                if (collapsed) setCollapsed(false);
              }}
              className={`group flex cursor-pointer items-center gap-1.5 rounded-t-md px-3 py-1 text-[11px] transition-colors ${
                tab.agentId === activeTabId
                  ? 'bg-white/[0.06] text-white/80'
                  : 'text-white/35 hover:bg-white/[0.03] hover:text-white/55'
              }`}
            >
              <span className="max-w-[100px] truncate">{tab.agentName}</span>
              <button
                onClick={e => {
                  e.stopPropagation();
                  onCloseTab(tab.agentId);
                }}
                className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>

        {/* Close all */}
        <button
          onClick={onCloseAll}
          className="flex h-full items-center px-3 text-[10px] text-white/25 transition-colors hover:text-white/50"
        >
          Close all
        </button>
      </div>

      {/* Terminal content */}
      {!collapsed && activeTab && (
        <div style={{ height: EXPANDED_HEIGHT }} className="overflow-hidden">
          <AgentTerminalInline
            key={activeTab.agentId}
            townId={townId}
            agentId={activeTab.agentId}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Inline terminal variant that fills its container (no Card wrapper).
 * Re-uses the AgentTerminal logic but just renders the terminal div.
 */
function AgentTerminalInline({ townId, agentId }: { townId: string; agentId: string }) {
  return (
    <div className="h-full">
      <AgentTerminal
        townId={townId}
        agentId={agentId}
        onClose={() => {
          // no-op: closing is handled by the tab bar
        }}
      />
    </div>
  );
}
