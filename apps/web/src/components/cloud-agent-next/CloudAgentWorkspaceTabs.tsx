'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MessageSquare, Terminal, X } from 'lucide-react';
import { CHAT_TAB_ID, terminalTabId } from './terminal-tabs';
import type { TerminalWorkspaceTab, WorkspaceTabId } from './terminal-tabs';

type TerminalStatusSummary = {
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'exited' | 'error';
  statusText: string;
};

function statusDotClass(status: TerminalStatusSummary['status']): string {
  if (status === 'connected') return 'bg-emerald-500';
  if (status === 'error' || status === 'exited') return 'bg-destructive';
  return 'bg-amber-500';
}

export function CloudAgentWorkspaceTabs({
  activeTabId,
  terminals,
  terminalStatuses,
  canCreateTerminal,
  onSelectTab,
  onCreateTerminal,
  onCloseTerminal,
  className,
}: {
  activeTabId: WorkspaceTabId;
  terminals: TerminalWorkspaceTab[];
  terminalStatuses: Record<string, TerminalStatusSummary | undefined>;
  canCreateTerminal: boolean;
  onSelectTab: (tabId: WorkspaceTabId) => void;
  onCreateTerminal: () => void;
  onCloseTerminal: (terminalId: string) => void;
  className?: string;
}) {
  const chatActive = activeTabId === CHAT_TAB_ID;

  return (
    <div
      role="tablist"
      aria-label="Cloud Agent workspace"
      className={cn('flex min-w-0 items-center gap-1 overflow-x-auto', className)}
    >
      <Button
        type="button"
        size="sm"
        variant={chatActive ? 'secondary' : 'ghost'}
        className={cn(
          'h-8 shrink-0 gap-2',
          chatActive ? 'cursor-default hover:bg-secondary' : 'cursor-pointer'
        )}
        role="tab"
        aria-selected={chatActive}
        aria-disabled={chatActive || undefined}
        onClick={chatActive ? undefined : () => onSelectTab(CHAT_TAB_ID)}
      >
        <MessageSquare className="h-4 w-4" />
        <span>Chat</span>
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
              aria-disabled={active || undefined}
              className={cn(
                'flex h-full min-w-0 items-center gap-2 rounded-l-md px-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                active ? 'cursor-default' : 'cursor-pointer'
              )}
              onClick={active ? undefined : () => onSelectTab(tabId)}
            >
              <Terminal className="h-4 w-4 shrink-0" />
              <span className="max-w-32 truncate">{tab.title}</span>
              <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClass(status))} />
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className="hover:bg-muted flex h-full w-7 shrink-0 cursor-pointer items-center justify-center rounded-r-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-8 shrink-0 gap-2 px-2"
          onClick={onCreateTerminal}
        >
          <span aria-hidden="true" className="font-jetbrains text-xs">
            {'>_'}
          </span>
          <span>New terminal</span>
        </Button>
      )}
    </div>
  );
}
