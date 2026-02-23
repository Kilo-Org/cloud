'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useSidebar } from '@/components/ui/sidebar';
import { ChevronDown, ChevronUp, Terminal as TerminalIcon } from 'lucide-react';

type MayorChatProps = {
  townId: string;
};

const COLLAPSED_HEIGHT = 40; // px — title bar only
const EXPANDED_HEIGHT = 320; // px — terminal area

export function MayorChat({ townId }: MayorChatProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Initializing...');

  const terminalRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const ptyRef = useRef<{ id: string } | null>(null);

  // Eagerly ensure mayor agent + container on mount
  const ensureMayor = useMutation(
    trpc.gastown.ensureMayor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getMayorStatus.queryKey(),
        });
      },
    })
  );

  // Reset on townId change so ensureMayor fires for each town
  const ensuredTownRef = useRef<string | null>(null);
  useEffect(() => {
    if (ensuredTownRef.current === townId) return;
    ensuredTownRef.current = townId;
    ensureMayor.mutate({ townId });
  }, [townId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll mayor status to get agentId
  const statusQuery = useQuery({
    ...trpc.gastown.getMayorStatus.queryOptions({ townId }),
    refetchInterval: query => {
      const session = query.state.data?.session;
      if (!session) return 3_000; // Poll faster until mayor is available
      if (session.status === 'active' || session.status === 'starting') return 3_000;
      return 10_000;
    },
  });

  const mayorAgentId = statusQuery.data?.session?.agentId ?? null;

  const createPty = useMutation(
    trpc.gastown.createPtySession.mutationOptions({
      onError: err => setStatus(`Error: ${err.message}`),
    })
  );

  const resizePty = useMutation(trpc.gastown.resizePtySession.mutationOptions({}));
  const resizeMutateRef = useRef(resizePty.mutate);
  resizeMutateRef.current = resizePty.mutate;

  // Connect terminal when mayorAgentId becomes available
  const connectedAgentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!mayorAgentId || mayorAgentId === connectedAgentRef.current) return;
    const agentId = mayorAgentId; // capture for closure
    connectedAgentRef.current = agentId;

    let disposed = false;

    async function init() {
      const container = terminalRef.current;
      if (!container) return;

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

      setStatus('Connecting to mayor...');

      function doResize(cols: number, rows: number) {
        if (!ptyRef.current) return;
        resizeMutateRef.current({
          townId,
          agentId,
          ptyId: ptyRef.current.id,
          cols,
          rows,
        });
      }

      // Retry PTY creation — the agent may still be starting up (especially
      // on first town creation when ensureMayor is waiting for a kilocode token).
      let result: { pty: { id: string }; wsUrl: string } | null = null;
      for (let attempt = 0; attempt < 10 && !disposed; attempt++) {
        try {
          result = await new Promise<{ pty: { id: string }; wsUrl: string }>((resolve, reject) => {
            createPty.mutate({ townId, agentId }, { onSuccess: resolve, onError: reject });
          });
          break;
        } catch {
          if (disposed) return;
          setStatus(`Waiting for mayor... (${attempt + 1})`);
          await new Promise(r => setTimeout(r, 3_000));
        }
      }

      if (disposed || !result) {
        if (!disposed && !result) {
          setStatus('Failed to connect to mayor');
        }
        return;
      }

      ptyRef.current = result.pty;
      setStatus('Connecting...');

      const ws = new WebSocket(result.wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setConnected(true);
        setStatus('Connected');
        const dims = fitAddon.proposeDimensions();
        if (dims) doResize(dims.cols, dims.rows);
      };

      ws.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(e.data));
        } else if (typeof e.data === 'string') {
          if (e.data.startsWith('{')) {
            try {
              JSON.parse(e.data);
              return;
            } catch {
              // Not JSON control message
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
      wsRef.current?.close(1000, 'Mayor terminal unmount');
      wsRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      ptyRef.current = null;
      connectedAgentRef.current = null;
    };
  }, [mayorAgentId, townId]); // eslint-disable-line react-hooks/exhaustive-deps

  const { state: sidebarState, isMobile } = useSidebar();

  // Re-fit terminal when expanding or sidebar changes
  useEffect(() => {
    if (collapsed || !fitAddonRef.current) return;
    // Small delay so the DOM has finished resizing
    const t = setTimeout(() => fitAddonRef.current?.fit(), 50);
    return () => clearTimeout(t);
  }, [collapsed, sidebarState]);

  // Sidebar is hidden on mobile, 3rem when collapsed to icons, 16rem when expanded.
  // Add extra padding to account for the sidebar's outer spacing.
  const sidebarLeft = isMobile ? '0px' : sidebarState === 'expanded' ? '16rem' : '3rem';

  return (
    <div
      className="fixed right-0 bottom-0 z-50 border-t border-white/10 bg-[#0a0a0a] transition-[left] duration-200 ease-linear"
      style={{
        left: sidebarLeft,
        height: collapsed ? COLLAPSED_HEIGHT : COLLAPSED_HEIGHT + EXPANDED_HEIGHT,
      }}
    >
      {/* Title bar */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex w-full items-center justify-between px-4"
        style={{ height: COLLAPSED_HEIGHT }}
      >
        <div className="flex items-center gap-2">
          <TerminalIcon
            className={`size-3.5 ${connected ? 'text-emerald-400' : 'text-white/30'}`}
          />
          <span className="text-xs font-medium text-white/70">Mayor</span>
          <span className="text-[11px] text-white/40">{status}</span>
        </div>
        {collapsed ? (
          <ChevronUp className="size-4 text-white/40" />
        ) : (
          <ChevronDown className="size-4 text-white/40" />
        )}
      </button>

      {/* Terminal area */}
      <div
        ref={terminalRef}
        className="overflow-hidden px-1"
        style={{
          height: EXPANDED_HEIGHT,
          display: collapsed ? 'none' : 'block',
        }}
      />
    </div>
  );
}
