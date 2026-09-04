'use client';

import React, { useEffect, useRef, useState, type RefObject } from 'react';
import { SessionStatusIndicator } from '@/components/shared/SessionStatusIndicator';
import { TimeAgo } from '@/components/shared/TimeAgo';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  FileDiff,
  LoaderCircle,
  MessageSquare,
  Plus,
  Terminal,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { SessionPrIndicator } from './SessionPrIndicator';
import { CHAT_TAB_ID, fileTabId, terminalTabId } from './workspace-tabs';
import type { FileWorkspaceTab, TerminalWorkspaceTab, WorkspaceTabId } from './workspace-tabs';
import type { StoredSession } from './types';

type TerminalStatusSummary = {
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'exited' | 'error';
  statusText: string;
};

type RenameTap = {
  sessionId: string;
  x: number;
  y: number;
  time: number;
};

function statusDotClass(status: TerminalStatusSummary['status']): string {
  if (status === 'connected') return 'bg-emerald-500';
  if (status === 'error' || status === 'exited') return 'bg-destructive';
  return 'bg-amber-500';
}

const tabClassName =
  'border-border bg-muted/40 text-muted-foreground flex h-8 min-w-0 max-w-full shrink-0 items-center rounded-md border [@media(any-pointer:coarse)]:h-12';
const activeTabClassName = 'border-foreground/30 bg-secondary text-foreground shadow-sm';
const tabTriggerClassName =
  'h-full min-w-0 gap-1.5 px-2 text-xs hover:bg-accent/60 focus-visible:ring-offset-0 focus-visible:ring-inset data-[state=active]:border-0 data-[state=active]:bg-transparent data-[state=active]:shadow-none [@media(any-pointer:coarse)]:min-w-11';
const tabActionClassName =
  'text-muted-foreground h-full w-8 shrink-0 rounded-none px-0 focus-visible:ring-inset [@media(any-pointer:coarse)]:w-11';
const renameHint = 'Double-click to rename.';

