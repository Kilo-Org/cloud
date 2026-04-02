'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SquarePen,
  Search,
  SlidersHorizontal,
  MoreHorizontal,
  Trash2,
  X,
  Pencil,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TimeAgo } from '@/components/shared/TimeAgo';
import { usePathname, useRouter } from 'next/navigation';
import { isToday, isYesterday, startOfDay, differenceInCalendarDays, format } from 'date-fns';
import type { StoredSession } from './types';
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

type DateGroup = {
  label: string;
  sessions: StoredSession[];
};

function groupSessionsByDate(sessions: StoredSession[]): DateGroup[] {
  const today: StoredSession[] = [];
  const yesterday: StoredSession[] = [];
  const namedDayBuckets = new Map<string, { daysAgo: number; sessions: StoredSession[] }>();
  const older: StoredSession[] = [];

  const now = new Date();
  const todayStart = startOfDay(now);

  for (const session of sessions) {
    const date = new Date(session.updatedAt);
    if (isToday(date)) {
      today.push(session);
    } else if (isYesterday(date)) {
      yesterday.push(session);
    } else {
      const daysAgo = differenceInCalendarDays(todayStart, startOfDay(date));
      if (daysAgo <= 7) {
        const dayName = format(date, 'EEEE');
        const bucket = namedDayBuckets.get(dayName);
        if (bucket) {
          bucket.sessions.push(session);
        } else {
          namedDayBuckets.set(dayName, { daysAgo, sessions: [session] });
        }
      } else {
        older.push(session);
      }
    }
  }

  const groups: DateGroup[] = [];
  if (today.length > 0) groups.push({ label: 'Today', sessions: today });
  if (yesterday.length > 0) groups.push({ label: 'Yesterday', sessions: yesterday });

  const sortedNamedDays = [...namedDayBuckets.entries()].sort(
    (a, b) => a[1].daysAgo - b[1].daysAgo
  );

  const MAX_NAMED_DAYS = 3;
  for (const [i, [dayName, bucket]] of sortedNamedDays.entries()) {
    if (i < MAX_NAMED_DAYS) {
      groups.push({ label: dayName, sessions: bucket.sessions });
    } else {
      older.push(...bucket.sessions);
    }
  }

  if (older.length > 0) {
    older.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    groups.push({ label: 'Older', sessions: older });
  }

  return groups;
}

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
  organizationId?: string;
  onDeleteSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string) => Promise<void>;
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

  return (
    <div
      onClick={isEditing ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'hover:bg-accent cursor-pointer rounded-lg text-sm transition-colors',
        isActive && 'bg-accent font-medium'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {isLive && (
          <span className="relative shrink-0">
            <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
          </span>
        )}
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
            <span className="relative shrink-0">
              <span className={cn('text-muted-foreground text-xs', showActions && 'invisible')}>
                <TimeAgo timestamp={session.updatedAt} compact />
              </span>
              {(onDeleteSession || onStartRename) && (
                <span
                  className={cn(
                    'absolute inset-y-0 right-0 flex items-center',
                    !showActions && 'invisible'
                  )}
                >
                  <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={e => e.stopPropagation()}
                        className="hover:bg-muted rounded-md p-0.5"
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
                          onClick={() => onDeleteSession(session.sessionId)}
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

const PLATFORM_FILTERS = ['cloud-agent', 'extension', 'cli', 'slack', 'other'] as const;

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
    case 'other':
      return 'Other';
    default:
      return p;
  }
}

export function ChatSidebar({
  sessions,
  currentSessionId,
  organizationId,
  onDeleteSession,
  onRenameSession,
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
    [chatPath, pathname, router, onMobileSheetOpenChange]
  );

  const toggleSearch = useCallback(() => {
    setShowSearch(prev => {
      if (prev) {
        onSearchChange?.('');
      }
      return !prev;
    });
  }, [onSearchChange]);

  const activeSessionIds = new Set(activeSessions.map(s => s.id));

  const liveOnlySessions = activeSessions.filter(
    activeS => !sessions.some(s => s.sessionId === activeS.id)
  );

  const hasActiveFilter = (platformFilter?.length ?? 0) > 0 || (projectFilter?.length ?? 0) > 0;

  const dateGroups = useMemo(() => groupSessionsByDate(sessions), [sessions]);

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
                {liveOnlySessions.map(activeS => (
                  <div
                    key={activeS.id}
                    onClick={() => handleSessionClick(activeS.id)}
                    className={cn(
                      'group hover:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                      activeS.id === currentSessionId && 'bg-accent font-medium'
                    )}
                  >
                    <span className="relative shrink-0">
                      <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
                    </span>
                    <span className="line-clamp-1 min-w-0 flex-1 leading-snug">
                      {activeS.title}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">{activeS.status}</span>
                  </div>
                ))}
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
                {group.sessions.map(session => (
                  <SessionRow
                    key={session.sessionId}
                    session={session}
                    isActive={session.sessionId === currentSessionId}
                    isLive={activeSessionIds.has(session.sessionId)}
                    onDeleteSession={onDeleteSession}
                    onStartRename={onRenameSession ? () => handleStartRename(session) : undefined}
                    isEditing={editingSessionId === session.sessionId}
                    editTitle={editTitle}
                    onEditTitleChange={setEditTitle}
                    onSaveRename={handleSaveRename}
                    onCancelRename={handleCancelRename}
                    onClick={() => handleSessionClick(session.sessionId)}
                  />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
