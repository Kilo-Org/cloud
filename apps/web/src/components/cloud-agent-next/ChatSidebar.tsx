'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
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
  FolderInput,
  FolderPlus,
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
  type SidebarForegroundSessionStatus,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { WorkspaceFolder } from '@/lib/cloud-agent/workspace-folders';
import type { WorkspaceFolderController } from './hooks/useWorkspaceFolders';
import { WorkspaceFolderSection } from './WorkspaceFolderSection';
import { WorkspaceFolderDialog } from './WorkspaceFolderDialog';
import {
  getWorkspaceFolderColor,
  getWorkspaceFolderDropAction,
  getWorkspaceFolderId,
  groupWorkspacesByFolder,
  isFolderWorkspace,
  type WorkspaceFolderDragItem,
  type WorkspaceFolderDropTarget,
} from './workspace-folders';

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
  foregroundSession?: SidebarForegroundSessionStatus | null;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  platformFilter?: string[];
  onPlatformChange?: (platforms: string[]) => void;
  onMobileSheetOpenChange?: (open: boolean) => void;
  projectFilter?: string[];
  onProjectChange?: (gitUrls: string[]) => void;
  recentProjects?: Array<{ gitUrl: string; displayName: string }>;
  workspaceFolders?: WorkspaceFolderController;
};

