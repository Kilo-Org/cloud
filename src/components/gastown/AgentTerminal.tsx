'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/Button';
import { X, Terminal as TerminalIcon } from 'lucide-react';

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
  const trpc = useTRPC();
  const terminalRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const [status, setStatus] = useState<string>('Initializing...');
  const [connected, setConnected] = useState(false);
  // Track the pty session for resize calls
  const ptyRef = useRef<{ id: string } | null>(null);

  const createPty = useMutation(
    trpc.gastown.createPtySession.mutationOptions({
      onError: err => setStatus(`Error: ${err.message}`),
    })
  );

  const resizePty = useMutation(trpc.gastown.resizePtySession.mutationOptions({}));

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (!ptyRef.current) return;
      resizePty.mutate({
        townId,
        agentId,
        ptyId: ptyRef.current.id,
        cols,
        rows,
      });
    },
    [townId, agentId, resizePty]
  );

  useEffect(() => {
    let disposed = false;

    async function init() {
      if (!terminalRef.current) return;

      // Lazy-load xterm.js (avoids SSR issues)
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);

      if (disposed) return;

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        theme: {
          background: '#0a0a0a',
          foreground: '#e0e0e0',
          cursor: '#e0e0e0',
          selectionBackground: '#3a3a5a',
        },
        allowProposedApi: true,
      });

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(terminalRef.current);
      fitAddon.fit();

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      setStatus('Creating PTY session...');

      // Create a PTY session on the container
      const result = await new Promise<{ pty: { id: string }; wsUrl: string }>(
        (resolve, reject) => {
          createPty.mutate(
            { townId, agentId },
            {
              onSuccess: resolve,
              onError: reject,
            }
          );
        }
      );

      if (disposed) return;

      ptyRef.current = result.pty;
      setStatus('Connecting...');

      // Connect WebSocket to the PTY
      const ws = new WebSocket(result.wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setConnected(true);
        setStatus('Connected');

        // Send initial terminal size
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          handleResize(dims.cols, dims.rows);
        }
      };

      ws.onmessage = (e: MessageEvent) => {
        // The SDK server may send JSON control messages (e.g. {"cursor":N})
        // on connect. Filter these out — only write actual PTY byte data.
        if (e.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(e.data));
        } else if (typeof e.data === 'string') {
          if (e.data.startsWith('{')) {
            try {
              JSON.parse(e.data);
              // Valid JSON control message — skip it
              return;
            } catch {
              // Not valid JSON — fall through to write as PTY data
            }
          }
          term.write(e.data);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        setStatus('Disconnected');
      };

      ws.onerror = () => {
        if (disposed) return;
        setStatus('Connection error');
      };

      // Forward terminal input to PTY via WebSocket
      term.onData(data => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Handle terminal resize
      term.onResize(({ cols, rows }) => {
        handleResize(cols, rows);
      });

      // Watch for container resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
      });
      if (terminalRef.current) {
        resizeObserver.observe(terminalRef.current);
      }
    }

    void init();

    return () => {
      disposed = true;
      wsRef.current?.close(1000, 'Component unmount');
      wsRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      ptyRef.current = null;
    };
  }, [townId, agentId]); // eslint-disable-line react-hooks/exhaustive-deps

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
