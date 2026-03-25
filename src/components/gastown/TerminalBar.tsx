'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useGastownTRPC, gastownWsUrl } from '@/lib/gastown/trpc';

import { useSidebar } from '@/components/ui/sidebar';
import {
  useTerminalBar,
  COLLAPSED_SIZE,
  isHorizontal,
  clampSize,
  type TerminalPosition,
} from './TerminalBarContext';
import { useDrawerStack } from './DrawerStack';
import { useXtermPty } from './useXtermPty';
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Crown,
  Activity,
  Terminal as TerminalIcon,
  X,
  PanelBottom,
  PanelTop,
  PanelLeft,
  PanelRight,
  Bug,
  Github,
  MessageCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

type TerminalBarProps = {
  townId: string;
  /** Override base path for org-scoped routes (e.g. /organizations/[id]/gastown/[townId]) */
  basePath?: string;
};

/**
 * Unified terminal bar. Always shows a Mayor tab (non-closeable).
 * Agent terminal tabs are opened/closed via TerminalBarContext.
 * Can be positioned at bottom/top/right/left with drag-to-resize.
 */
export function TerminalBar({ townId, basePath: basePathOverride }: TerminalBarProps) {
  const townBasePath = basePathOverride ?? `/gastown/${townId}`;
  const { state: sidebarState, isMobile } = useSidebar();
  const {
    tabs: agentTabs,
    activeTabId,
    collapsed,
    position,
    size,
    closeTab,
    setActiveTabId,
    setCollapsed,
    setPosition,
    setSize,
  } = useTerminalBar();
  const queryClient = useQueryClient();
  const drawerStack = useDrawerStack();
  const router = useRouter();

  // ── Always-on WebSocket for alarm status + UI action dispatch ──────
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
    [drawerStack, router, townBasePath]
  );

  const alarmWs = useAlarmStatusWs(townId, {
    onAgentStatus: handleAgentStatus,
    onUiAction: handleUiAction,
  });

  const sidebarLeft = isMobile ? '0px' : sidebarState === 'expanded' ? '16rem' : '3rem';
  const horizontal = isHorizontal(position);

  const allTabs = [
    { id: 'status', label: 'Status', kind: 'status' as const, agentId: '' },
    { id: 'mayor', label: 'Mayor', kind: 'mayor' as const, agentId: '' },
    ...agentTabs,
  ];

  const effectiveActiveId = activeTabId ?? 'mayor';
  const activeTab = allTabs.find(t => t.id === effectiveActiveId) ?? allTabs[0];

  // ── Resize drag logic ──────────────────────────────────────────────
  const isDragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startSize.current = size;
      startPos.current = horizontal ? e.clientY : e.clientX;

      const onPointerMove = (ev: PointerEvent) => {
        if (!isDragging.current) return;
        const currentPos = horizontal ? ev.clientY : ev.clientX;
        // For bottom/right, dragging toward start of viewport increases size.
        // For top/left, dragging away from start of viewport increases size.
        const delta =
          position === 'bottom' || position === 'right'
            ? startPos.current - currentPos
            : currentPos - startPos.current;
        const newSize = clampSize(startSize.current + delta, position);
        setSize(newSize);
      };

      const onPointerUp = () => {
        isDragging.current = false;
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };

      document.body.style.userSelect = 'none';
      document.body.style.cursor = horizontal ? 'ns-resize' : 'ew-resize';
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    },
    [size, position, horizontal, setSize]
  );

  // ── Compute container styles ───────────────────────────────────────
  const totalSize = collapsed ? COLLAPSED_SIZE : COLLAPSED_SIZE + size;

  const containerStyle = (() => {
    const base: React.CSSProperties = { zIndex: 50 };

    if (position === 'bottom') {
      return {
        ...base,
        left: sidebarLeft,
        right: 0,
        bottom: 0,
        height: totalSize,
      };
    }
    if (position === 'top') {
      return {
        ...base,
        left: sidebarLeft,
        right: 0,
        top: 0,
        height: totalSize,
      };
    }
    if (position === 'right') {
      return {
        ...base,
        right: 0,
        top: 0,
        bottom: 0,
        width: totalSize,
      };
    }
    // left
    return {
      ...base,
      left: sidebarLeft,
      top: 0,
      bottom: 0,
      width: totalSize,
    };
  })();

  // Border class depends on which edge faces content
  const borderClass = {
    bottom: 'border-t',
    top: 'border-b',
    right: 'border-l',
    left: 'border-r',
  }[position];

  // Resize handle — rendered as a flex child so it naturally sits at the correct edge
  // and doesn't compete with content stacking contexts for pointer events.
  const isVerticalHandle = !horizontal;
  const resizeHandleClass = [
    'group/resize shrink-0 flex items-center justify-center',
    isVerticalHandle ? 'h-full w-2 cursor-ew-resize' : 'w-full h-2 cursor-ns-resize',
  ].join(' ');
  const resizeHandleIndicator = isVerticalHandle
    ? 'h-8 w-0.5 rounded-full bg-white/0 group-hover/resize:bg-white/25 transition-colors'
    : 'w-8 h-0.5 rounded-full bg-white/0 group-hover/resize:bg-white/25 transition-colors';

  // ── Collapse chevron direction ─────────────────────────────────────
  const CollapseIcon = (() => {
    if (collapsed) {
      // Show icon pointing toward expansion
      return { bottom: ChevronUp, top: ChevronDown, right: ChevronLeft, left: ChevronRight }[
        position
      ];
    }
    // Show icon pointing toward collapse
    return { bottom: ChevronDown, top: ChevronUp, right: ChevronRight, left: ChevronLeft }[
      position
    ];
  })();

  // ── Layout direction ───────────────────────────────────────────────
  // Horizontal: tab bar is a row at top (bottom position) or bottom (top position),
  //             content fills remaining height.
  // Vertical:   tab bar is a column at top, content fills remaining width.

  return (
    <div
      className={`fixed ${borderClass} border-white/[0.08] bg-[#0a0a0a] transition-[left] duration-200 ease-linear`}
      style={containerStyle}
    >
      <div className={`flex h-full w-full ${horizontal ? 'flex-col' : 'flex-row'}`}>
        {position === 'bottom' && (
          <>
            {!collapsed && (
              <div className={resizeHandleClass} onPointerDown={onResizePointerDown}>
                <div className={resizeHandleIndicator} />
              </div>
            )}
            <TabBar
              allTabs={allTabs}
              effectiveActiveId={effectiveActiveId}
              collapsed={collapsed}
              horizontal={horizontal}
              position={position}
              CollapseIcon={CollapseIcon}
              setActiveTabId={setActiveTabId}
              setCollapsed={setCollapsed}
              setPosition={setPosition}
              closeTab={closeTab}
            />
            <TerminalContent
              activeTab={activeTab}
              collapsed={collapsed}
              horizontal={horizontal}
              size={size}
              townId={townId}
              alarmWs={alarmWs}
            />
          </>
        )}
        {position === 'top' && (
          <>
            <TerminalContent
              activeTab={activeTab}
              collapsed={collapsed}
              horizontal={horizontal}
              size={size}
              townId={townId}
              alarmWs={alarmWs}
            />
            <TabBar
              allTabs={allTabs}
              effectiveActiveId={effectiveActiveId}
              collapsed={collapsed}
              horizontal={horizontal}
              position={position}
              CollapseIcon={CollapseIcon}
              setActiveTabId={setActiveTabId}
              setCollapsed={setCollapsed}
              setPosition={setPosition}
              closeTab={closeTab}
            />
            {!collapsed && (
              <div className={resizeHandleClass} onPointerDown={onResizePointerDown}>
                <div className={resizeHandleIndicator} />
              </div>
            )}
          </>
        )}
        {position === 'right' && (
          <>
            {!collapsed && (
              <div className={resizeHandleClass} onPointerDown={onResizePointerDown}>
                <div className={resizeHandleIndicator} />
              </div>
            )}
            <TabBar
              allTabs={allTabs}
              effectiveActiveId={effectiveActiveId}
              collapsed={collapsed}
              horizontal={horizontal}
              position={position}
              CollapseIcon={CollapseIcon}
              setActiveTabId={setActiveTabId}
              setCollapsed={setCollapsed}
              setPosition={setPosition}
              closeTab={closeTab}
            />
            <TerminalContent
              activeTab={activeTab}
              collapsed={collapsed}
              horizontal={horizontal}
              size={size}
              townId={townId}
              alarmWs={alarmWs}
            />
          </>
        )}
        {position === 'left' && (
          <>
            <TabBar
              allTabs={allTabs}
              effectiveActiveId={effectiveActiveId}
              collapsed={collapsed}
              horizontal={horizontal}
              position={position}
              CollapseIcon={CollapseIcon}
              setActiveTabId={setActiveTabId}
              setCollapsed={setCollapsed}
              setPosition={setPosition}
              closeTab={closeTab}
            />
            <TerminalContent
              activeTab={activeTab}
              collapsed={collapsed}
              horizontal={horizontal}
              size={size}
              townId={townId}
              alarmWs={alarmWs}
            />
            {!collapsed && (
              <div className={resizeHandleClass} onPointerDown={onResizePointerDown}>
                <div className={resizeHandleIndicator} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Tab Bar ──────────────────────────────────────────────────────────────

type TabDef = {
  id: string;
  label: string;
  kind: 'mayor' | 'agent' | 'status';
  agentId: string;
};

function TabBar({
  allTabs,
  effectiveActiveId,
  collapsed,
  horizontal,
  position,
  CollapseIcon,
  setActiveTabId,
  setCollapsed,
  setPosition,
  closeTab,
}: {
  allTabs: TabDef[];
  effectiveActiveId: string;
  collapsed: boolean;
  horizontal: boolean;
  position: TerminalPosition;
  CollapseIcon: React.ComponentType<{ className?: string }>;
  setActiveTabId: (id: string) => void;
  setCollapsed: (collapsed: boolean) => void;
  setPosition: (position: TerminalPosition) => void;
  closeTab: (tabId: string) => void;
}) {
  const [showPositionPicker, setShowPositionPicker] = useState(false);
  const [showBugMenu, setShowBugMenu] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const bugMenuRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!showPositionPicker && !showBugMenu) return;
    const handler = (e: MouseEvent) => {
      if (
        showPositionPicker &&
        pickerRef.current &&
        !pickerRef.current.contains(e.target as Node)
      ) {
        setShowPositionPicker(false);
      }
      if (showBugMenu && bugMenuRef.current && !bugMenuRef.current.contains(e.target as Node)) {
        setShowBugMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPositionPicker, showBugMenu]);

  const borderClass = horizontal ? 'border-b border-white/[0.06]' : 'border-r border-white/[0.06]';

  return (
    <div
      className={`flex ${horizontal ? 'items-center' : 'flex-col items-stretch'} ${borderClass} shrink-0`}
      style={horizontal ? { height: COLLAPSED_SIZE } : { width: COLLAPSED_SIZE }}
    >
      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className={`flex items-center justify-center gap-1.5 text-white/40 transition-colors hover:text-white/60 ${
          horizontal ? 'h-full px-3' : 'w-full py-3'
        }`}
      >
        <TerminalIcon className="size-3" />
        <CollapseIcon className="size-3" />
      </button>

      {/* Tabs */}
      <div
        className={`flex ${horizontal ? 'flex-1 items-center gap-0.5 overflow-x-auto px-1' : 'flex-1 flex-col gap-0.5 overflow-y-auto py-1'}`}
      >
        <AnimatePresence initial={false}>
          {allTabs.map(tab => {
            const isActive = tab.id === effectiveActiveId;
            const isMayor = tab.kind === 'mayor';

            return (
              <motion.div
                key={tab.id}
                layout
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                onClick={() => {
                  setActiveTabId(tab.id);
                  if (collapsed) setCollapsed(false);
                }}
                className={`group flex cursor-pointer items-center whitespace-nowrap transition-colors ${
                  horizontal
                    ? `gap-1.5 overflow-hidden rounded-t-md px-3 py-1 text-[11px]`
                    : `relative justify-center overflow-visible rounded-md px-1 py-2`
                } ${
                  isActive
                    ? 'bg-white/[0.06] text-white/80'
                    : 'text-white/35 hover:bg-white/[0.03] hover:text-white/55'
                }`}
                title={horizontal ? undefined : tab.label}
              >
                {isMayor && (
                  <Crown
                    className={`shrink-0 text-[color:oklch(95%_0.15_108_/_0.6)] ${horizontal ? 'size-3' : 'size-3.5'}`}
                  />
                )}
                {tab.kind === 'status' && (
                  <Activity
                    className={`shrink-0 text-[color:oklch(85%_0.12_200_/_0.6)] ${horizontal ? 'size-3' : 'size-3.5'}`}
                  />
                )}
                {tab.kind === 'agent' && !horizontal && (
                  <TerminalIcon className="size-3.5 shrink-0" />
                )}
                {horizontal && <span className="max-w-[120px] truncate">{tab.label}</span>}
                {!isMayor && tab.kind !== 'status' && (
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className={`shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10 ${
                      horizontal ? '' : 'absolute -top-1 -right-1'
                    }`}
                  >
                    <X className="size-2.5" />
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Bug report dropdown */}
      {horizontal && (
        <div ref={bugMenuRef} className="relative shrink-0">
          <button
            onClick={() => setShowBugMenu(p => !p)}
            className="mr-2 flex items-center gap-1 rounded px-2 py-1 text-[10px] text-white/30 transition-colors hover:bg-white/[0.04] hover:text-white/50"
          >
            <Bug className="size-3" />
            <span className="hidden sm:inline">Report a Bug</span>
          </button>
          {showBugMenu && (
            <BugReportMenu
              position={position}
              triggerRef={bugMenuRef}
              onClose={() => setShowBugMenu(false)}
            />
          )}
        </div>
      )}

      {/* Position picker */}
      <div ref={pickerRef}>
        <button
          onClick={() => setShowPositionPicker(p => !p)}
          className={`flex items-center justify-center text-white/30 transition-colors hover:text-white/50 ${
            horizontal ? 'h-full px-2' : 'w-full py-2'
          }`}
          title="Change terminal position"
        >
          {position === 'bottom' && <PanelBottom className="size-3.5" />}
          {position === 'top' && <PanelTop className="size-3.5" />}
          {position === 'left' && <PanelLeft className="size-3.5" />}
          {position === 'right' && <PanelRight className="size-3.5" />}
        </button>
        {showPositionPicker && (
          <PositionPicker
            current={position}
            onSelect={p => {
              setPosition(p);
              setShowPositionPicker(false);
            }}
            position={position}
            triggerRef={pickerRef}
          />
        )}
      </div>
    </div>
  );
}

// ── Position Picker Popup ────────────────────────────────────────────────

const POSITION_OPTIONS: { value: TerminalPosition; label: string; Icon: typeof PanelBottom }[] = [
  { value: 'bottom', label: 'Bottom', Icon: PanelBottom },
  { value: 'top', label: 'Top', Icon: PanelTop },
  { value: 'left', label: 'Left', Icon: PanelLeft },
  { value: 'right', label: 'Right', Icon: PanelRight },
];

function PositionPicker({
  current,
  onSelect,
  position,
  triggerRef,
}: {
  current: TerminalPosition;
  onSelect: (p: TerminalPosition) => void;
  position: TerminalPosition;
  triggerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });

  useEffect(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const tr = trigger.getBoundingClientRect();
    const pr = popover.getBoundingClientRect();
    const gap = 4;

    let top: number;
    let left: number;

    if (position === 'bottom') {
      top = tr.top - pr.height - gap;
      left = tr.right - pr.width;
    } else if (position === 'top') {
      top = tr.bottom + gap;
      left = tr.right - pr.width;
    } else if (position === 'left') {
      top = tr.top;
      left = tr.right + gap;
    } else {
      // right
      top = tr.top;
      left = tr.left - pr.width - gap;
    }

    // Clamp to viewport
    top = Math.max(4, Math.min(top, window.innerHeight - pr.height - 4));
    left = Math.max(4, Math.min(left, window.innerWidth - pr.width - 4));

    setStyle({ top, left, opacity: 1 });
  }, [position, triggerRef]);

  return (
    <div
      ref={popoverRef}
      className="fixed z-[60] w-max rounded-lg border border-white/[0.15] bg-[#1e1e1e] p-1.5 shadow-2xl backdrop-blur-sm"
      style={style}
    >
      <div className="grid grid-cols-2 gap-1">
        {POSITION_OPTIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            onClick={() => onSelect(value)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-[11px] whitespace-nowrap transition-colors ${
              current === value
                ? 'bg-white/[0.12] text-white/90'
                : 'text-white/50 hover:bg-white/[0.07] hover:text-white/70'
            }`}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Bug Report Menu ──────────────────────────────────────────────────────

const BUG_REPORT_OPTIONS = [
  {
    label: 'New GitHub Issue',
    href: 'https://github.com/Kilo-Org/cloud/issues/new?template=gastown-bug.yml&labels=gastown,bug',
    Icon: Github,
  },
  {
    label: 'Discord Channel',
    href: 'https://discord.com/channels/1349288496988160052/1485796776635142174',
    Icon: MessageCircle,
  },
];

function BugReportMenu({
  position,
  triggerRef,
  onClose,
}: {
  position: TerminalPosition;
  triggerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });

  useEffect(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const tr = trigger.getBoundingClientRect();
    const pr = popover.getBoundingClientRect();
    const gap = 4;

    let top: number;
    let left: number;

    if (position === 'bottom') {
      top = tr.top - pr.height - gap;
      left = tr.left;
    } else if (position === 'top') {
      top = tr.bottom + gap;
      left = tr.left;
    } else if (position === 'left') {
      top = tr.top;
      left = tr.right + gap;
    } else {
      top = tr.top;
      left = tr.left - pr.width - gap;
    }

    top = Math.max(4, Math.min(top, window.innerHeight - pr.height - 4));
    left = Math.max(4, Math.min(left, window.innerWidth - pr.width - 4));

    setStyle({ top, left, opacity: 1 });
  }, [position, triggerRef]);

  return (
    <div
      ref={popoverRef}
      className="fixed z-[60] w-max rounded-lg border border-white/[0.15] bg-[#1e1e1e] p-1.5 shadow-2xl backdrop-blur-sm"
      style={style}
    >
      <div className="flex flex-col gap-0.5">
        {BUG_REPORT_OPTIONS.map(({ label, href, Icon }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-[11px] text-white/50 whitespace-nowrap transition-colors hover:bg-white/[0.07] hover:text-white/70"
          >
            <Icon className="size-3.5" />
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}

// ── Terminal Content Area ─────────────────────────────────────────────────

function TerminalContent({
  activeTab,
  collapsed,
  horizontal,
  size,
  townId,
  alarmWs,
}: {
  activeTab: TabDef;
  collapsed: boolean;
  horizontal: boolean;
  size: number;
  townId: string;
  alarmWs: AlarmWsResult;
}) {
  if (collapsed) return null;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={activeTab.id}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        style={horizontal ? { height: size } : { width: size }}
        className={`overflow-hidden ${horizontal ? '' : 'h-full'}`}
      >
        {activeTab.kind === 'mayor' ? (
          <MayorTerminalPane townId={townId} collapsed={collapsed} />
        ) : activeTab.kind === 'status' ? (
          <AlarmStatusPane townId={townId} alarmWs={alarmWs} horizontal={horizontal} />
        ) : (
          <AgentTerminalPane townId={townId} agentId={activeTab.agentId} />
        )}
      </motion.div>
    </AnimatePresence>
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
          onAgentStatusRef.current?.(parsed as AgentStatusEvent);
        } else if (msg.channel === 'ui_action') {
          onUiActionRef.current?.(parsed as UiActionEvent);
        } else if ('alarm' in msg) {
          setData(parsed as AlarmStatus);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
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

function AlarmStatusPane({
  townId,
  alarmWs,
  horizontal,
}: {
  townId: string;
  alarmWs: AlarmWsResult;
  horizontal: boolean;
}) {
  const trpc = useGastownTRPC();

  const { data: wsData, connected: wsConnected, error: wsError } = alarmWs;

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

  // Vertical orientation: single-column stacked layout
  if (!horizontal) {
    return (
      <div className="relative flex h-full flex-col gap-2 overflow-y-auto p-3 text-[11px] text-white/70">
        <ConnectionIndicator connected={wsConnected} failed={wsFailed} />
        <StatusCards data={data} hasIssues={hasIssues} />
        <EventFeed events={data.recentEvents} />
      </div>
    );
  }

  // Horizontal: two-column layout
  return (
    <div className="relative flex h-full gap-3 overflow-hidden p-3 text-[11px] text-white/70">
      <ConnectionIndicator connected={wsConnected} failed={wsFailed} />

      {/* Left column: status cards */}
      <div className="flex w-[340px] shrink-0 flex-col gap-2 overflow-y-auto">
        <StatusCards data={data} hasIssues={hasIssues} />
      </div>

      {/* Right column: event feed */}
      <EventFeed events={data.recentEvents} />
    </div>
  );
}

function ConnectionIndicator({ connected, failed }: { connected: boolean; failed: boolean }) {
  return (
    <div className="absolute top-1.5 right-3 z-10 flex items-center gap-1.5">
      <span
        className={`size-1.5 rounded-full ${connected ? 'bg-emerald-400' : failed ? 'bg-blue-400' : 'animate-pulse bg-yellow-400'}`}
      />
      <span className="text-[10px] text-white/35">
        {connected ? 'Live' : failed ? 'Polling' : 'Reconnecting...'}
      </span>
    </div>
  );
}

function StatusCards({ data, hasIssues }: { data: AlarmStatus; hasIssues: boolean }) {
  return (
    <>
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
    </>
  );
}

function EventFeed({ events }: { events: Array<{ time: string; type: string; message: string }> }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-white/[0.06] bg-white/[0.02]">
      <div className="border-b border-white/[0.06] px-2.5 py-1.5 text-[10px] font-medium tracking-wide text-white/40 uppercase">
        Recent Events
      </div>
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex h-full items-center justify-center text-white/20">
            No recent events
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {events.map((event, i) => (
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
  const { position, size } = useTerminalBar();

  // Re-fit terminal when expanding, sidebar changes, or size/position changes
  useEffect(() => {
    if (collapsed || !fitAddonRef.current) return;
    const t = setTimeout(() => fitAddonRef.current?.fit(), 50);
    return () => clearTimeout(t);
  }, [collapsed, sidebarState, position, size]);

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
