'use client';

import { useState } from 'react';
import { ChevronRight, ChevronDown, Bot, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { ReactNode } from 'react';
import type { SubtaskPart, StoredMessage, ToolPart, Part } from './types';
import { isMessageStreaming, isToolPart } from './types';
import { MessageErrorBoundary } from './MessageErrorBoundary';

const isDev = process.env.NODE_ENV === 'development';

/**
 * Dev-only debug info that shows on hover
 */
function DevDebugInfo({ messageId, sessionId }: { messageId: string; sessionId: string }) {
  if (!isDev) return null;

  return (
    <span className="group relative ml-1 cursor-help">
      <span className="text-muted-foreground/30 text-[10px]">*</span>
      <span className="bg-popover text-popover-foreground pointer-events-none absolute top-full left-0 z-50 mt-1 hidden rounded border px-2 py-1 font-mono text-[10px] whitespace-nowrap shadow-md group-hover:block">
        msg:{messageId}
        <br />
        sess:{sessionId}
      </span>
    </span>
  );
}

/**
 * Maximum nesting depth for child sessions to prevent infinite recursion.
 */
const MAX_NESTING_DEPTH = 5;

/** Render function for a single part, injected to avoid circular imports */
export type RenderPartFn = (props: {
  part: Part;
  isStreaming?: boolean;
  childSessionMessages?: Map<string, StoredMessage[]>;
  getChildMessages?: (sessionId: string) => StoredMessage[];
}) => ReactNode;

type ChildSessionSectionProps = {
  subtaskPart?: SubtaskPart;
  /** For task tool parts, the tool part itself */
  taskToolPart?: ToolPart;
  /** Child session ID from the task tool's metadata */
  sessionId?: string;
  /** Messages for this child session */
  childMessages?: StoredMessage[];
  /** Current nesting depth (for recursive rendering) */
  depth?: number;
  /** Callback when section is expanded (for lazy loading) */
  onExpand?: () => void;
  /** Function to get messages for a child session ID (for nested sessions) */
  getChildMessages?: (sessionId: string) => StoredMessage[];
  /** Render function for individual parts (injected to avoid circular dependency) */
  renderPart: RenderPartFn;
};

/**
 * ChildSessionSection - Collapsible component for rendering child sessions (subtasks).
 *
 * Displays subtask/task information with expand/collapse functionality.
 * Renders child session messages inline when expanded.
 * Supports nested child sessions with recursive rendering.
 */
export function ChildSessionSection({
  subtaskPart,
  taskToolPart,
  sessionId,
  childMessages = [],
  depth = 0,
  onExpand,
  getChildMessages,
  renderPart,
}: ChildSessionSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const handleToggle = () => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    if (newExpanded && onExpand) {
      onExpand();
    }
  };

  // Determine display info from either subtaskPart or taskToolPart
  const description = subtaskPart?.description || getTaskDescription(taskToolPart);
  const agent = subtaskPart?.agent || getTaskAgent(taskToolPart);
  const taskStatus = taskToolPart?.state?.status;
  const isRunning = taskStatus === 'running' || taskStatus === 'pending';

  // Get current running tool info when task is in progress
  const currentTool = isRunning ? getCurrentRunningTool(childMessages) : undefined;

  // Border color based on status
  const borderColor =
    taskStatus === 'error'
      ? 'border-red-500/40'
      : taskStatus === 'completed'
        ? 'border-green-500/40'
        : 'border-blue-500/40';

  return (
    <div className={`bg-muted/20 my-2 rounded-r-md border-l-2 ${borderColor}`}>
      {/* Header - always visible */}
      <Button
        variant="ghost"
        onClick={handleToggle}
        className="hover:bg-muted/50 h-auto w-full justify-start gap-2 px-3 py-2"
      >
        {/* Expand/Collapse Icon */}
        {isExpanded ? (
          <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
        )}

        {/* Agent Icon with loading indicator */}
        {isRunning ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
        ) : (
          <Bot className="h-4 w-4 shrink-0 text-blue-500" />
        )}

        {/* Description and current tool */}
        <span className="flex-1 truncate text-left text-sm font-medium">
          {description || 'Subtask'}
          {currentTool && (
            <span className="text-muted-foreground ml-2 font-normal">
              <span className="text-blue-500">{currentTool.tool}</span>
              {currentTool.context && (
                <span className="ml-1 opacity-70">{currentTool.context}</span>
              )}
            </span>
          )}
        </span>

        {/* Status Badge */}
        {taskStatus && (
          <Badge
            variant={
              taskStatus === 'completed'
                ? 'default'
                : taskStatus === 'error'
                  ? 'destructive'
                  : 'outline'
            }
            className="shrink-0 text-xs"
          >
            {taskStatus}
          </Badge>
        )}

        {/* Agent Badge */}
        {agent && (
          <Badge variant="outline" className="shrink-0 text-xs">
            {agent}
          </Badge>
        )}
      </Button>

      {/* Expanded Content - just show child session events */}
      {isExpanded && (
        <div className="space-y-2 px-4 pt-1 pb-3">
          {childMessages.length > 0 ? (
            depth < MAX_NESTING_DEPTH ? (
              childMessages.map(msg => (
                <MessageErrorBoundary key={msg.info.id}>
                  <ChildSessionMessage
                    message={msg}
                    depth={depth}
                    getChildMessages={getChildMessages}
                    renderPart={renderPart}
                  />
                </MessageErrorBoundary>
              ))
            ) : (
              <div className="text-muted-foreground text-xs italic">
                Maximum nesting depth reached. Unable to display nested sessions.
              </div>
            )
          ) : sessionId ? (
            <div className="text-muted-foreground text-xs italic">
              {isRunning ? 'Waiting for child session messages...' : 'No messages in child session'}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Renders a single message from a child session.
 * Handles recursive rendering of nested task tool parts.
 */
function ChildSessionMessage({
  message,
  depth,
  getChildMessages,
  renderPart,
}: {
  message: StoredMessage;
  depth: number;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  renderPart: RenderPartFn;
}) {
  const isStreaming = isMessageStreaming(message);

  return (
    <div className="bg-muted/30 rounded-md p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className="text-xs">
          {message.info.role}
        </Badge>
        {isStreaming && (
          <span className="text-muted-foreground animate-pulse text-xs">streaming...</span>
        )}
        <DevDebugInfo messageId={message.info.id} sessionId={message.info.sessionID} />
      </div>
      <div className="mt-2 space-y-1">
        {message.parts.map((part, index) => {
          // Check for nested task tools
          if (isToolPart(part) && part.tool === 'task') {
            const nestedSessionId = getTaskToolSessionId(part);
            const nestedChildMessages = nestedSessionId ? getChildMessages?.(nestedSessionId) : [];

            return (
              <ChildSessionSection
                key={part.id || index}
                taskToolPart={part}
                sessionId={nestedSessionId}
                childMessages={nestedChildMessages || []}
                depth={depth + 1}
                getChildMessages={getChildMessages}
                renderPart={renderPart}
              />
            );
          }

          return (
            <MessageErrorBoundary key={part.id || index}>
              {renderPart({ part, isStreaming })}
            </MessageErrorBoundary>
          );
        })}
      </div>
    </div>
  );
}

// Helper functions to extract info from task tool parts
// These use runtime type checks instead of unsafe 'as' casts

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringProperty(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function getTaskDescription(toolPart?: ToolPart): string | undefined {
  if (!toolPart || toolPart.tool !== 'task') return undefined;
  const input = toolPart.state?.input;
  return getStringProperty(input, 'description');
}

function getTaskAgent(toolPart?: ToolPart): string | undefined {
  if (!toolPart || toolPart.tool !== 'task') return undefined;
  const input = toolPart.state?.input;
  return getStringProperty(input, 'subagent_type');
}

/**
 * Extract the child session ID from a task tool part.
 * The session ID is stored in state.metadata.sessionId.
 */
export function getTaskToolSessionId(toolPart: ToolPart): string | undefined {
  if (toolPart.tool !== 'task') return undefined;
  const state = toolPart.state;
  if (state.status === 'running' || state.status === 'completed') {
    const metadata = state.metadata;
    return getStringProperty(metadata, 'sessionId');
  }
  return undefined;
}

/**
 * Find the currently running tool from child session messages.
 * Looks through all assistant messages to find a tool part with status 'running' or 'pending'.
 * Returns the tool name and optional context (e.g., filename for read/edit tools).
 */
export function getCurrentRunningTool(
  childMessages: StoredMessage[]
): { tool: string; context?: string } | undefined {
  // Search messages in reverse order (most recent first)
  for (let i = childMessages.length - 1; i >= 0; i--) {
    const msg = childMessages[i];
    if (msg.info.role !== 'assistant') continue;

    // Search parts in reverse order
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j];
      if (!isToolPart(part)) continue;

      const status = part.state.status;
      if (status === 'running' || status === 'pending') {
        const tool = part.tool;
        let context: string | undefined;

        // Extract context based on tool type
        const input = part.state.input;
        if (tool === 'read' || tool === 'edit' || tool === 'write') {
          const filePath = getStringProperty(input, 'filePath');
          if (filePath) {
            // Extract just the filename
            context = filePath.split('/').pop();
          }
        } else if (tool === 'bash') {
          const command = getStringProperty(input, 'command');
          if (command) {
            // Show first part of command (truncated)
            const firstWord = command.split(/\s+/)[0];
            context = firstWord.length > 20 ? firstWord.slice(0, 20) + '...' : firstWord;
          }
        } else if (tool === 'glob' || tool === 'grep') {
          const pattern = getStringProperty(input, 'pattern');
          if (pattern) {
            context = pattern.length > 25 ? pattern.slice(0, 25) + '...' : pattern;
          }
        } else if (tool === 'task') {
          const description = getStringProperty(input, 'description');
          if (description) {
            context = description.length > 30 ? description.slice(0, 30) + '...' : description;
          }
        }

        return { tool, context };
      }
    }
  }
  return undefined;
}
