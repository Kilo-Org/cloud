'use client';

import { useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown, Bot, CornerDownRight } from 'lucide-react';
import { StatusSpinner } from '@/components/shared/StatusSpinner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';
import type { SubtaskPart, StoredMessage, ToolPart, Part } from './types';
import { isMessageStreaming, isToolPart } from './types';
import { MessageErrorBoundary } from './MessageErrorBoundary';

const MAX_NESTING_DEPTH = 5;

export type ChildSessionDrawerEntry = {
  sessionId: KiloSessionId;
  description?: string;
  agent?: string;
};

export type OpenChildSession = (entry: ChildSessionDrawerEntry) => void;

export type RenderPartFn = (props: {
  part: Part;
  isStreaming?: boolean;
  childSessionMessages?: Map<string, StoredMessage[]>;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
}) => ReactNode;

type ChildSessionSectionProps = {
  subtaskPart?: SubtaskPart;
  taskToolPart?: ToolPart;
  sessionId?: KiloSessionId;
  childMessages?: StoredMessage[];
  depth?: number;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  renderPart?: RenderPartFn;
  onOpenChildSession?: OpenChildSession;
};

export function ChildSessionSection({
  subtaskPart,
  taskToolPart,
  sessionId,
  childMessages = [],
  depth = 0,
  getChildMessages,
  renderPart,
  onOpenChildSession,
}: ChildSessionSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const description = subtaskPart?.description || getTaskDescription(taskToolPart);
  const agent = subtaskPart?.agent || getTaskAgent(taskToolPart);
  const taskStatus = taskToolPart?.state?.status;
  const isCompleted = taskStatus === 'completed';
  const isRunning = taskStatus === 'running' || taskStatus === 'pending';
  const latestTool = isRunning ? getLatestToolActivity(childMessages) : undefined;
  const agentLabel = agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : undefined;
  const progress = latestTool ?? (taskStatus === 'pending' ? 'Delegating...' : 'Working...');
  const statusLabel =
    taskStatus === 'completed' ? 'Completed' : taskStatus === 'error' ? 'Failed' : undefined;
  const toolCount = childMessages.reduce(
    (total, message) => total + message.parts.filter(isToolPart).length,
    0
  );
  const canOpenDrawer = Boolean(sessionId && onOpenChildSession);
  const inlineRenderPart = sessionId && !canOpenDrawer ? renderPart : undefined;
  const canExpandInline = Boolean(inlineRenderPart);
  const isInteractive = canOpenDrawer || canExpandInline;

  const handleOpen = () => {
    if (!sessionId) return;
    if (onOpenChildSession) {
      onOpenChildSession({ sessionId, description, agent });
      return;
    }
    if (inlineRenderPart) {
      setIsExpanded(expanded => !expanded);
    }
  };

  const summary = (statusLabel || toolCount > 0) && (
    <span className="flex shrink-0 items-center gap-2 font-normal whitespace-nowrap">
      {statusLabel && (
        <span className={taskStatus === 'error' ? 'text-destructive' : undefined}>
          {statusLabel}
        </span>
      )}
      {statusLabel && toolCount > 0 && <span aria-hidden="true">·</span>}
      {toolCount > 0 && (
        <span className="tabular-nums">
          {toolCount} {toolCount === 1 ? 'tool call' : 'tool calls'}
        </span>
      )}
    </span>
  );

  const rowContent = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {isRunning ? (
          <StatusSpinner
            className="size-4 shrink-0 motion-reduce:[&_rect]:animate-none!"
            title={taskStatus === 'pending' ? 'Delegating' : 'Working'}
          />
        ) : (
          <Bot className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-x-2 gap-y-1',
            !isCompleted && 'flex-wrap'
          )}
        >
          <span
            className={cn('min-w-0 font-normal', isCompleted ? 'truncate' : 'wrap-anywhere')}
            title={description}
          >
            {description || 'Subagent task'}
          </span>
          {agentLabel && (
            <Badge
              variant="outline"
              className={cn(
                'px-1.5 py-0 text-xs font-normal',
                isCompleted ? 'max-w-[45%] shrink-0' : 'max-w-full'
              )}
            >
              <span className="truncate" title={agentLabel}>
                {agentLabel}
              </span>
            </Badge>
          )}
        </span>
        {isCompleted && summary}
        {isInteractive &&
          (canExpandInline && isExpanded ? (
            <ChevronDown className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
          ))}
      </span>
      {!isCompleted && (isRunning || statusLabel || toolCount > 0) && (
        <span className="text-muted-foreground ml-6 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-normal">
          {isRunning && (
            <span className="flex min-w-0 items-center gap-2">
              {latestTool && <CornerDownRight className="size-4 shrink-0" aria-hidden="true" />}
              <span className="truncate" title={progress}>
                {progress}
              </span>
            </span>
          )}
          {summary}
        </span>
      )}
    </>
  );

  return (
    <div className="text-muted-foreground min-w-0 py-1 text-xs">
      {isInteractive ? (
        <Button
          variant="ghost"
          size={null}
          onClick={handleOpen}
          aria-busy={isRunning || undefined}
          aria-haspopup={canOpenDrawer ? 'dialog' : undefined}
          aria-expanded={canExpandInline ? isExpanded : undefined}
          className="hover:bg-muted/40 h-auto min-h-8 w-full flex-col items-stretch justify-center gap-1 px-2 py-2 text-left text-xs whitespace-normal pointer-coarse:min-h-11"
        >
          {rowContent}
        </Button>
      ) : (
        <div
          aria-busy={isRunning || undefined}
          className="flex min-h-8 w-full flex-col justify-center gap-1 px-2 py-2 pointer-coarse:min-h-11"
        >
          {rowContent}
        </div>
      )}

      {isExpanded && inlineRenderPart && (
        <div className="space-y-2 px-4 pt-1 pb-3">
          {childMessages.length > 0 ? (
            depth < MAX_NESTING_DEPTH ? (
              childMessages.map(message => (
                <MessageErrorBoundary key={message.info.id}>
                  <ChildSessionMessage
                    message={message}
                    depth={depth}
                    getChildMessages={getChildMessages}
                    renderPart={inlineRenderPart}
                  />
                </MessageErrorBoundary>
              ))
            ) : (
              <div className="text-muted-foreground text-xs italic">
                Maximum nesting depth reached. Unable to display nested sessions.
              </div>
            )
          ) : (
            <div className="text-muted-foreground text-xs italic">
              {isRunning ? 'Waiting for child session messages...' : 'No messages in child session'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
      </div>
      <div className="mt-2 space-y-1">
        {message.parts.map((part, index) => {
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
              {renderPart({ part, isStreaming, getChildMessages })}
            </MessageErrorBoundary>
          );
        })}
      </div>
    </div>
  );
}

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

function isKiloSessionId(sessionId: string | undefined): sessionId is KiloSessionId {
  return sessionId !== undefined && sessionId.startsWith('ses_') && sessionId.length === 30;
}

/**
 * Extract the child session ID from a task tool part.
 * The session ID is stored in state.metadata.sessionId.
 */
export function getTaskToolSessionId(toolPart: ToolPart): KiloSessionId | undefined {
  if (toolPart.tool !== 'task') return undefined;
  const state = toolPart.state;
  if (state.status === 'running' || state.status === 'completed') {
    const metadata = state.metadata;
    const sessionId = getStringProperty(metadata, 'sessionId');
    return isKiloSessionId(sessionId) ? sessionId : undefined;
  }
  return undefined;
}

function getLatestToolActivity(childMessages: StoredMessage[]): string | undefined {
  for (let i = childMessages.length - 1; i >= 0; i--) {
    const msg = childMessages[i];
    if (msg.info.role !== 'assistant') continue;

    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j];
      if (!isToolPart(part)) continue;

      const tool = part.tool;
      let context: string | undefined;
      const input = part.state.input;
      if (tool === 'read' || tool === 'edit' || tool === 'write') {
        const filePath = getStringProperty(input, 'filePath');
        if (filePath) context = filePath.split('/').pop();
      } else if (tool === 'bash') {
        const command = getStringProperty(input, 'command');
        if (command) {
          const firstWord = command.split(/\s+/)[0];
          context = firstWord.length > 20 ? firstWord.slice(0, 20) + '...' : firstWord;
        }
      } else if (tool === 'glob' || tool === 'grep') {
        const pattern = getStringProperty(input, 'pattern');
        if (pattern) context = pattern.length > 25 ? pattern.slice(0, 25) + '...' : pattern;
      } else if (tool === 'task') {
        const taskDescription = getStringProperty(input, 'description');
        if (taskDescription) {
          context =
            taskDescription.length > 30 ? taskDescription.slice(0, 30) + '...' : taskDescription;
        }
      }

      const label = tool === 'bash' ? 'Shell' : tool.charAt(0).toUpperCase() + tool.slice(1);
      return `${label}${context ? ` ${context}` : ''}${part.state.status === 'error' ? ' (failed)' : ''}`;
    }
  }
  return undefined;
}
