'use client';

import { useState, type DragEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SessionStatusIndicator } from '@/components/shared/SessionStatusIndicator';
import type { WorkspaceFolder } from '@/lib/cloud-agent/workspace-folders';
import type { StackUrgency } from './workspace-stacks';

export type WorktreeFolderControls = {
  folders: WorkspaceFolder[];
  folderId: string | null;
  disabled: boolean;
  isDragging: boolean;
  onMove: (folderId: string | null) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
};

/** What the stack adds to its base row, which doubles as the stack header. */
export type StackBaseRowSlots = {
  leading: ReactNode;
  trailing: ReactNode;
  statusOverride: string | null;
};

export type StackLayerRow = {
  worktreeId: string;
  depth: number;
  row: ReactNode;
};

const urgencyStatus = { attention: 'question', running: 'busy', failed: 'failed', idle: null };

// A depth-1 layer label starts under the base label: row padding, chevron and stack icon.
const FIRST_LAYER_INDENT_PX = 42;
const LAYER_INDENT_STEP_PX = 16;
const MAX_INDENTED_DEPTH = 3;

function layerIndent(depth: number): number {
  const level = Math.min(Math.max(depth, 1), MAX_INDENTED_DEPTH);
  return FIRST_LAYER_INDENT_PX + (level - 1) * LAYER_INDENT_STEP_PX;
}

export function WorkspaceStackGroup({
  worktreeId,
  title,
  urgency,
  renderBase,
  layers,
}: {
  worktreeId: string;
  title: string;
  urgency: StackUrgency;
  renderBase: (slots: StackBaseRowSlots) => ReactNode;
  layers: StackLayerRow[];
}) {
  const [expanded, setExpanded] = useState(true);
  const count = layers.length + 1;
  const status = urgencyStatus[urgency];
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <section aria-label={`Stack ${title}`} data-stack-root-id={worktreeId}>
        {renderBase({
          leading: (
            <>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} stack ${title}`}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative -ml-1 flex shrink-0 items-center rounded-sm before:absolute before:-inset-2 focus-visible:ring-2 focus-visible:outline-none [@media(any-pointer:coarse)]:before:-inset-3"
                >
                  <Chevron className="size-3.5" aria-hidden="true" />
                </button>
              </CollapsibleTrigger>
              <Layers className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            </>
          ),
          trailing: expanded ? null : (
            <>
              {status && (
                // Touch screens hide the row status behind its actions button.
                <span className="hidden [@media(any-pointer:coarse)]:flex [@media(hover:none)]:flex">
                  <SessionStatusIndicator status={status} statusUpdatedAt={null} />
                </span>
              )}
              <span
                className="text-muted-foreground text-xs tabular-nums"
                title={`${count} workspaces in stack`}
              >
                {count}
              </span>
            </>
          ),
          statusOverride: expanded ? null : status,
        })}
        <CollapsibleContent role="list" aria-label={`Layers on ${title}`}>
          {layers.map(layer => (
            <div
              key={layer.worktreeId}
              role="listitem"
              style={{ paddingLeft: layerIndent(layer.depth) }}
            >
              {layer.row}
            </div>
          ))}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
