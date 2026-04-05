'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/Button';
import { X, Terminal as TerminalIcon } from 'lucide-react';
import { useXtermPty } from './useXtermPty';

type AgentTerminalProps = {
  townId: string;
  agentId: string;
  onClose: () => void;
};

/**
 * xterm.js terminal connected to an agent's PTY session via WebSocket.
 * Lazy-loads xterm.js to avoid SSR issues and minimize bundle impact.
 */
export function AgentTerminal({ townId, agentId, onClose }: AgentTerminalProps) {
  const { terminalRef, connected, status } = useXtermPty({
    townId,
    agentId,
  });

  return (
    <Card className="border-white/10 bg-white/[0.02]">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">Agent Terminal</CardTitle>
          <div className="flex items-center gap-1">
            <TerminalIcon
              className={`size-3 ${connected ? 'text-emerald-300' : 'text-white/35'}`}
            />
            <span className="text-xs text-white/45">{status}</span>
          </div>
        </div>
        <Button variant="secondary" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <div
          ref={terminalRef}
          className="h-96 overflow-hidden rounded-xl border border-white/10 bg-[#0a0a0a]"
        />
      </CardContent>
    </Card>
  );
}
