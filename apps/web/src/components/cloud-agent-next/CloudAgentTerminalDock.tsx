'use client';

import { useEffect } from 'react';
import { StatusSpinner } from '@/components/shared/StatusSpinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCloudAgentTerminal } from './useCloudAgentTerminal';
import type { TerminalStatus } from './useCloudAgentTerminal';

export function CloudAgentTerminalPane({
  cloudAgentSessionId,
  organizationId,
  active,
  onStatusChange,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  active: boolean;
  onStatusChange?: (status: { status: TerminalStatus; statusText: string }) => void;
}) {
  const terminal = useCloudAgentTerminal({
    cloudAgentSessionId,
    organizationId,
    enabled: true,
    active,
  });

  useEffect(() => {
    onStatusChange?.({ status: terminal.status, statusText: terminal.statusText });
  }, [onStatusChange, terminal.status, terminal.statusText]);

  const waitingForTerminal = terminal.status === 'connecting' || terminal.status === 'reconnecting';
  const terminalNeedsReconnect = terminal.status === 'error' || terminal.status === 'exited';

  return (
    <section
      className="bg-background flex h-full min-h-0 flex-col overflow-hidden"
      aria-label="Workspace terminal"
    >
      <div className="relative min-h-0 flex-1 bg-[#0a0a0a] p-2">
        {(waitingForTerminal || terminalNeedsReconnect) && (
          <div
            className={cn(
              'absolute inset-0 z-10 flex justify-center px-4',
              waitingForTerminal ? 'items-start pt-6' : 'items-center'
            )}
          >
            <div
              role={waitingForTerminal ? 'status' : undefined}
              aria-live={waitingForTerminal ? 'polite' : undefined}
              className={cn(
                'border-border bg-background/95 text-muted-foreground flex max-w-md items-center rounded-md border px-3 py-3 text-center text-sm',
                waitingForTerminal ? 'gap-2' : 'flex-col gap-3'
              )}
            >
              {waitingForTerminal && <StatusSpinner className="h-3 w-3 shrink-0" />}
              <span>{terminal.statusText}</span>
              {terminalNeedsReconnect && (
                <Button size="sm" variant="secondary" className="h-8" onClick={terminal.reconnect}>
                  Reconnect
                </Button>
              )}
            </div>
          </div>
        )}
        <div ref={terminal.terminalRef} className="h-full w-full overflow-hidden" />
      </div>
    </section>
  );
}