type WorktreeFolderControls = {
  folders: WorkspaceFolder[];
  folderId: string | null;
  disabled: boolean;
  isDragging: boolean;
  onMove: (folderId: string | null) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
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
  foregroundSession,
  folderControls,
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
  foregroundSession?: SidebarForegroundSessionStatus | null;
  folderControls?: WorktreeFolderControls;
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
  const activity = getSidebarWorktreeActivity(
    group.sessions,
    activeSessionStatuses,
    group.details?.sessions,
    foregroundSession
  );
  const shouldReplaceTime = activity.isLive || activity.status !== null;
  const hasActions = Boolean(
    onCreateWorktreeChat || onRenameWorktree || onDeleteWorktree || folderControls
  );
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
      data-worktree-id={group.worktreeId}
      draggable={Boolean(folderControls && !folderControls.disabled && !isEditing && !isDeleting)}
      onDragStart={folderControls?.onDragStart}
      onDragEnd={folderControls?.onDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-busy={isDeleting || isSavingRename || isCreatingThisGroup || undefined}
      className={cn(
        'hover:bg-accent rounded-lg text-sm transition-colors',
        isDeleting && 'cursor-wait opacity-60',
        folderControls?.isDragging && 'opacity-50',
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
                      {folderControls && (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger
                            disabled={folderControls.disabled}
                            className="gap-2"
                          >
                            <FolderInput className="text-muted-foreground size-4" />
                            Move to folder
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto">
                            <DropdownMenuRadioGroup
                              value={folderControls.folderId ?? 'ungrouped'}
                              onValueChange={value =>
                                folderControls.onMove(value === 'ungrouped' ? null : value)
                              }
                            >
                              <DropdownMenuRadioItem value="ungrouped">
                                Ungrouped
                              </DropdownMenuRadioItem>
                              {folderControls.folders.map(folder => (
                                <DropdownMenuRadioItem key={folder.id} value={folder.id}>
                                  <span
                                    aria-hidden="true"
                                    className="size-2.5 shrink-0 rounded-full"
                                    style={{
                                      backgroundColor: getWorkspaceFolderColor(folder.color),
                                    }}
                                  />
                                  <span className="max-w-48 truncate">{folder.name}</span>
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
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
  foregroundSession,
  searchQuery = '',
  onSearchChange,
  platformFilter,
  onPlatformChange,
  onMobileSheetOpenChange,
  projectFilter,
  onProjectChange,
  recentProjects = [],
  workspaceFolders,
}: ChatSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [showSearch, setShowSearch] = useState(false);
  const [folderEditor, setFolderEditor] = useState<WorkspaceFolder | 'new' | null>(null);
  const [dragItem, setDragItem] = useState<WorkspaceFolderDragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<WorkspaceFolderDropTarget | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const newFolderButtonRef = useRef<HTMLButtonElement>(null);
  const [shouldFocusNewFolder, setShouldFocusNewFolder] = useState(false);
  const canEditFolders = Boolean(
    workspaceFolders &&
    !workspaceFolders.isLoading &&
    !workspaceFolders.isError &&
    !workspaceFolders.isSaving
  );

  useEffect(() => {
    if (!shouldFocusNewFolder || !canEditFolders) return;
    newFolderButtonRef.current?.focus();
    setShouldFocusNewFolder(false);
  }, [shouldFocusNewFolder, canEditFolders]);

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
  const { folderGroups, ungrouped } = useMemo(
    () => groupWorkspacesByFolder(dateGroups, workspaceFolders?.folders ?? []),
    [dateGroups, workspaceFolders?.folders]
  );
  const folderWorkspaceIds = useMemo(
    () =>
      new Set(
        dateGroups.flatMap(group =>
          group.items.flatMap(item =>
            item.type === 'worktree' && isFolderWorkspace(item) ? [item.worktreeId] : []
          )
        )
      ),
    [dateGroups]
  );

  const clearDrag = () => {
    setDragItem(null);
    setDropTarget(null);
  };

  const startDrag = (event: DragEvent<HTMLDivElement>, item: WorkspaceFolderDragItem) => {
    if (!canEditFolders) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-kilo-workspace-folder', JSON.stringify(item));
    setDragItem(item);
    setDropTarget(null);
  };

  const folderTarget = (
    event: DragEvent<HTMLElement>,
    folderId: string
  ): WorkspaceFolderDropTarget => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      type: 'folder',
      id: folderId,
      placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
    };
  };

  const dragOver = (event: DragEvent<HTMLElement>, target: WorkspaceFolderDropTarget) => {
    if (
      !canEditFolders ||
      !getWorkspaceFolderDropAction(
        dragItem,
        target,
        workspaceFolders?.folders ?? [],
        folderWorkspaceIds
      )
    ) {
      setDropTarget(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(target);
  };

  const dragLeave = (event: DragEvent<HTMLElement>) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    ) {
      setDropTarget(null);
    }
  };

  const moveWorktree = async (worktreeId: string, folderId: string | null) => {
    if (await workspaceFolders?.moveWorktree(worktreeId, folderId)) {
      requestAnimationFrame(() =>
        sidebarRef.current
          ?.querySelector<HTMLButtonElement>(
            `[data-worktree-id="${CSS.escape(worktreeId)}"] button`
          )
          ?.focus({ preventScroll: true })
      );
    }
  };

  const drop = (event: DragEvent<HTMLElement>, target: WorkspaceFolderDropTarget) => {
    const action = canEditFolders
      ? getWorkspaceFolderDropAction(
          dragItem,
          target,
          workspaceFolders?.folders ?? [],
          folderWorkspaceIds
        )
      : null;
    clearDrag();
    if (!action || !workspaceFolders) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.type === 'move-worktree') {
      void moveWorktree(action.worktreeId, action.folderId);
    } else {
      void workspaceFolders.reorderFolders(action.folderIds);
    }
  };

  const moveFolder = (folderId: string, direction: 'up' | 'down') => {
    if (!workspaceFolders || !canEditFolders) return;
    const index = workspaceFolders.folders.findIndex(folder => folder.id === folderId);
    const neighbor = workspaceFolders.folders[index + (direction === 'up' ? -1 : 1)];
    if (!neighbor) return;
    const action = getWorkspaceFolderDropAction(
      { type: 'folder', id: folderId },
      { type: 'folder', id: neighbor.id, placement: direction === 'up' ? 'before' : 'after' },
      workspaceFolders.folders,
      folderWorkspaceIds
    );
    if (action?.type === 'reorder-folders') void workspaceFolders.reorderFolders(action.folderIds);
  };

  const renderWorktree = (group: SidebarWorktreeGroup) => (
    <WorktreeGroupRow
      key={group.worktreeId}
      group={group}
      currentSessionId={currentSessionId}
      selectedWorktreeId={selectedWorktreeId}
      onOpenSession={handleSessionClick}
      onCreateWorktreeChat={onCreateWorktreeChat}
      creatingWorktreeSourceSessionId={creatingWorktreeSourceSessionId}
      onRenameWorktree={onRenameWorktree}
      onDeleteWorktree={onDeleteWorktree}
      isDeleting={deletingWorktreeId === group.worktreeId}
      activeSessionStatuses={activeSessionStatuses}
      foregroundSession={foregroundSession}
      folderControls={
        workspaceFolders && isFolderWorkspace(group)
          ? {
              folders: workspaceFolders.folders,
              folderId: getWorkspaceFolderId(workspaceFolders.folders, group.worktreeId),
              disabled: !canEditFolders,
              isDragging: dragItem?.type === 'worktree' && dragItem.id === group.worktreeId,
              onMove: folderId => void moveWorktree(group.worktreeId, folderId),
              onDragStart: event => startDrag(event, { type: 'worktree', id: group.worktreeId }),
              onDragEnd: clearDrag,
            }
          : undefined
      }
    />
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
    <div ref={sidebarRef} className="flex h-full flex-col">
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
        {workspaceFolders && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={newFolderButtonRef}
                type="button"
                aria-label="New folder"
                disabled={!canEditFolders}
                onClick={() => setFolderEditor('new')}
                className="hover:bg-accent focus-visible:ring-ring rounded-md p-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11"
              >
                {workspaceFolders.isSaving ? (
                  <LoaderCircle
                    className="text-muted-foreground size-4 animate-spin"
                    aria-label="Saving folders"
                  />
                ) : (
                  <FolderPlus className="text-muted-foreground size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New folder</TooltipContent>
          </Tooltip>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            aria-label="Search sessions"
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
                  aria-label="Filter sessions"
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
      <div
        className="flex-1 space-y-px overflow-y-auto p-2"
        aria-busy={workspaceFolders?.isSaving || undefined}
      >
        {workspaceFolders?.isLoading && (
          <p role="status" className="text-muted-foreground px-2 py-2 text-xs">
            Loading folders...
          </p>
        )}
        {workspaceFolders?.isError && (
          <div
            role="alert"
            className="text-muted-foreground flex items-center justify-between gap-2 px-2 py-2 text-xs"
          >
            <span>Could not load folders.</span>
            <button
              type="button"
              onClick={() => void workspaceFolders.refresh()}
              className="focus-visible:ring-ring rounded px-2 py-1 underline focus-visible:ring-2"
            >
              Retry
            </button>
          </div>
        )}
        {sessions.length === 0 && liveOnlySessions.length === 0 && folderGroups.length === 0 ? (
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

            {workspaceFolders &&
              folderGroups.map(({ folder, worktrees }, index) => (
                <WorkspaceFolderSection
                  key={folder.id}
                  folder={folder}
                  controller={workspaceFolders}
                  isFirst={index === 0}
                  isLast={index === folderGroups.length - 1}
                  isDragging={dragItem?.type === 'folder' && dragItem.id === folder.id}
                  dropPlacement={
                    dropTarget?.type === 'folder' && dropTarget.id === folder.id
                      ? dragItem?.type === 'worktree'
                        ? 'inside'
                        : dropTarget.placement
                      : null
                  }
                  visibleCount={worktrees.length}
                  onEdit={() => setFolderEditor(folder)}
                  onDelete={() => {
                    void workspaceFolders.deleteFolder(folder.id).then(deleted => {
                      if (deleted) setShouldFocusNewFolder(true);
                    });
                  }}
                  onMove={direction => moveFolder(folder.id, direction)}
                  onDragStart={event => startDrag(event, { type: 'folder', id: folder.id })}
                  onDragEnd={clearDrag}
                  onDragOver={event => dragOver(event, folderTarget(event, folder.id))}
                  onDragLeave={dragLeave}
                  onDrop={event => drop(event, folderTarget(event, folder.id))}
                >
                  {worktrees.map(renderWorktree)}
                </WorkspaceFolderSection>
              ))}
            <div
              role="region"
              aria-label="Ungrouped workspaces"
              data-folder-drop="ungrouped"
              onDragEnter={event => dragOver(event, { type: 'ungrouped' })}
              onDragOver={event => dragOver(event, { type: 'ungrouped' })}
              onDragLeave={dragLeave}
              onDrop={event => drop(event, { type: 'ungrouped' })}
              className={cn(
                'rounded-md',
                folderGroups.length > 0 && 'min-h-16',
                dropTarget?.type === 'ungrouped' && 'bg-accent/50 ring-ring ring-1'
              )}
            >
              {folderGroups.length > 0 && (
                <div className="text-muted-foreground px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wider uppercase">
                  Ungrouped
                </div>
              )}
              {folderGroups.length > 0 && ungrouped.length === 0 && (
                <p className="text-muted-foreground px-3 py-3 text-xs">Drop workspaces here</p>
              )}
              {ungrouped.map((group, groupIdx) => (
                <div key={group.label}>
                  <div
                    className={cn(
                      'text-muted-foreground px-2 pb-1 text-[11px] font-semibold tracking-wider uppercase',
                      groupIdx === 0 && liveOnlySessions.length === 0 ? 'pt-2' : 'pt-4'
                    )}
                  >
                    {group.label}
                  </div>
                  {group.items.map(item =>
                    item.type === 'session' ? renderSession(item.session) : renderWorktree(item)
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {folderEditor !== null && workspaceFolders && (
        <WorkspaceFolderDialog
          key={folderEditor === 'new' ? 'new' : folderEditor.id}
          folder={folderEditor === 'new' ? null : folderEditor}
          isSaving={workspaceFolders.isSaving}
          onSave={values =>
            workspaceFolders.saveFolder(folderEditor === 'new' ? null : folderEditor.id, values)
          }
          onClose={() => {
            setFolderEditor(null);
            if (folderEditor === 'new') {
              setShouldFocusNewFolder(true);
            } else {
              requestAnimationFrame(() => {
                sidebarRef.current
                  ?.querySelector<HTMLButtonElement>(
                    `[data-folder-id="${CSS.escape(folderEditor.id)}"] button`
                  )
                  ?.focus();
              });
            }
          }}
        />
      )}
    </div>
  );
}
