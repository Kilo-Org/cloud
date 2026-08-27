'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  SquarePen,
  Search,
  SlidersHorizontal,
  MoreHorizontal,
  Trash2,
  X,
  Pencil,
  LoaderCircle,
  Plus,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TimeAgo } from '@/components/shared/TimeAgo';
import {
  getSessionActivityIndicatorKind,
  SessionStatusIndicator,
} from '@/components/shared/SessionStatusIndicator';
import { usePathname, useRouter } from 'next/navigation';
import type { StoredSession } from './types';
import {
  getSidebarWorktreeActivity,
  getSidebarWorktreeLabel,
  getSidebarWorktreePrSession,
  groupSidebarSessionsByDate,
  type SidebarWorktreeDetails,
  type SidebarWorktreeGroup,
} from './hooks/useSidebarSessions';
import { SessionPrIndicator } from './SessionPrIndicator';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type ActiveSession = {
  id: string;
  status: string;
  title: string;
  connectionId: string;
  gitUrl?: string;
  gitBranch?: string;
};

type ChatSidebarProps = {
  sessions: StoredSession[];
  currentSessionId?: string;
  selectedWorktreeId?: string | null;
  organizationId?: string;
  onOpenSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  deletingSessionIds?: string[];
  onRenameSession?: (sessionId: string, title: string) => Promise<void>;
  onCreateWorktreeChat?: (sourceKiloSessionId: string) => Promise<boolean>;
  creatingWorktreeSourceSessionId?: string | null;
  worktreeDetails?: Record<string, SidebarWorktreeDetails>;
  onRenameWorktree?: (worktreeId: string, name: string) => Promise<void>;
  onDeleteWorktree?: (worktreeId: string) => void;
  deletingWorktreeId?: string;
  isInSheet?: boolean;
  activeSessions?: ActiveSession[];
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  platformFilter?: string[];
  onPlatformChange?: (platforms: string[]) => void;
  onMobileSheetOpenChange?: (open: boolean) => void;
  projectFilter?: string[];
  onProjectChange?: (gitUrls: string[]) => void;
  recentProjects?: Array<{ gitUrl: string; displayName: string }>;
};

