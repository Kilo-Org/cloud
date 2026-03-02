'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

type XtermPtyOptions = {
  townId: string;
  agentId: string | null;
  /** Number of retry attempts for PTY creation (default: 1, no retries). */
  retries?: number;
  /** Delay in ms between retries (default: 3000). */
  retryDelay?: number;
  /** Called when status changes (e.g. "Connecting...", "Connected"). */
  onStatusChange?: (status: string) => void;
};

type XtermPtyResult = {
  terminalRef: React.RefObject<HTMLDivElement | null>;
  connected: boolean;
  status: string;
  fitAddonRef: React.RefObject<FitAddon | null>;
};

/**
 * Shared hook that sets up an xterm.js terminal connected to a PTY session
 * via WebSocket. Used by both MayorChat and AgentTerminal.
 */
export function useXtermPty({
  townId,
  agentId,
  retries = 1,
  retryDelay = 3_000,
  onStatusChange,
}: XtermPtyOptions): XtermPtyResult {
  const trpc = useTRPC();
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Initializing...');

  const terminalRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const ptyRef = useRef<{ id: string } | null>(null);

  function updateStatus(s: string) {
    setStatus(s);
    onStatusChange?.(s);
  }

  const createPty = useMutation(
    trpc.gastown.createPtySession.mutationOptions({
      onError: err => updateStatus(`Error: ${err.message}`),
    })
  );

  const resizePty = useMutation(trpc.gastown.resizePtySession.mutationOptions({}));
  const resizeMutateRef = useRef(resizePty.mutate);
  resizeMutateRef.current = resizePty.mutate;

  const connectedAgentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!agentId || agentId === connectedAgentRef.current) return;
    const capturedAgentId = agentId;
    connectedAgentRef.current = capturedAgentId;

    let disposed = false;

    async function init() {
      const container = terminalRef.current;
      if (!container) return;

      // Lazy-load xterm.js to avoid SSR issues and minimize bundle impact
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);

      if (disposed) return;

      // Clean up any previous terminal
      xtermRef.current?.dispose();

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
      term.open(container);
      fitAddon.fit();

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      updateStatus('Creating PTY session...');

      function doResize(cols: number, rows: number) {
        if (!ptyRef.current) return;
        resizeMutateRef.current({
          townId,
          agentId: capturedAgentId,
          ptyId: ptyRef.current.id,
          cols,
          rows,
        });
      }

      // Retry PTY creation — the agent may still be starting up
      let result: { pty: { id: string }; wsUrl: string } | null = null;
      for (let attempt = 0; attempt < retries && !disposed; attempt++) {
        try {
          result = await new Promise<{ pty: { id: string }; wsUrl: string }>((resolve, reject) => {
            createPty.mutate(
              { townId, agentId: capturedAgentId },
              { onSuccess: resolve, onError: reject }
            );
          });
          break;
        } catch {
          if (disposed) return;
          if (attempt < retries - 1) {
            updateStatus(`Waiting for agent... (${attempt + 1})`);
            await new Promise(r => setTimeout(r, retryDelay));
          }
        }
      }

      if (disposed || !result) {
        if (!disposed && !result) {
          updateStatus('Failed to connect');
        }
        return;
      }

      ptyRef.current = result.pty;
      updateStatus('Connecting...');

      const ws = new WebSocket(result.wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setConnected(true);
        updateStatus('Connected');
        const dims = fitAddon.proposeDimensions();
        if (dims) doResize(dims.cols, dims.rows);
      };

      ws.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(e.data));
        } else if (typeof e.data === 'string') {
          // Filter out JSON control messages (e.g. {"cursor":N}) from the SDK
          if (e.data.startsWith('{')) {
            try {
              JSON.parse(e.data);
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
        updateStatus('Disconnected');
      };

      ws.onerror = () => {
        if (disposed) return;
        updateStatus('Connection error');
      };

      term.onData(data => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });

      term.onResize(({ cols, rows }) => doResize(cols, rows));

      const observer = new ResizeObserver(() => fitAddon.fit());
      observer.observe(container);
      resizeObserverRef.current = observer;
    }

    void init();

    return () => {
      disposed = true;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      wsRef.current?.close(1000, 'Terminal unmount');
      wsRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      ptyRef.current = null;
      connectedAgentRef.current = null;
    };
  }, [agentId, townId]);

  return { terminalRef, connected, status, fitAddonRef };
}
