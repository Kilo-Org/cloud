'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MessageSquare, Plus, Terminal, X } from 'lucide-react';
import { CHAT_TAB_ID, terminalTabId } from './terminal-tabs';
import type { TerminalWorkspaceTab, WorkspaceTabId } from './terminal-tabs';

type TerminalStatusSummary = {
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'exited' | 'error';
  statusText: string;
};

function statusDotClass(status: TerminalStatusSummary['status'] | 'chat-active'): string {
  if (status === 'connected') return 'bg-emerald-500';
  if (status === 'error' || status === 'exited') return 'bg-destructive';
  if (status === 'chat-active') return 'bg-primary';
  return 'bg-amber-500';
}

export function CloudAgentWorkspaceTabs({
  activeTabId,
  terminals,
  terminalStatuses,
  chatNeedsAttention,
  canCreateTerminal,
  onSelectTab,
  onCreateTerminal,
  onCloseTerminal,
  className,
}: {
  activeTabId: WorkspaceTabId;
  terminals: TerminalWorkspaceTab[];
  terminalStatuses: Record<string, TerminalStatusSummary | undefined>;
  chatNeedsAttention: boolean;
  canCreateTerminal: boolean;
  onSelectTab: (tabId: WorkspaceTabId) => void;
  onCreateTerminal: () => void;
  onCloseTerminal: (terminalId: string) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Cloud Agent workspace"
      className={cn('flex min-w-0 items-center gap-1 overflow-x-auto', className)}
    >
      <Button
        type="button"
        size="sm"
        variant={activeTabId === CHAT_TAB_ID ? 'secondary' : 'ghost'}
        className="h-8 shrink-0 gap-2"
        role="tab"
        aria-selected={activeTabId === CHAT_TAB_ID}
        onClick={() => onSelectTab(CHAT_TAB_ID)}
      >
        <MessageSquare className="h-4 w-4" />
        <span>Chat</span>
        {chatNeedsAttention && (
          <span className={cn('h-2 w-2 rounded-full', statusDotClass('chat-active'))} />
        )}
      </Button>

      {terminals.map(tab => {
        const tabId = terminalTabId(tab.id);
        const active = activeTabId === tabId;
        const status = terminalStatuses[tab.id]?.status ?? 'connecting';

        return (
          <div
            key={tab.id}
            className={cn(
              'border-border flex h-8 shrink-0 items-center rounded-md border',
              active ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground'
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="flex h-full min-w-0 items-center gap-2 rounded-l-md px-2 text-sm font-medium"
              onClick={() => onSelectTab(tabId)}
            >
              <Terminal className="h-4 w-4 shrink-0" />
              <span className="max-w-32 truncate">{tab.title}</span>
              <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClass(status))} />
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className="hover:bg-muted flex h-full w-7 shrink-0 items-center justify-center rounded-r-md"
              onClick={() => onCloseTerminal(tab.id)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {canCreateTerminal && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          aria-label="New terminal"
          onClick={onCreateTerminal}
        >
          <Plus className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
