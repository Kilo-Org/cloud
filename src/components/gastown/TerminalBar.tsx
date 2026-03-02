'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useSidebar } from '@/components/ui/sidebar';
import { useTerminalBar } from './TerminalBarContext';
import { ChevronDown, ChevronUp, Crown, Terminal as TerminalIcon, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

const COLLAPSED_HEIGHT = 38;
const EXPANDED_HEIGHT = 300;

type TerminalBarProps = {
  townId: string;
};

/**
 * Unified bottom terminal bar. Always shows a Mayor tab (non-closeable).
 * Agent terminal tabs are opened/closed via TerminalBarContext.
 */
export function TerminalBar({ townId }: TerminalBarProps) {
  const { state: sidebarState, isMobile } = useSidebar();
  const {
    tabs: agentTabs,
    activeTabId,
    collapsed,
    closeTab,
    setActiveTabId,
    setCollapsed,
  } = useTerminalBar();

  const sidebarLeft = isMobile ? '0px' : sidebarState === 'expanded' ? '16rem' : '3rem';

  const allTabs = [
    { id: 'mayor', label: 'Mayor', kind: 'mayor' as const, agentId: '' },
    ...agentTabs,
  ];

  // Default to mayor tab if nothing selected
  const effectiveActiveId = activeTabId ?? 'mayor';
  const activeTab = allTabs.find(t => t.id === effectiveActiveId) ?? allTabs[0];

  return (
    <div
      className="fixed right-0 bottom-0 z-50 border-t border-white/[0.08] bg-[#0a0a0a] transition-[left] duration-200 ease-linear"
      style={{
        left: sidebarLeft,
        height: collapsed ? COLLAPSED_HEIGHT : COLLAPSED_HEIGHT + EXPANDED_HEIGHT,
      }}
    >
      {/* Tab bar */}
      <div
        className="flex items-center border-b border-white/[0.06]"
        style={{ height: COLLAPSED_HEIGHT }}
      >
        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex h-full items-center gap-1.5 px-3 text-white/40 transition-colors hover:text-white/60"
        >
          <TerminalIcon className="size-3" />
          {collapsed ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>

        {/* Tabs */}
        <div className="flex flex-1 items-center gap-0.5 overflow-x-auto px-1">
          <AnimatePresence initial={false}>
            {allTabs.map(tab => {
              const isActive = tab.id === effectiveActiveId;
              const isMayor = tab.kind === 'mayor';

              return (
                <motion.div
                  key={tab.id}
                  layout
                  initial={{ opacity: 0, scale: 0.85, width: 0 }}
                  animate={{ opacity: 1, scale: 1, width: 'auto' }}
                  exit={{ opacity: 0, scale: 0.85, width: 0 }}
                  transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                  onClick={() => {
                    setActiveTabId(tab.id);
                    if (collapsed) setCollapsed(false);
                  }}
                  className={`group flex cursor-pointer items-center gap-1.5 overflow-hidden rounded-t-md px-3 py-1 text-[11px] whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-white/[0.06] text-white/80'
                      : 'text-white/35 hover:bg-white/[0.03] hover:text-white/55'
                  }`}
                >
                  {isMayor && (
                    <Crown className="size-3 shrink-0 text-[color:oklch(95%_0.15_108_/_0.6)]" />
                  )}
                  <span className="max-w-[120px] truncate">{tab.label}</span>
                  {!isMayor && (
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                      className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10"
                    >
                      <X className="size-2.5" />
                    </button>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* Terminal content area */}
      <AnimatePresence mode="wait">
        {!collapsed && activeTab && (
          <motion.div
            key={activeTab.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ height: EXPANDED_HEIGHT }}
            className="overflow-hidden"
          >
            {activeTab.kind === 'mayor' ? (
              <MayorTerminalPane townId={townId} collapsed={collapsed} />
            ) : (
              <AgentTerminalPane townId={townId} agentId={activeTab.agentId} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Mayor Terminal Pane ──────────────────────────────────────────────────

function MayorTerminalPane({ townId, collapsed }: { townId: string; collapsed: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Initializing...');

  const terminalRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const ptyRef = useRef<{ id: string } | null>(null);

  const ensureMayor = useMutation(
    trpc.gastown.ensureMayor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getMayorStatus.queryKey(),
        });
      },
    })
  );

  const ensuredTownRef = useRef<string | null>(null);
  useEffect(() => {
    if (ensuredTownRef.current === townId) return;
    ensuredTownRef.current = townId;
    ensureMayor.mutate({ townId });
  }, [townId]);

  const statusQuery = useQuery({
    ...trpc.gastown.getMayorStatus.queryOptions({ townId }),
    refetchInterval: query => {
      const session = query.state.data?.session;
      if (!session) return 3_000;
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

  const connectedAgentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!mayorAgentId || mayorAgentId === connectedAgentRef.current) return;
    const agentId = mayorAgentId;
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
        if (!disposed && !result) setStatus('Failed to connect to mayor');
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
              // not JSON control message
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
  }, [mayorAgentId, townId]);

  const { state: sidebarState } = useSidebar();

  // Re-fit terminal when expanding or sidebar changes
  useEffect(() => {
    if (collapsed || !fitAddonRef.current) return;
    const t = setTimeout(() => fitAddonRef.current?.fit(), 50);
    return () => clearTimeout(t);
  }, [collapsed, sidebarState]);

  return (
    <div className="relative h-full">
      {/* Status indicator overlaid top-right */}
      <div className="absolute top-1.5 right-3 z-10 flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-white/20'}`} />
        <span className="text-[10px] text-white/35">{status}</span>
      </div>
      <div ref={terminalRef} className="h-full overflow-hidden px-1" />
    </div>
  );
}

// ── Agent Terminal Pane ──────────────────────────────────────────────────

function AgentTerminalPane({ townId, agentId }: { townId: string; agentId: string }) {
  const trpc = useTRPC();
  const terminalRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const ptyRef = useRef<{ id: string } | null>(null);
  const [status, setStatus] = useState<string>('Initializing...');
  const [connected, setConnected] = useState(false);

  const createPty = useMutation(
    trpc.gastown.createPtySession.mutationOptions({
      onError: err => setStatus(`Error: ${err.message}`),
    })
  );

  const resizePty = useMutation(trpc.gastown.resizePtySession.mutationOptions({}));
  const resizeMutateRef = useRef(resizePty.mutate);
  resizeMutateRef.current = resizePty.mutate;

  useEffect(() => {
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

      setStatus('Creating PTY session...');

      function doResize(cols: number, rows: number) {
        if (!ptyRef.current) return;
        resizeMutateRef.current({ townId, agentId, ptyId: ptyRef.current.id, cols, rows });
      }

      let result: { pty: { id: string }; wsUrl: string };
      try {
        result = await new Promise<{ pty: { id: string }; wsUrl: string }>((resolve, reject) => {
          createPty.mutate({ townId, agentId }, { onSuccess: resolve, onError: reject });
        });
      } catch (err) {
        if (!disposed) {
          setStatus(
            `Error: ${err instanceof Error ? err.message : 'Failed to create PTY session'}`
          );
        }
        return;
      }

      if (disposed) return;

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
              // not JSON
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
      wsRef.current?.close(1000, 'Agent terminal unmount');
      wsRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      ptyRef.current = null;
    };
  }, [townId, agentId]);

  return (
    <div className="relative h-full">
      <div className="absolute top-1.5 right-3 z-10 flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-white/20'}`} />
        <span className="text-[10px] text-white/35">{status}</span>
      </div>
      <div ref={terminalRef} className="h-full overflow-hidden px-1" />
    </div>
  );
}
