'use client';

import type { DragEventHandler, ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Palette,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { WorkspaceFolder } from '@/lib/cloud-agent/workspace-folders';
import { workspaceFolderColorSchema } from '@/lib/cloud-agent/workspace-folders';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { WorkspaceFolderController } from './hooks/useWorkspaceFolders';
import { getWorkspaceFolderColor, workspaceFolderColors } from './workspace-folders';

export function WorkspaceFolderSection({
  folder,
  controller,
  isFirst,
  isLast,
  isDragging,
  dropPlacement,
  visibleCount,
  onEdit,
  onDelete,
  onMove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: {
  folder: WorkspaceFolder;
  controller: WorkspaceFolderController;
  isFirst: boolean;
  isLast: boolean;
  isDragging: boolean;
  dropPlacement: 'inside' | 'before' | 'after' | null;
  visibleCount: number;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (direction: 'up' | 'down') => void;
  onDragStart: DragEventHandler<HTMLDivElement>;
  onDragEnd: DragEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
  children: ReactNode;
}) {
  const collapsed = controller.collapsedFolderIds.includes(folder.id);
  const disabled = controller.isSaving || controller.isError;
  const color = getWorkspaceFolderColor(folder.color);

  return (
    <section
      aria-label={`Folder ${folder.name}`}
      data-folder-id={folder.id}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'relative mb-2 rounded-md',
        isDragging && 'opacity-50',
        dropPlacement === 'inside' && 'bg-accent/50 ring-ring ring-1',
        dropPlacement === 'before' &&
          'before:bg-primary before:absolute before:inset-x-0 before:-top-0.5 before:h-0.5 before:rounded-full',
        dropPlacement === 'after' &&
          'after:bg-primary after:absolute after:inset-x-0 after:-bottom-0.5 after:h-0.5 after:rounded-full'
      )}
    >
      <div
        draggable={!disabled}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="group/folder hover:bg-accent flex items-center gap-1 rounded-md pr-1 transition-colors"
      >
        <button
          type="button"
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} folder ${folder.name}`}
          aria-expanded={!collapsed}
          onClick={() => controller.toggleFolder(folder.id)}
          className="focus-visible:ring-ring flex min-h-9 min-w-0 flex-1 cursor-grab items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing [@media(any-pointer:coarse)]:min-h-11"
        >
          {collapsed ? (
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <Folder aria-hidden="true" className="size-4 shrink-0" style={{ color }} />
          <span className="min-w-0 flex-1 truncate font-medium" title={folder.name}>
            {folder.name}
          </span>
          <span
            className="text-muted-foreground text-xs tabular-nums"
            title={`${visibleCount} of ${folder.worktreeIds.length} workspaces shown`}
          >
            {folder.worktreeIds.length}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Folder actions for ${folder.name}`}
              aria-busy={controller.isSaving || undefined}
              onDragStart={event => {
                event.preventDefault();
                event.stopPropagation();
              }}
              className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 [@media(any-pointer:coarse)]:size-11"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={disabled} onSelect={onEdit}>
              <Pencil className="size-4" />
              Rename folder
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={disabled} className="gap-2">
                <Palette className="text-muted-foreground size-4" />
                Color
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto">
                <DropdownMenuRadioGroup
                  value={folder.color}
                  onValueChange={value => {
                    const parsed = workspaceFolderColorSchema.safeParse(value);
                    if (parsed.success) void controller.setFolderColor(folder.id, parsed.data);
                  }}
                >
                  {workspaceFolderColors.map(option => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                      disabled={disabled}
                    >
                      <span
                        aria-hidden="true"
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: option.css }}
                      />
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={disabled || isFirst} onSelect={() => onMove('up')}>
              <ArrowUp className="size-4" />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled || isLast} onSelect={() => onMove('down')}>
              <ArrowDown className="size-4" />
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={disabled} onSelect={onDelete}>
              <Trash2 className="size-4" />
              Delete folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!collapsed && (
        <div className="ml-3.5 pl-1">
          {visibleCount > 0 ? (
            children
          ) : (
            <p className="text-muted-foreground px-3 py-3 text-xs">
              {folder.worktreeIds.length > 0 ? 'No matching workspaces' : 'Drop workspaces here'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