function SessionRow({
  session,
  isActive,
  isLive,
  onDeleteSession,
  isDeleting,
  onStartRename,
  isEditing,
  editTitle,
  onEditTitleChange,
  onSaveRename,
  onCancelRename,
  onClick,
}: {
  session: StoredSession;
  isActive: boolean;
  isLive: boolean;
  onDeleteSession?: (sessionId: string) => void;
  isDeleting: boolean;
  onStartRename?: () => void;
  isEditing: boolean;
  editTitle: string;
  onEditTitleChange: (value: string) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const showActions = hovered || menuOpen;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [isEditing]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSaveRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancelRename();
    }
  };

  const isV2 = session.sessionId.startsWith('ses_');
  const sessionActivityIndicatorKind = getSessionActivityIndicatorKind(
    session.sessionStatus ?? null,
    session.sessionStatusUpdatedAt ?? null
  );
  const shouldReplaceTime = isLive || sessionActivityIndicatorKind !== null;

  return (
    <div
      onClick={isEditing || isDeleting ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'hover:bg-accent cursor-pointer rounded-lg text-sm transition-colors',
        isDeleting && 'cursor-wait opacity-60',
        isActive && 'bg-accent font-medium'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {isEditing ? (
          <input
            ref={inputRef}
            value={editTitle}
            onChange={e => onEditTitleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={onSaveRename}
            className="bg-muted min-w-0 flex-1 rounded px-1 py-0.5 text-sm leading-snug outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <>
            <span className="line-clamp-1 min-w-0 flex-1 leading-snug">{session.prompt}</span>
            <SessionPrIndicator session={session} />
            <span className="group/session-actions relative flex w-6 shrink-0 justify-end [@media(any-pointer:coarse)]:w-auto [@media(hover:none)]:w-auto">
              {isDeleting ? (
                <LoaderCircle
                  className="text-muted-foreground h-4 w-4 animate-spin"
                  aria-label="Deleting session"
                />
              ) : shouldReplaceTime ? (
                <span
                  className={cn(
                    'flex h-4 w-4 items-center justify-center group-focus-within/session-actions:invisible',
                    showActions && 'invisible'
                  )}
                >
                  {sessionActivityIndicatorKind ? (
                    <SessionStatusIndicator
                      status={session.sessionStatus ?? null}
                      statusUpdatedAt={session.sessionStatusUpdatedAt ?? null}
                    />
                  ) : null}
                </span>
              ) : (
                <span
                  className={cn(
                    'text-muted-foreground w-full text-right text-xs tabular-nums group-focus-within/session-actions:invisible [@media(any-pointer:coarse)]:w-auto [@media(hover:none)]:w-auto',
                    showActions && 'invisible'
                  )}
                >
                  <TimeAgo timestamp={session.updatedAt} compact />
                </span>
              )}
              {!isDeleting && (onDeleteSession || onStartRename) && (
                <span
                  className={cn(
                    'absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity focus-within:opacity-100 [@media(any-pointer:coarse)]:static [@media(any-pointer:coarse)]:ml-1 [@media(any-pointer:coarse)]:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:ml-1 [@media(hover:none)]:opacity-100',
                    showActions && 'opacity-100'
                  )}
                >
                  <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Session actions for ${session.prompt}`}
                        onClick={e => e.stopPropagation()}
                        className="hover:bg-muted focus-visible:ring-ring relative rounded-md p-0.5 before:absolute before:-inset-3 focus-visible:ring-2 focus-visible:outline-none"
                      >
                        <MoreHorizontal className="text-muted-foreground h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {onStartRename && isV2 && (
                        <DropdownMenuItem
                          onClick={e => {
                            e.stopPropagation();
                            onStartRename();
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                          Rename
                        </DropdownMenuItem>
                      )}
                      {onDeleteSession && (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={e => {
                            e.stopPropagation();
                            onDeleteSession(session.sessionId);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete session
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              )}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function WorktreeGroupRow({
  group,
  currentSessionId,
  selectedWorktreeId,
  onOpenSession,
  onCreateWorktreeChat,
  creatingWorktreeSourceSessionId,
  onRenameWorktree,
  onDeleteWorktree,
  isDeleting,
  activeSessionStatuses,
}: {
  group: SidebarWorktreeGroup;
  currentSessionId?: string;
  selectedWorktreeId?: string | null;
  onOpenSession: (sessionId: string) => void;
  onCreateWorktreeChat?: (sourceKiloSessionId: string) => Promise<boolean>;
  creatingWorktreeSourceSessionId?: string | null;
  onRenameWorktree?: (worktreeId: string, name: string) => Promise<void>;
  onDeleteWorktree?: (worktreeId: string) => void;
  isDeleting: boolean;
  activeSessionStatuses: ReadonlyMap<string, string>;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isSavingRename, setIsSavingRename] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const editingRef = useRef(false);
  const savingRenameRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const renameErrorId = useId();
  const label = getSidebarWorktreeLabel(group);
  const prSession = getSidebarWorktreePrSession(group);
  const activity = getSidebarWorktreeActivity(group.sessions, activeSessionStatuses);
  const shouldReplaceTime = activity.isLive || activity.status !== null;
  const hasActions = Boolean(onCreateWorktreeChat || onRenameWorktree || onDeleteWorktree);
  const isActive =
    selectedWorktreeId === group.worktreeId ||
    group.sessions.some(session => session.sessionId === currentSessionId);
  const isCreatingThisGroup = group.sessions.some(
    session => session.sessionId === creatingWorktreeSourceSessionId
  );
  const isCreationPending = creatingWorktreeSourceSessionId != null;
  const showActions = hasActions && (hovered || menuOpen || isCreatingThisGroup);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      openButtonRef.current?.focus({ preventScroll: true });
    }
  }, [isEditing]);

  useEffect(() => {
    if (renameError) inputRef.current?.focus();
  }, [renameError]);

  const finishRename = () => {
    editingRef.current = false;
    restoreFocusRef.current = document.activeElement === inputRef.current;
    setIsEditing(false);
    setRenameError(null);
  };

  const saveRename = async () => {
    if (!editingRef.current || !onRenameWorktree || savingRenameRef.current || isDeleting) return;
    const name = editName.trim();
    if (!name || name === label) {
      finishRename();
      return;
    }

    savingRenameRef.current = true;
    setIsSavingRename(true);
    setRenameError(null);
    try {
      await onRenameWorktree(group.worktreeId, name);
      finishRename();
    } catch {
      setRenameError('Failed to rename worktree. Please try again.');
    } finally {
      savingRenameRef.current = false;
      setIsSavingRename(false);
    }
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-busy={isDeleting || isSavingRename || isCreatingThisGroup || undefined}
      className={cn(
        'hover:bg-accent rounded-lg text-sm transition-colors',
        isDeleting && 'cursor-wait opacity-60',
        isActive && 'bg-accent font-medium'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {isEditing ? (
          <>
            <input
              ref={inputRef}
              aria-label={`Rename worktree ${label}`}
              aria-invalid={Boolean(renameError)}
              aria-describedby={renameError ? renameErrorId : undefined}
              disabled={isDeleting}
              readOnly={isSavingRename}
              value={editName}
              onChange={event => {
                setEditName(event.target.value);
                setRenameError(null);
              }}
              onBlur={() => void saveRename()}
              onKeyDown={event => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  if (!savingRenameRef.current) finishRename();
                }
              }}
              className="bg-muted focus:ring-ring min-w-0 flex-1 rounded px-1 py-0.5 text-sm leading-snug outline-none focus:ring-1"
            />
            {(isSavingRename || isDeleting) && (
              <LoaderCircle
                className="text-muted-foreground h-4 w-4 shrink-0 animate-spin"
                aria-label={isDeleting ? 'Deleting worktree' : 'Renaming worktree'}
              />
            )}
          </>
        ) : (
          <>
            <button
              ref={openButtonRef}
              type="button"
              disabled={isDeleting}
              onClick={() => onOpenSession(group.latestSession.sessionId)}
              aria-label={`Open worktree ${label}`}
              aria-current={isActive ? 'page' : undefined}
              className="focus-visible:ring-ring -my-2 -ml-3 flex min-w-0 flex-1 items-center rounded-md py-2 pl-3 text-left focus-visible:ring-2 focus-visible:outline-none disabled:cursor-wait"
            >
              <span className="line-clamp-1 min-w-0 leading-snug">{label}</span>
            </button>
            {prSession && <SessionPrIndicator session={prSession} />}
            <span className="group/session-actions relative flex w-6 shrink-0 justify-end [@media(any-pointer:coarse)]:w-auto [@media(hover:none)]:w-auto">
              {isDeleting ? (
                <LoaderCircle
                  className="text-muted-foreground h-4 w-4 animate-spin"
                  aria-label="Deleting worktree"
                />
              ) : shouldReplaceTime ? (
                <span
                  className={cn(
                    'flex h-4 w-4 items-center justify-center group-focus-within/session-actions:invisible',
                    showActions && 'invisible'
                  )}
                >
                  {activity.status && (
                    <SessionStatusIndicator
                      status={activity.status}
                      statusUpdatedAt={activity.statusUpdatedAt}
                    />
                  )}
                </span>
              ) : (
                <span
                  className={cn(
                    'text-muted-foreground w-full text-right text-xs tabular-nums group-focus-within/session-actions:invisible [@media(any-pointer:coarse)]:w-auto [@media(hover:none)]:w-auto',
                    showActions && 'invisible'
                  )}
                >
                  <TimeAgo timestamp={group.latestSession.updatedAt} compact />
                </span>
              )}
              {!isDeleting && hasActions && (
                <span
                  className={cn(
                    'absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity focus-within:opacity-100 [@media(any-pointer:coarse)]:static [@media(any-pointer:coarse)]:ml-1 [@media(any-pointer:coarse)]:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:ml-1 [@media(hover:none)]:opacity-100',
                    showActions && 'opacity-100'
                  )}
                >
                  <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Worktree actions for ${label}`}
                        onClick={event => event.stopPropagation()}
                        className="hover:bg-muted focus-visible:ring-ring relative rounded-md p-0.5 before:absolute before:-inset-3 focus-visible:ring-2 focus-visible:outline-none"
                      >
                        {isCreatingThisGroup ? (
                          <LoaderCircle
                            className="text-muted-foreground h-4 w-4 animate-spin"
                            aria-label="Creating chat"
                          />
                        ) : (
                          <MoreHorizontal className="text-muted-foreground h-4 w-4" />
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onCloseAutoFocus={event => {
                        if (editingRef.current) event.preventDefault();
                      }}
                    >
                      {onCreateWorktreeChat && (
                        <DropdownMenuItem
                          disabled={isCreationPending}
                          onSelect={() => {
                            void onCreateWorktreeChat(group.latestSession.sessionId);
                          }}
                        >
                          <Plus className="h-4 w-4" />
                          New chat
                        </DropdownMenuItem>
                      )}
                      {onRenameWorktree && (
                        <DropdownMenuItem
                          onSelect={() => {
                            editingRef.current = true;
                            setEditName(label);
                            setRenameError(null);
                            setIsEditing(true);
                            setMenuOpen(false);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                          Rename worktree
                        </DropdownMenuItem>
                      )}
                      {onDeleteWorktree && (
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={isCreatingThisGroup}
                          onSelect={() => onDeleteWorktree(group.worktreeId)}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete worktree
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              )}
            </span>
          </>
        )}
      </div>
      {isEditing && renameError && (
        <p id={renameErrorId} role="alert" className="text-destructive px-3 pb-2 text-xs">
          {renameError}
        </p>
      )}
    </div>
  );
}

const PLATFORM_FILTERS = [
  'cloud-agent',
  'extension',
  'cli',
  'slack',
  'github',
  'linear',
  'other',
] as const;

function platformFilterLabel(p: string): string {
  switch (p) {
    case 'cloud-agent':
      return 'Cloud';
    case 'extension':
      return 'Extension';
    case 'cli':
      return 'CLI';
    case 'slack':
      return 'Slack';
    case 'github':
      return 'GitHub';
    case 'linear':
      return 'Linear';
    case 'other':
      return 'Other';
    default:
      return p;
  }
}

export function ChatSidebar({
  sessions,
  currentSessionId,
  selectedWorktreeId,
  organizationId,
  onOpenSession,
  onDeleteSession,
  deletingSessionIds,
  onRenameSession,
  onCreateWorktreeChat,
  creatingWorktreeSourceSessionId,
  worktreeDetails = {},
  onRenameWorktree,
  onDeleteWorktree,
  deletingWorktreeId,
  isInSheet = false,
  activeSessions = [],
  searchQuery = '',
  onSearchChange,
  platformFilter,
  onPlatformChange,
  onMobileSheetOpenChange,
  projectFilter,
  onProjectChange,
  recentProjects = [],
}: ChatSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [showSearch, setShowSearch] = useState(false);

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const handleStartRename = useCallback((session: StoredSession) => {
    setEditingSessionId(session.sessionId);
    setEditTitle(session.prompt);
  }, []);

  const handleSaveRename = useCallback(async () => {
    if (!editingSessionId || !onRenameSession) return;
    const trimmed = editTitle.trim();
    if (!trimmed) {
      setEditingSessionId(null);
      return;
    }
    try {
      await onRenameSession(editingSessionId, trimmed);
    } finally {
      setEditingSessionId(null);
    }
  }, [editingSessionId, editTitle, onRenameSession]);

  const handleCancelRename = useCallback(() => {
    setEditingSessionId(null);
  }, []);

  const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
  const chatPath = `${basePath}/chat`;

  const handleNewSession = useCallback(() => {
    router.push(basePath);
    onMobileSheetOpenChange?.(false);
  }, [router, basePath, onMobileSheetOpenChange]);

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      if (onOpenSession) {
        onOpenSession(sessionId);
        onMobileSheetOpenChange?.(false);
        return;
      }

      const targetUrl = `${chatPath}?sessionId=${sessionId}`;
      // When already on the chat page viewing a new-format session, update the
      // URL via pushState to avoid a full server-component re-execution which
      // would unmount CloudAgentProvider and flash a blank screen.
      const usePushState = pathname === chatPath && isNewSession(sessionId);
      if (usePushState) {
        window.history.pushState(null, '', targetUrl);
      } else {
        router.push(targetUrl);
      }
      onMobileSheetOpenChange?.(false);
    },
    [chatPath, pathname, router, onOpenSession, onMobileSheetOpenChange]
  );

  const toggleSearch = useCallback(() => {
    setShowSearch(prev => {
      if (prev) {
        onSearchChange?.('');
      }
      return !prev;
    });
  }, [onSearchChange]);

  const activeSessionIds = useMemo(
    () => new Set(activeSessions.map(session => session.id)),
    [activeSessions]
  );
  const activeSessionStatuses = useMemo(
    () => new Map(activeSessions.map(session => [session.id, session.status])),
    [activeSessions]
  );

  const liveOnlySessions = activeSessions.filter(
    activeS => !sessions.some(s => s.sessionId === activeS.id)
  );

  const hasActiveFilter = (platformFilter?.length ?? 0) > 0 || (projectFilter?.length ?? 0) > 0;

  const dateGroups = useMemo(
    () => groupSidebarSessionsByDate(sessions, undefined, worktreeDetails),
    [sessions, worktreeDetails]
  );
  const renderSession = useCallback(
    (session: StoredSession) => (
      <SessionRow
        key={session.sessionId}
        session={session}
        isActive={session.sessionId === currentSessionId}
        isLive={activeSessionIds.has(session.sessionId)}
        onDeleteSession={onDeleteSession}
        onStartRename={onRenameSession ? () => handleStartRename(session) : undefined}
        isDeleting={deletingSessionIds?.includes(session.sessionId) ?? false}
        isEditing={editingSessionId === session.sessionId}
        editTitle={editTitle}
        onEditTitleChange={setEditTitle}
        onSaveRename={handleSaveRename}
        onCancelRename={handleCancelRename}
        onClick={() => handleSessionClick(session.sessionId)}
      />
    ),
    [
      activeSessionIds,
      currentSessionId,
      deletingSessionIds,
      editingSessionId,
      editTitle,
      handleCancelRename,
      handleSaveRename,
      handleSessionClick,
      handleStartRename,
      onDeleteSession,
      onRenameSession,
    ]
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className={cn('flex items-center gap-2 border-b px-3 py-2.5', isInSheet && 'pt-14')}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleNewSession}
              className="hover:bg-accent rounded-md p-1.5 transition-colors"
              aria-label="New session"
            >
              <SquarePen className="text-muted-foreground h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New session</TooltipContent>
        </Tooltip>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={toggleSearch}
            className={cn(
              'hover:bg-accent rounded-md p-1.5 transition-colors',
              showSearch && 'bg-accent'
            )}
          >
            <Search className="text-muted-foreground h-4 w-4" />
          </button>
          {(onPlatformChange || onProjectChange) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    'hover:bg-accent rounded-md p-1.5 transition-colors',
                    hasActiveFilter && 'bg-accent'
                  )}
                >
                  <SlidersHorizontal className="text-muted-foreground h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onProjectChange && recentProjects.length > 0 && (
                  <>
                    <DropdownMenuLabel>Project</DropdownMenuLabel>
                    {recentProjects.map(project => {
                      const isChecked = projectFilter?.includes(project.gitUrl) ?? false;
                      return (
                        <DropdownMenuCheckboxItem
                          key={project.gitUrl}
                          checked={isChecked}
                          onSelect={e => e.preventDefault()}
                          onCheckedChange={() => {
                            const current = projectFilter ?? [];
                            onProjectChange(
                              isChecked
                                ? current.filter(u => u !== project.gitUrl)
                                : [...current, project.gitUrl]
                            );
                          }}
                        >
                          {project.displayName}
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </>
                )}
                {onPlatformChange && (
                  <>
                    {onProjectChange && recentProjects.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel>Platform</DropdownMenuLabel>
                    {PLATFORM_FILTERS.map(p => {
                      const isChecked = platformFilter?.includes(p) ?? false;
                      return (
                        <DropdownMenuCheckboxItem
                          key={p}
                          checked={isChecked}
                          onSelect={e => e.preventDefault()}
                          onCheckedChange={() => {
                            const current = platformFilter ?? [];
                            onPlatformChange(
                              isChecked ? current.filter(f => f !== p) : [...current, p]
                            );
                          }}
                        >
                          {platformFilterLabel(p)}
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Collapsible search */}
      {showSearch && (
        <div className="border-b px-3 py-2">
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search sessions..."
              value={searchQuery}
              onChange={e => onSearchChange?.(e.target.value)}
              autoFocus
              className="bg-muted/50 placeholder:text-muted-foreground focus:ring-ring h-7 w-full rounded-md pr-2 pl-7 text-xs focus:ring-1 focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {hasActiveFilter && (
        <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
          {projectFilter?.map(gitUrl => (
            <button
              key={gitUrl}
              onClick={() => onProjectChange?.(projectFilter.filter(u => u !== gitUrl))}
              className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors"
            >
              {recentProjects.find(p => p.gitUrl === gitUrl)?.displayName ?? 'Project'}
              <X className="h-3 w-3 opacity-60" />
            </button>
          ))}
          {platformFilter?.map(p => (
            <button
              key={p}
              onClick={() => onPlatformChange?.(platformFilter.filter(f => f !== p))}
              className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors"
            >
              {platformFilterLabel(p)}
              <X className="h-3 w-3 opacity-60" />
            </button>
          ))}
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 space-y-px overflow-y-auto p-2">
        {sessions.length === 0 && liveOnlySessions.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500">No sessions yet</div>
        ) : (
          <>
            {/* Live-only sessions (not in stored list) */}
            {liveOnlySessions.length > 0 && (
              <>
                <div className="text-muted-foreground px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider uppercase">
                  Remote
                </div>
                {liveOnlySessions.map(activeS => {
                  const activityIndicatorKind = getSessionActivityIndicatorKind(
                    activeS.status,
                    null
                  );

                  return (
                    <div
                      key={activeS.id}
                      onClick={() => handleSessionClick(activeS.id)}
                      className={cn(
                        'group hover:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                        activeS.id === currentSessionId && 'bg-accent font-medium'
                      )}
                    >
                      <span className="line-clamp-1 min-w-0 flex-1 leading-snug">
                        {activeS.title}
                      </span>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {activityIndicatorKind ? (
                          <SessionStatusIndicator status={activeS.status} statusUpdatedAt={null} />
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </>
            )}

            {/* Stored sessions grouped by date */}
            {dateGroups.map((group, groupIdx) => (
              <div key={group.label}>
                <div
                  className={cn(
                    'text-muted-foreground px-2 pb-1 text-[11px] font-semibold tracking-wider uppercase',
                    groupIdx === 0 && liveOnlySessions.length === 0 ? 'pt-2' : 'pt-4'
                  )}
                >
                  {group.label}
                </div>
                {group.items.map(item => {
                  if (item.type === 'session') return renderSession(item.session);

                  return (
                    <WorktreeGroupRow
                      key={item.worktreeId}
                      group={item}
                      currentSessionId={currentSessionId}
                      selectedWorktreeId={selectedWorktreeId}
                      onOpenSession={handleSessionClick}
                      onCreateWorktreeChat={onCreateWorktreeChat}
                      creatingWorktreeSourceSessionId={creatingWorktreeSourceSessionId}
                      onRenameWorktree={onRenameWorktree}
                      onDeleteWorktree={onDeleteWorktree}
                      isDeleting={deletingWorktreeId === item.worktreeId}
                      activeSessionStatuses={activeSessionStatuses}
                    />
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
