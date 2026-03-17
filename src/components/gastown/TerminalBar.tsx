'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useGastownTRPC, gastownWsUrl } from '@/lib/gastown/trpc';

import { useSidebar } from '@/components/ui/sidebar';
import { useTerminalBar } from './TerminalBarContext';
import { useDrawerStack } from './DrawerStack';
import { useXtermPty } from './useXtermPty';
import { ChevronDown, ChevronUp, Crown, Activity, Terminal as TerminalIcon, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const COLLAPSED_HEIGHT = 38;
const EXPANDED_HEIGHT = 300;

type TerminalBarProps = {
  townId: string;
  /** Override base path for org-scoped routes (e.g. /organizations/[id]/gastown/[townId]) */
  basePath?: string;
};

/**
 * Unified bottom terminal bar. Always shows a Mayor tab (non-closeable).
 * Agent terminal tabs are opened/closed via TerminalBarContext.
 */
export function TerminalBar({ townId, basePath: basePathOverride }: TerminalBarProps) {
  const townBasePath = basePathOverride ?? `/gastown/${townId}`;
  const { state: sidebarState, isMobile } = useSidebar();
  const {
    tabs: agentTabs,
    activeTabId,
    collapsed,
    closeTab,
    setActiveTabId,
    setCollapsed,
  } = useTerminalBar();
  const queryClient = useQueryClient();
  const drawerStack = useDrawerStack();
  const router = useRouter();

  // ── Always-on WebSocket for alarm status + UI action dispatch ──────
  // Lifted here so the connection persists regardless of which tab is active.

  const handleAgentStatus = useCallback(
    (_event: AgentStatusEvent) => {
      void queryClient.invalidateQueries({
        predicate: query => {
          const key = query.queryKey;
          if (!Array.isArray(key) || !Array.isArray(key[0])) return false;
          const path = key[0] as string[];
          return path.includes('listAgents');
        },
      });
    },
    [queryClient]
  );

  const handleUiAction = useCallback(
    (event: UiActionEvent) => {
      const { action } = event;
      switch (action.type) {
        case 'open_bead_drawer':
          if (action.beadId && action.rigId) {
            drawerStack.open({ type: 'bead', beadId: action.beadId, rigId: action.rigId });
          }
          break;
        case 'open_convoy_drawer':
          if (action.convoyId && action.townId) {
            drawerStack.open({ type: 'convoy', convoyId: action.convoyId, townId: action.townId });
          }
          break;
        case 'open_agent_drawer':
          if (action.agentId && action.rigId) {
            drawerStack.open({
              type: 'agent',
              agentId: action.agentId,
              rigId: action.rigId,
              townId: action.townId,
            });
          }
          break;
        case 'navigate':
          if (action.page) {
            const pageMap: Record<string, string> = {
              'town-overview': townBasePath,
              beads: `${townBasePath}/beads`,
              agents: `${townBasePath}/agents`,
              rigs: townBasePath,
              settings: `${townBasePath}/settings`,
            };
            const path = pageMap[action.page];
            if (path) {
              // Close any open drawers so they don't cover the new page
              drawerStack.closeAll();
              router.push(path);
            }
          }
          break;
        case 'highlight_bead':
          if (action.beadId && action.rigId) {
            drawerStack.open({ type: 'bead', beadId: action.beadId, rigId: action.rigId });
          }
          break;
      }
    },
    [drawerStack, router, townId]
  );

  const alarmWs = useAlarmStatusWs(townId, {
    onAgentStatus: handleAgentStatus,
    onUiAction: handleUiAction,
  });

  const sidebarLeft = isMobile ? '0px' : sidebarState === 'expanded' ? '16rem' : '3rem';

  const allTabs = [
    { id: 'status', label: 'Status', kind: 'status' as const, agentId: '' },
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
                  {tab.kind === 'status' && (
                    <Activity className="size-3 shrink-0 text-[color:oklch(85%_0.12_200_/_0.6)]" />
                  )}
                  <span className="max-w-[120px] truncate">{tab.label}</span>
                  {!isMayor && tab.kind !== 'status' && (
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
            ) : activeTab.kind === 'status' ? (
              <AlarmStatusPane townId={townId} alarmWs={alarmWs} />
            ) : (
              <AgentTerminalPane townId={townId} agentId={activeTab.agentId} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Alarm Status Pane ────────────────────────────────────────────────────

type AlarmStatus = {
  alarm: { nextFireAt: string | null; intervalMs: number; intervalLabel: string };
  agents: { working: number; idle: number; stalled: number; dead: number; total: number };
  beads: {
    open: number;
    inProgress: number;
    inReview: number;
    failed: number;
    triageRequests: number;
  };
  patrol: {
    guppWarnings: number;
    guppEscalations: number;
    stalledAgents: number;
    orphanedHooks: number;
  };
  recentEvents: Array<{ time: string; type: string; message: string }>;
};

type AgentStatusEvent = {
  type: 'agent_status';
  agentId: string;
  message: string;
  timestamp: string;
};

type UiActionEvent = {
  channel: 'ui_action';
  action: {
    type: string;
    beadId?: string;
    rigId?: string;
    convoyId?: string;
    agentId?: string;
    townId?: string;
    page?: string;
  };
  ts: string;
};

/**
 * Hook that connects to the TownDO status WebSocket and returns the
 * latest alarm status snapshot. Falls back to tRPC polling if the
 * WebSocket fails or disconnects.
 *
 * The optional `onAgentStatus` callback is invoked for `agent_status`
 * events so callers can react in real time (e.g. invalidate listAgents).
 */
function useAlarmStatusWs(
  townId: string,
  callbacks?: {
    onAgentStatus?: (event: AgentStatusEvent) => void;
    onUiAction?: (event: UiActionEvent) => void;
  }
): {
  data: AlarmStatus | null;
  connected: boolean;
  error: string | null;
} {
  const [data, setData] = useState<AlarmStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onAgentStatusRef = useRef(callbacks?.onAgentStatus);
  onAgentStatusRef.current = callbacks?.onAgentStatus;
  const onUiActionRef = useRef(callbacks?.onUiAction);
  onUiActionRef.current = callbacks?.onUiAction;

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    const wsUrl = gastownWsUrl(`/api/towns/${townId}/status/ws`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setError(null);
    };

    ws.onmessage = (e: MessageEvent) => {
      if (!mountedRef.current || typeof e.data !== 'string') return;
      try {
        const parsed: unknown = JSON.parse(e.data);
        if (parsed === null || typeof parsed !== 'object') return;
        const msg = parsed as Record<string, unknown>;

        if (msg.type === 'agent_status') {
          // Lightweight agent_status event — dispatch to callback, don't
          // overwrite the alarm status snapshot.
          onAgentStatusRef.current?.(parsed as AgentStatusEvent);
        } else if (msg.channel === 'ui_action') {
          // UI action from the mayor — dispatch to callback for DrawerStack/router.
          onUiActionRef.current?.(parsed as UiActionEvent);
        } else if ('alarm' in msg) {
          // Only alarm snapshots have an `alarm` field. Bead, convoy,
          // and other channel frames are silently ignored here to avoid
          // overwriting the status data with the wrong shape.
          setData(parsed as AlarmStatus);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      // Reconnect after 3s
      reconnectTimerRef.current = setTimeout(connect, 3_000);
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setError('WebSocket connection failed');
    };
  }, [townId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close(1000, 'Component unmount');
      wsRef.current = null;
    };
  }, [connect]);

  return { data, connected, error };
}

type AlarmWsResult = {
  data: AlarmStatus | null;
  connected: boolean;
  error: string | null;
};

function AlarmStatusPane({ townId, alarmWs }: { townId: string; alarmWs: AlarmWsResult }) {
  const trpc = useGastownTRPC();

  const { data: wsData, connected: wsConnected, error: wsError } = alarmWs;

  // Fall back to polling when WebSocket is unavailable (blocked, errored,
  // or never connected). The tRPC query is disabled while the WS is
  // providing data to avoid redundant requests.
  const wsFailed = !!wsError && !wsData;
  const pollingQuery = useQuery({
    ...trpc.gastown.getAlarmStatus.queryOptions({ townId }),
    enabled: wsFailed,
    refetchInterval: wsFailed ? 5_000 : false,
  });

  const data = wsData ?? (pollingQuery.data as AlarmStatus | undefined) ?? null;

  if (!data && !wsError && !pollingQuery.error) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-white/30">
        Connecting to alarm status...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-red-400/60">
        {wsError ?? 'Failed to load status'}
      </div>
    );
  }

  const hasIssues =
    data.patrol.guppWarnings > 0 ||
    data.patrol.guppEscalations > 0 ||
    data.patrol.stalledAgents > 0 ||
    data.patrol.orphanedHooks > 0;

  return (
    <div className="relative flex h-full gap-3 overflow-hidden p-3 text-[11px] text-white/70">
      {/* Connection indicator */}
      <div className="absolute top-1.5 right-3 z-10 flex items-center gap-1.5">
        <span
          className={`size-1.5 rounded-full ${wsConnected ? 'bg-emerald-400' : wsFailed ? 'bg-blue-400' : 'animate-pulse bg-yellow-400'}`}
        />
        <span className="text-[10px] text-white/35">
          {wsConnected ? 'Live' : wsFailed ? 'Polling' : 'Reconnecting...'}
        </span>
      </div>

      {/* Left column: status cards */}
      <div className="flex w-[340px] shrink-0 flex-col gap-2 overflow-y-auto">
        {/* Alarm */}
        <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-white/40 uppercase">
            <Activity className="size-3" />
            Alarm Loop
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <StatusRow label="Interval" value={data.alarm.intervalLabel} />
            <StatusRow
              label="Next fire"
              value={data.alarm.nextFireAt ? formatRelativeTime(data.alarm.nextFireAt) : 'not set'}
              warn={!data.alarm.nextFireAt}
            />
          </div>
        </div>

        {/* Agents */}
        <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
          <div className="mb-1.5 text-[10px] font-medium tracking-wide text-white/40 uppercase">
            Agents ({data.agents.total})
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <StatusRow
              label="Working"
              value={data.agents.working}
              highlight={data.agents.working > 0}
            />
            <StatusRow label="Idle" value={data.agents.idle} />
            <StatusRow label="Stalled" value={data.agents.stalled} warn={data.agents.stalled > 0} />
            <StatusRow label="Dead" value={data.agents.dead} warn={data.agents.dead > 0} />
          </div>
        </div>

        {/* Beads */}
        <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
          <div className="mb-1.5 text-[10px] font-medium tracking-wide text-white/40 uppercase">
            Beads
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <StatusRow label="Open" value={data.beads.open} />
            <StatusRow
              label="In Progress"
              value={data.beads.inProgress}
              highlight={data.beads.inProgress > 0}
            />
            <StatusRow
              label="In Review"
              value={data.beads.inReview}
              highlight={data.beads.inReview > 0}
            />
            <StatusRow label="Failed" value={data.beads.failed} warn={data.beads.failed > 0} />
            <StatusRow
              label="Triage"
              value={data.beads.triageRequests}
              warn={data.beads.triageRequests > 0}
            />
          </div>
        </div>

        {/* Patrol */}
        <div
          className={`rounded-md border p-2 ${
            hasIssues
              ? 'border-yellow-500/20 bg-yellow-500/[0.03]'
              : 'border-white/[0.06] bg-white/[0.02]'
          }`}
        >
          <div className="mb-1.5 text-[10px] font-medium tracking-wide text-white/40 uppercase">
            Patrol {hasIssues ? '(issues detected)' : ''}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <StatusRow
              label="GUPP Warns"
              value={data.patrol.guppWarnings}
              warn={data.patrol.guppWarnings > 0}
            />
            <StatusRow
              label="GUPP Escalations"
              value={data.patrol.guppEscalations}
              warn={data.patrol.guppEscalations > 0}
            />
            <StatusRow
              label="Stalled"
              value={data.patrol.stalledAgents}
              warn={data.patrol.stalledAgents > 0}
            />
            <StatusRow
              label="Orphaned Hooks"
              value={data.patrol.orphanedHooks}
              warn={data.patrol.orphanedHooks > 0}
            />
          </div>
        </div>
      </div>

      {/* Right column: event feed */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-white/[0.06] bg-white/[0.02]">
        <div className="border-b border-white/[0.06] px-2.5 py-1.5 text-[10px] font-medium tracking-wide text-white/40 uppercase">
          Recent Events
        </div>
        <div className="flex-1 overflow-y-auto">
          {data.recentEvents.length === 0 ? (
            <div className="flex h-full items-center justify-center text-white/20">
              No recent events
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {data.recentEvents.map((event, i) => (
                <div key={i} className="flex items-baseline gap-2 px-2.5 py-1.5">
                  <span className="shrink-0 text-[10px] text-white/25 tabular-nums">
                    {formatTime(event.time)}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${eventTypeColor(event.type)}`}
                  >
                    {event.type}
                  </span>
                  <span className="min-w-0 truncate">{event.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusRow({
  label,
  value,
  warn,
  highlight,
}: {
  label: string;
  value: string | number;
  warn?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-white/35">{label}</span>
      <span
        className={`tabular-nums ${
          warn ? 'text-yellow-400/80' : highlight ? 'text-emerald-400/80' : 'text-white/60'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 1000) return 'now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  return `${Math.round(diff / 60_000)}m`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function eventTypeColor(type: string): string {
  switch (type) {
    case 'status_changed':
      return 'bg-blue-500/15 text-blue-400/70';
    case 'assigned':
      return 'bg-emerald-500/15 text-emerald-400/70';
    case 'pr_created':
    case 'pr_merged':
      return 'bg-purple-500/15 text-purple-400/70';
    case 'pr_creation_failed':
    case 'escalation_created':
      return 'bg-yellow-500/15 text-yellow-400/70';
    default:
      return 'bg-white/5 text-white/40';
  }
}

// ── Terminal Status Badge ─────────────────────────────────────────────────

function TerminalStatusBadge({
  connectionStatus,
  status,
}: {
  connectionStatus: 'connected' | 'reconnecting' | 'disconnected';
  status: string;
}) {
  const dotColor =
    connectionStatus === 'connected'
      ? 'bg-emerald-400'
      : connectionStatus === 'reconnecting'
        ? 'animate-pulse bg-yellow-400'
        : 'bg-white/20';

  return (
    <div className="absolute top-1.5 right-3 z-10 flex items-center gap-1.5">
      <span className={`size-1.5 rounded-full ${dotColor}`} />
      <span className="text-[10px] text-white/35">{status}</span>
    </div>
  );
}

// ── Mayor Terminal Pane ──────────────────────────────────────────────────

function MayorTerminalPane({ townId, collapsed }: { townId: string; collapsed: boolean }) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();

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

  const { terminalRef, connectionStatus, status, fitAddonRef } = useXtermPty({
    townId,
    agentId: mayorAgentId,
    retries: 10,
    retryDelay: 3_000,
  });

  const { state: sidebarState } = useSidebar();

  // Re-fit terminal when expanding or sidebar changes
  useEffect(() => {
    if (collapsed || !fitAddonRef.current) return;
    const t = setTimeout(() => fitAddonRef.current?.fit(), 50);
    return () => clearTimeout(t);
  }, [collapsed, sidebarState]);

  return (
    <div className="relative h-full">
      <TerminalStatusBadge connectionStatus={connectionStatus} status={status} />
      <div ref={terminalRef} className="h-full overflow-hidden px-1" />
    </div>
  );
}

// ── Agent Terminal Pane ──────────────────────────────────────────────────

function AgentTerminalPane({ townId, agentId }: { townId: string; agentId: string }) {
  const { terminalRef, connectionStatus, status } = useXtermPty({
    townId,
    agentId,
  });

  return (
    <div className="relative h-full">
      <TerminalStatusBadge connectionStatus={connectionStatus} status={status} />
      <div ref={terminalRef} className="h-full overflow-hidden px-1" />
    </div>
  );
}