export function CloudAgentWorkspaceTabs({
  activeTabId,
  activeTabRef,
  chatSessions,
  currentSessionId,
  worktreeId,
  openChatSessionIds,
  closedChatSessionIds,
  onSelectChat,
  onCloseChat,
  onCreateChat,
  isCreatingChat = false,
  onRenameChat,
  deletingSessionIds = [],
  terminals,
  files,
  onCloseFile,
  terminalStatuses,
  canCreateTerminal,
  onSelectTab,
  onCreateTerminal,
  onCloseTerminal,
  className,
}: {
  activeTabId: WorkspaceTabId;
  activeTabRef?: RefObject<HTMLButtonElement | null>;
  files: FileWorkspaceTab[];
  onCloseFile: (path: string) => void;
  chatSessions: StoredSession[];
  currentSessionId: string | null;
  worktreeId?: string | null;
  openChatSessionIds?: readonly string[];
  closedChatSessionIds?: readonly string[];
  onSelectChat: (sessionId: string) => void;
  onCloseChat?: (sessionId: string) => void;
  onCreateChat?: () => void;
  isCreatingChat?: boolean;
  onRenameChat?: (sessionId: string, title: string) => Promise<void>;
  deletingSessionIds?: readonly string[];
  terminals: TerminalWorkspaceTab[];
  terminalStatuses: Record<string, TerminalStatusSummary | undefined>;
  canCreateTerminal: boolean;
  onSelectTab: (tabId: WorkspaceTabId) => void;
  onCreateTerminal: () => void;
  onCloseTerminal: (terminalId: string) => void;
  className?: string;
}) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const savingRenameRef = useRef(false);
  const cancelledRenameRef = useRef(false);
  const touchStartRef = useRef<RenameTap | null>(null);
  const lastTapRef = useRef<RenameTap | null>(null);
  const lastPointerTypeRef = useRef('');
  const localSelectedTabRef = useRef<HTMLButtonElement>(null);
  const selectedTabRef = activeTabRef ?? localSelectedTabRef;
  const activeTabWrapperRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabOptionsTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreTabFocusRef = useRef(false);
  const currentSession = chatSessions.find(session => session.sessionId === currentSessionId);
  const selectedWorktreeId = worktreeId === undefined ? currentSession?.worktreeId : worktreeId;
  const groupedChatSessions = selectedWorktreeId
    ? chatSessions.filter(session => session.worktreeId === selectedWorktreeId)
    : [];
  const groupedSessionsById = new Map(
    groupedChatSessions.map(session => [session.sessionId, session])
  );
  const visibleChatSessions =
    openChatSessionIds === undefined
      ? groupedChatSessions
      : openChatSessionIds
          .map(sessionId => groupedSessionsById.get(sessionId))
          .filter(session => session !== undefined);
  const openSessionIds = new Set(visibleChatSessions.map(session => session.sessionId));
  const closedChatSessions = (
    closedChatSessionIds ?? groupedChatSessions.map(session => session.sessionId)
  ).flatMap(sessionId => {
    const session = groupedSessionsById.get(sessionId);
    return session && !openSessionIds.has(sessionId) ? [session] : [];
  });
  const selectedValue =
    activeTabId === CHAT_TAB_ID && selectedWorktreeId && currentSessionId
      ? `chat:${currentSessionId}`
      : activeTabId;

  useEffect(() => {
    if (!editingSessionId) return;
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [editingSessionId]);

  useEffect(() => {
    const revealActiveTab = () => {
      activeTabWrapperRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    revealActiveTab();
    if (restoreTabFocusRef.current) {
      restoreTabFocusRef.current = false;
      (selectedTabRef.current ?? tabOptionsTriggerRef.current)?.focus({ preventScroll: true });
    }

    const tabList = tabListRef.current;
    if (!tabList) return;
    const resizeObserver = new ResizeObserver(revealActiveTab);
    resizeObserver.observe(tabList);
    if (activeTabWrapperRef.current) resizeObserver.observe(activeTabWrapperRef.current);
    return () => resizeObserver.disconnect();
  }, [selectedValue, visibleChatSessions.length, terminals.length, files.length, selectedTabRef]);

  const handleStartRename = (session: StoredSession, trigger: HTMLButtonElement) => {
    if (
      !onRenameChat ||
      deletingSessionIds.includes(session.sessionId) ||
      editingSessionId === session.sessionId ||
      savingRenameRef.current
    ) {
      return;
    }
    cancelledRenameRef.current = false;
    renameTriggerRef.current = trigger;
    lastTapRef.current = null;
    setEditingSessionId(session.sessionId);
    setEditTitle(session.prompt);
  };

  const handleFinishRename = () => {
    cancelledRenameRef.current = true;
    setEditingSessionId(null);
    if (document.activeElement === editInputRef.current) {
      renameTriggerRef.current?.focus({ preventScroll: true });
    }
  };

  const handleSaveRename = async () => {
    if (!editingSessionId || !onRenameChat || savingRenameRef.current) return;
    if (cancelledRenameRef.current) {
      cancelledRenameRef.current = false;
      return;
    }

    const title = editTitle.trim();
    const session = groupedSessionsById.get(editingSessionId);
    if (!title || title === session?.prompt) {
      handleFinishRename();
      return;
    }

    savingRenameRef.current = true;
    try {
      await onRenameChat(editingSessionId, title);
    } catch {
      toast.error('Failed to rename session. Please try again.');
    } finally {
      handleFinishRename();
      savingRenameRef.current = false;
    }
  };

  return (
    <div className={cn('flex min-w-0 max-w-full items-center gap-1 overflow-hidden', className)}>
      <TabsList
        ref={tabListRef}
        aria-label="Cloud Agent workspace"
        className="h-10 min-w-0 flex-1 justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-none bg-transparent p-1 [scrollbar-width:none] [@media(any-pointer:coarse)]:h-14 [&::-webkit-scrollbar]:hidden"
      >
        {selectedWorktreeId ? (
          visibleChatSessions.map(session => {
            const active = activeTabId === CHAT_TAB_ID && session.sessionId === currentSessionId;
            const isDeleting = deletingSessionIds.includes(session.sessionId);
            const isEditing = editingSessionId === session.sessionId;
            const canRename = Boolean(onRenameChat) && !isDeleting;

            return (
              <div
                key={session.sessionId}
                ref={active ? activeTabWrapperRef : undefined}
                className={cn(
                  tabClassName,
                  active && activeTabClassName,
                  isDeleting && 'opacity-60'
                )}
              >
                <Tooltip delayDuration={400}>
                  <TabsTrigger
                    ref={active ? selectedTabRef : undefined}
                    value={`chat:${session.sessionId}`}
                    disabled={isDeleting}
                    aria-description={canRename ? renameHint : undefined}
                    aria-keyshortcuts={canRename ? 'F2' : undefined}
                    asChild
                    className={cn(
                      tabTriggerClassName,
                      'max-w-52',
                      canRename && 'touch-manipulation select-none',
                      (onCloseChat || isEditing || isDeleting || session.associatedPr) &&
                        'rounded-r-none'
                    )}
                    onDoubleClick={event => {
                      if (!canRename || lastPointerTypeRef.current === 'touch') return;
                      event.preventDefault();
                      handleStartRename(session, event.currentTarget);
                    }}
                    onPointerDown={event => {
                      lastPointerTypeRef.current = event.pointerType;
                      if (event.pointerType !== 'touch' || !event.isPrimary || !canRename) {
                        touchStartRef.current = null;
                        lastTapRef.current = null;
                        return;
                      }
                      touchStartRef.current = {
                        sessionId: session.sessionId,
                        x: event.clientX,
                        y: event.clientY,
                        time: event.timeStamp,
                      };
                    }}
                    onPointerMove={event => {
                      const start = touchStartRef.current;
                      if (
                        start &&
                        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
                      ) {
                        touchStartRef.current = null;
                        lastTapRef.current = null;
                      }
                    }}
                    onPointerCancel={() => {
                      touchStartRef.current = null;
                      lastTapRef.current = null;
                    }}
                    onClick={event => {
                      const start = touchStartRef.current;
                      touchStartRef.current = null;
                      if (!start || start.sessionId !== session.sessionId) return;
                      if (
                        event.timeStamp - start.time > 500 ||
                        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
                      ) {
                        lastTapRef.current = null;
                        return;
                      }
                      const lastTap = lastTapRef.current;
                      if (
                        lastTap?.sessionId === session.sessionId &&
                        event.timeStamp - lastTap.time <= 350 &&
                        Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= 24
                      ) {
                        handleStartRename(session, event.currentTarget);
                      } else {
                        lastTapRef.current = {
                          sessionId: session.sessionId,
                          x: event.clientX,
                          y: event.clientY,
                          time: event.timeStamp,
                        };
                      }
                    }}
                    onKeyDown={event => {
                      if (event.key === 'F2' && canRename) {
                        event.preventDefault();
                        event.stopPropagation();
                        handleStartRename(session, event.currentTarget);
                      }
                    }}
                  >
                    <TooltipTrigger>
                      <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {isEditing ? (
                        <span className="sr-only">{session.prompt}</span>
                      ) : (
                        <>
                          <span className="min-w-0 max-w-36 truncate">{session.prompt}</span>
                          <SessionStatusIndicator
                            status={session.sessionStatus ?? null}
                            statusUpdatedAt={session.sessionStatusUpdatedAt ?? null}
                          />
                        </>
                      )}
                    </TooltipTrigger>
                  </TabsTrigger>
                  <TooltipContent className="max-w-[min(24rem,calc(100vw-2rem))] wrap-anywhere">
                    {session.prompt}
                    {canRename && <p className="text-muted-foreground mt-1">{renameHint}</p>}
                  </TooltipContent>
                </Tooltip>

                {!isEditing && session.associatedPr && (
                  <span className="shrink-0 px-1 [@media(any-pointer:coarse)]:[&_button]:min-h-11 [@media(any-pointer:coarse)]:[&_button]:min-w-11">
                    <SessionPrIndicator session={session} />
                  </span>
                )}

                {isEditing ? (
                  <input
                    ref={editInputRef}
                    aria-label={`Rename ${session.prompt}`}
                    value={editTitle}
                    onChange={event => setEditTitle(event.target.value)}
                    onBlur={() => void handleSaveRename()}
                    onKeyDown={event => {
                      event.stopPropagation();
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleSaveRename();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        if (!savingRenameRef.current) handleFinishRename();
                      }
                    }}
                    className="bg-muted focus-visible:ring-ring h-7 w-40 min-w-0 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset [@media(any-pointer:coarse)]:h-11"
                  />
                ) : isDeleting ? (
                  <LoaderCircle
                    aria-label="Deleting session"
                    className="text-muted-foreground mx-2 h-4 w-4 animate-spin"
                  />
                ) : null}

                {onCloseChat && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Close ${session.prompt}`}
                    title="Close tab. Reopen from Sessions in the tab options menu."
                    disabled={isDeleting || isEditing}
                    className={cn(tabActionClassName, 'rounded-r-md')}
                    onClick={() => {
                      restoreTabFocusRef.current = true;
                      onCloseChat(session.sessionId);
                    }}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                )}
              </div>
            );
          })
        ) : (
          <div
            ref={activeTabId === CHAT_TAB_ID ? activeTabWrapperRef : undefined}
            className={cn(tabClassName, activeTabId === CHAT_TAB_ID && activeTabClassName)}
          >
            <TabsTrigger
              ref={activeTabId === CHAT_TAB_ID ? selectedTabRef : undefined}
              value={CHAT_TAB_ID}
              className={tabTriggerClassName}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">Chat</span>
            </TabsTrigger>
          </div>
        )}

        {terminals.map(tab => {
          const tabId = terminalTabId(tab.id);
          const active = activeTabId === tabId;
          const terminalStatus = terminalStatuses[tab.id];
          const status = terminalStatus?.status ?? 'connecting';
          const statusText = terminalStatus?.statusText ?? 'Connecting';

          return (
            <div
              key={tab.id}
              ref={active ? activeTabWrapperRef : undefined}
              className={cn(tabClassName, active && activeTabClassName)}
            >
              <Tooltip delayDuration={400}>
                <TabsTrigger
                  ref={active ? selectedTabRef : undefined}
                  value={tabId}
                  asChild
                  className={cn(tabTriggerClassName, 'rounded-r-none')}
                >
                  <TooltipTrigger>
                    <Terminal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 max-w-32 truncate">{tab.title}</span>
                    <span className="sr-only">{statusText}</span>
                    <span
                      aria-hidden="true"
                      className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClass(status))}
                    />
                  </TooltipTrigger>
                </TabsTrigger>
                <TooltipContent className="max-w-[min(24rem,calc(100vw-2rem))] wrap-anywhere">
                  {tab.title}
                </TooltipContent>
              </Tooltip>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Close ${tab.title}`}
                title="Close terminal"
                className={cn(tabActionClassName, 'rounded-r-md')}
                onClick={() => {
                  restoreTabFocusRef.current = true;
                  onCloseTerminal(tab.id);
                }}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          );
        })}
        {files.map(tab => {
          const tabId = fileTabId(tab.path);
          const active = activeTabId === tabId;
          const name = tab.path.slice(tab.path.lastIndexOf('/') + 1);
          return (
            <div
              key={tabId}
              ref={active ? activeTabWrapperRef : undefined}
              className={cn(tabClassName, active && activeTabClassName)}
            >
              <TabsTrigger
                ref={active ? selectedTabRef : undefined}
                value={tabId}
                title={tab.path}
                className={tabTriggerClassName}
              >
                <FileDiff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="max-w-48 truncate">{name}</span>
              </TabsTrigger>
              <Button
                variant="ghost"
                size="icon"
                className={tabActionClassName}
                aria-label={`Close ${name}`}
                onClick={() => {
                  onCloseFile(tab.path);
                  requestAnimationFrame(() => selectedTabRef.current?.focus());
                }}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </TabsList>

      <div className="flex shrink-0 items-center gap-1 py-1 pr-1">
        {selectedWorktreeId ? (
          <div className="border-border flex h-8 shrink-0 items-center rounded-md border [@media(any-pointer:coarse)]:h-12">
            {onCreateChat && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={isCreatingChat}
                aria-label="New chat"
                aria-busy={isCreatingChat || undefined}
                title={isCreatingChat ? 'Creating chat…' : 'New chat'}
                className="h-full w-8 rounded-r-none px-0 focus-visible:ring-inset [@media(any-pointer:coarse)]:w-11"
                onClick={onCreateChat}
              >
                {isCreatingChat ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={tabOptionsTriggerRef}
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Tab options"
                  title="Tab options and Sessions"
                  className={cn(
                    'h-full w-8 px-0 focus-visible:ring-inset [@media(any-pointer:coarse)]:w-11',
                    onCreateChat && 'border-border rounded-l-none border-l'
                  )}
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                aria-label="Tab options"
                className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-80 max-w-[calc(100vw-2rem)]"
              >
                {onCreateChat && (
                  <DropdownMenuItem
                    disabled={isCreatingChat}
                    onSelect={onCreateChat}
                    className="[@media(any-pointer:coarse)]:min-h-11"
                  >
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    New chat
                  </DropdownMenuItem>
                )}
                {canCreateTerminal && (
                  <DropdownMenuItem
                    onSelect={onCreateTerminal}
                    className="[@media(any-pointer:coarse)]:min-h-11"
                  >
                    <Terminal className="h-4 w-4" aria-hidden="true" />
                    New terminal
                  </DropdownMenuItem>
                )}
                {(onCreateChat || canCreateTerminal) && <DropdownMenuSeparator />}
                <DropdownMenuLabel>Sessions</DropdownMenuLabel>
                {closedChatSessions.length === 0 ? (
                  <DropdownMenuItem disabled>No closed sessions</DropdownMenuItem>
                ) : (
                  closedChatSessions.map(session => {
                    const isDeleting = deletingSessionIds.includes(session.sessionId);

                    return (
                      <DropdownMenuItem
                        key={session.sessionId}
                        textValue={session.prompt}
                        disabled={isDeleting}
                        className="items-start py-2 [@media(any-pointer:coarse)]:min-h-11"
                        onSelect={() => {
                          if (activeTabId !== CHAT_TAB_ID) onSelectTab(CHAT_TAB_ID);
                          onSelectChat(session.sessionId);
                        }}
                      >
                        <MessageSquare className="mt-0.5 h-4 w-4" aria-hidden="true" />
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="line-clamp-2 wrap-anywhere whitespace-normal">
                            {session.prompt}
                          </span>
                          <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                            <span>Closed tab</span>
                            <TimeAgo timestamp={session.updatedAt} />
                            {isDeleting ? (
                              <LoaderCircle
                                aria-label="Deleting session"
                                className="h-4 w-4 animate-spin"
                              />
                            ) : (
                              <SessionStatusIndicator
                                status={session.sessionStatus ?? null}
                                statusUpdatedAt={session.sessionStatusUpdatedAt ?? null}
                              />
                            )}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : canCreateTerminal ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="New terminal"
            title="New terminal"
            className="text-muted-foreground h-8 w-8 shrink-0 px-0 focus-visible:ring-inset [@media(any-pointer:coarse)]:h-11 [@media(any-pointer:coarse)]:w-11"
            onClick={onCreateTerminal}
          >
            <Terminal className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
