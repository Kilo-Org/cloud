'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolExecutionCard } from './ToolExecutionCard';
import { ReadToolCard } from './ReadToolCard';
import { EditToolCard } from './EditToolCard';
import { WriteToolCard } from './WriteToolCard';
import { BashToolCard } from './BashToolCard';
import { GlobToolCard } from './GlobToolCard';
import { GrepToolCard } from './GrepToolCard';
import { WebSearchToolCard } from './WebSearchToolCard';
import { ListToolCard } from './ListToolCard';
import { McpToolCard } from './McpToolCard';
import { TodoReadToolCard } from './TodoReadToolCard';
import { TodoWriteToolCard } from './TodoWriteToolCard';
import { QuestionToolCard } from './QuestionToolCard';
import { ChildSessionSection, getTaskToolSessionId } from './ChildSessionSection';
import type { RenderPartFn } from './ChildSessionSection';
import type { ReactNode } from 'react';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import type { Part, ToolExecution, StoredMessage } from './types';
import {
  isTextPart,
  isToolPart,
  isFilePart,
  isReasoningPart,
  isStepStartPart,
  isStepFinishPart,
  isSubtaskPart,
  isPatchPart,
  isPartStreaming,
} from './types';

// ============================================================================
// Types
// ============================================================================

export interface PartRendererProps {
  part: Part;
  isStreaming?: boolean;
  /** Messages for child sessions (task tools) - keyed by session ID */
  childSessionMessages?: Map<string, StoredMessage[]>;
  /** Function to get messages for a child session ID (for nested sessions) */
  getChildMessages?: (sessionId: string) => StoredMessage[];
}

// ============================================================================
// Shared Components
// ============================================================================

function LinkRenderer({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

const markdownComponents = { a: LinkRenderer };

// ============================================================================
// Part Renderers
// ============================================================================

/**
 * Renders a TextPart as markdown
 */
function TextPartRenderer({
  part,
  isStreaming,
}: {
  part: Extract<Part, { type: 'text' }>;
  isStreaming?: boolean;
}) {
  const streaming = isStreaming ?? isPartStreaming(part);

  return (
    <div
      className={cn(
        'prose prose-sm prose-invert max-w-none overflow-hidden',
        streaming && 'animate-pulse'
      )}
    >
      {part.text ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {part.text}
        </ReactMarkdown>
      ) : streaming ? (
        'Thinking...'
      ) : null}
    </div>
  );
}

/**
 * Check if a tool part has enough input data to render.
 * During streaming, parts may arrive with incomplete input.
 * Returns true if the tool can be rendered, false if we should show a loading state.
 */
function hasRequiredInput(part: Extract<Part, { type: 'tool' }>): boolean {
  const input = part.state.input;
  if (!input || typeof input !== 'object') return false;

  // Check required fields based on tool type
  switch (part.tool) {
    case 'read':
    case 'edit':
    case 'write':
      return typeof input.filePath === 'string' && input.filePath.length > 0;
    case 'bash':
      return typeof input.command === 'string' && input.command.length > 0;
    case 'glob':
    case 'grep':
      return typeof input.pattern === 'string' && input.pattern.length > 0;
    case 'websearch':
      return typeof input.query === 'string' && input.query.length > 0;
    case 'list':
      return typeof input.path === 'string' && input.path.length > 0;
    case 'mcp':
      return (
        typeof input.server_name === 'string' &&
        input.server_name.length > 0 &&
        typeof input.tool_name === 'string' &&
        input.tool_name.length > 0
      );
    case 'task':
    case 'todoread':
    case 'todowrite':
    case 'question':
      // These tools can render without specific input or handle empty arrays gracefully
      return true;
    default:
      // For unknown tools, assume they can render if they have any input
      return Object.keys(input).length > 0;
  }
}

/**
 * Renders a placeholder while tool input is still streaming.
 */
function StreamingToolPlaceholder({ toolName }: { toolName: string }) {
  return (
    <div className="border-muted bg-muted/30 flex items-center gap-2 rounded-md border px-3 py-2">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
      <span className="text-muted-foreground text-sm">
        {toolName}
        <span className="animate-pulse">...</span>
      </span>
    </div>
  );
}

/**
 * Adapter that delegates to the exported PartRenderer component,
 * used as a callback prop in ChildSessionSection to break the circular dependency.
 */
const renderPartFn: RenderPartFn = props => <PartRenderer {...props} />;

/**
 * Renders a ToolPart using ToolExecutionCard
 * Converts V2 ToolPart format to V1 ToolExecution format for compatibility
 * Special handling for task tools to render as ChildSessionSection
 */
function ToolPartRenderer({
  part,
  childSessionMessages,
  getChildMessages,
}: {
  part: Extract<Part, { type: 'tool' }>;
  childSessionMessages?: Map<string, StoredMessage[]>;
  getChildMessages?: (sessionId: string) => StoredMessage[];
}) {
  // Check if tool input is still streaming (incomplete data)
  if (!hasRequiredInput(part)) {
    return <StreamingToolPlaceholder toolName={part.tool} />;
  }

  // Special handling for task tools - render as child session
  if (part.tool === 'task') {
    const sessionId = getTaskToolSessionId(part);
    const childMessages = sessionId
      ? childSessionMessages?.get(sessionId) || getChildMessages?.(sessionId) || []
      : [];

    return (
      <ChildSessionSection
        taskToolPart={part}
        sessionId={sessionId}
        childMessages={childMessages}
        getChildMessages={getChildMessages}
        renderPart={renderPartFn}
      />
    );
  }

  // Special handling for read tool - compact display
  if (part.tool === 'read') {
    return <ReadToolCard toolPart={part} />;
  }

  // Special handling for edit tool - compact display
  if (part.tool === 'edit') {
    return <EditToolCard toolPart={part} />;
  }

  // Special handling for write tool - compact display
  if (part.tool === 'write') {
    return <WriteToolCard toolPart={part} />;
  }

  // Special handling for bash tool - compact display
  if (part.tool === 'bash') {
    return <BashToolCard toolPart={part} />;
  }

  // Special handling for glob tool - compact display
  if (part.tool === 'glob') {
    return <GlobToolCard toolPart={part} />;
  }

  // Special handling for grep tool - compact display
  if (part.tool === 'grep') {
    return <GrepToolCard toolPart={part} />;
  }

  // Special handling for websearch tool - compact display
  if (part.tool === 'websearch') {
    return <WebSearchToolCard toolPart={part} />;
  }

  // Special handling for list tool - compact display
  if (part.tool === 'list') {
    return <ListToolCard toolPart={part} />;
  }

  // Special handling for mcp tool - compact display
  if (part.tool === 'mcp') {
    return <McpToolCard toolPart={part} />;
  }

  // Special handling for todoread tool - compact display
  if (part.tool === 'todoread') {
    return <TodoReadToolCard toolPart={part} />;
  }

  // Special handling for todowrite tool - compact display
  if (part.tool === 'todowrite') {
    return <TodoWriteToolCard toolPart={part} />;
  }

  // Special handling for question tool - compact display with tabs
  if (part.tool === 'question') {
    return <QuestionToolCard toolPart={part} />;
  }

  // Convert ToolPart to ToolExecution format for other tools
  const execution: ToolExecution = {
    toolName: part.tool,
    input: part.state.input,
    output: part.state.status === 'completed' ? part.state.output : undefined,
    error: part.state.status === 'error' ? part.state.error : undefined,
    timestamp: new Date().toISOString(),
  };

  return <ToolExecutionCard execution={execution} />;
}

/**
 * Renders a FilePart
 * For images, renders an img tag
 * For other files, renders a download link
 * Handles stripped file parts (where url is empty) gracefully
 */
function FilePartRenderer({ part }: { part: Extract<Part, { type: 'file' }> }) {
  const isImage = part.mime.startsWith('image/');
  const hasUrl = part.url && part.url.length > 0;

  // Handle stripped file parts (content not stored in memory/IndexedDB)
  if (!hasUrl) {
    const label = isImage ? 'Image' : 'File';
    const displayName = part.filename || `${label} attachment`;
    return (
      <div className="bg-muted/30 border-muted my-2 flex items-center gap-2 rounded-md border px-3 py-2">
        <span className="text-muted-foreground text-sm">{displayName}</span>
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="my-2">
        <img
          src={part.url}
          alt={part.filename || 'Image attachment'}
          className="max-h-96 max-w-full rounded-md object-contain"
        />
        {part.filename && <div className="text-muted-foreground mt-1 text-xs">{part.filename}</div>}
      </div>
    );
  }

  // Non-image file attachment
  return (
    <div className="bg-muted/30 border-muted my-2 flex items-center gap-2 rounded-md border px-3 py-2">
      <span className="text-sm">{part.filename || 'File attachment'}</span>
      <a
        href={part.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary text-xs hover:underline"
      >
        Download
      </a>
      <span className="text-muted-foreground text-xs">({part.mime})</span>
    </div>
  );
}

/**
 * Renders a ReasoningPart as a collapsible details/summary element
 */
function ReasoningPartRenderer({
  part,
  isStreaming,
}: {
  part: Extract<Part, { type: 'reasoning' }>;
  isStreaming?: boolean;
}) {
  const streaming = isStreaming ?? isPartStreaming(part);

  return (
    <details className="bg-muted/20 border-muted/50 my-2 rounded-md border">
      <summary className="text-muted-foreground flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
        <ChevronDown className="h-4 w-4 transition-transform [[open]>&]:rotate-180" />
        <span>
          Reasoning
          {streaming && <span className="ml-2 animate-pulse text-xs">(thinking...)</span>}
        </span>
      </summary>
      <div className="border-muted/50 border-t px-3 py-2">
        <div
          className={cn(
            'prose prose-sm prose-invert max-w-none overflow-hidden',
            streaming && 'animate-pulse'
          )}
        >
          {part.text ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {part.text}
            </ReactMarkdown>
          ) : streaming ? (
            <span className="text-muted-foreground text-sm italic">Thinking...</span>
          ) : null}
        </div>
      </div>
    </details>
  );
}

/**
 * Renders a SubtaskPart - placeholder for child session indicator
 */
function SubtaskPartRenderer({ part }: { part: Extract<Part, { type: 'subtask' }> }) {
  return (
    <div className="bg-muted/30 border-muted my-2 rounded-md border px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="bg-primary/20 text-primary rounded px-2 py-0.5 text-xs font-medium">
          Subtask
        </div>
        <span className="text-sm font-medium">{part.agent}</span>
      </div>
      {part.description && <p className="text-muted-foreground mt-1 text-sm">{part.description}</p>}
      {part.prompt && (
        <div className="text-muted-foreground border-muted/50 mt-2 border-t pt-2 text-xs">
          <span className="font-medium">Prompt: </span>
          {part.prompt.length > 100 ? `${part.prompt.slice(0, 100)}...` : part.prompt}
        </div>
      )}
    </div>
  );
}

/**
 * PatchPart is internal bookkeeping for file change tracking and revert functionality.
 * It has no visual representation - file modifications are shown through tool parts (edit, write, etc).
 */
function PatchPartRenderer(_props: { part: Extract<Part, { type: 'patch' }> }) {
  return null;
}

/**
 * Renders unknown part types with a graceful fallback
 */
function UnknownPartRenderer({ part }: { part: Part }) {
  return (
    <div className="bg-muted/20 border-muted/50 my-2 rounded-md border px-3 py-2">
      <div className="text-muted-foreground text-xs">
        Unknown part type: {(part as { type: string }).type}
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Error fallback for individual parts
 */
function PartErrorFallback({ partType }: { partType: string }) {
  return (
    <div className="bg-destructive/10 border-destructive/50 text-destructive my-2 rounded-md border p-2">
      <p className="text-xs">Failed to render {partType} part</p>
    </div>
  );
}

/**
 * PartRenderer - Routes V2 message parts to appropriate renderers
 *
 * Handles different part types from V2 messages:
 * - text: Markdown text rendered with ReactMarkdown
 * - tool: Tool executions rendered with ToolExecutionCard (task tools render as ChildSessionSection)
 * - file: File/image attachments
 * - reasoning: Collapsible reasoning display
 * - step-start/step-finish: Return null (no visible rendering)
 * - subtask: Child session indicator
 * - patch: Shows files modified in a patch/commit
 * - unknown: Graceful fallback
 *
 * Wrapped with error boundary to prevent individual part rendering errors
 * from crashing the entire message list.
 */
export function PartRenderer({
  part,
  isStreaming,
  childSessionMessages,
  getChildMessages,
}: PartRendererProps) {
  // Text parts -> render markdown
  if (isTextPart(part)) {
    return (
      <MessageErrorBoundary fallback={<PartErrorFallback partType="text" />}>
        <TextPartRenderer part={part} isStreaming={isStreaming} />
      </MessageErrorBoundary>
    );
  }

  // Tool parts -> render using ToolExecutionCard (or ChildSessionSection for task tools)
  if (isToolPart(part)) {
    return (
      <MessageErrorBoundary fallback={<PartErrorFallback partType="tool" />}>
        <ToolPartRenderer
          part={part}
          childSessionMessages={childSessionMessages}
          getChildMessages={getChildMessages}
        />
      </MessageErrorBoundary>
    );
  }

  // File parts -> render file/image attachments
  if (isFilePart(part)) {
    return (
      <MessageErrorBoundary fallback={<PartErrorFallback partType="file" />}>
        <FilePartRenderer part={part} />
      </MessageErrorBoundary>
    );
  }

  // Reasoning parts -> collapsible reasoning display
  if (isReasoningPart(part)) {
    return (
      <MessageErrorBoundary fallback={<PartErrorFallback partType="reasoning" />}>
        <ReasoningPartRenderer part={part} isStreaming={isStreaming} />
      </MessageErrorBoundary>
    );
  }

  // Step start/finish -> return null (no visible rendering)
  if (isStepStartPart(part) || isStepFinishPart(part)) {
    return null;
  }

  // Subtask parts -> render child session indicator
  if (isSubtaskPart(part)) {
    return (
      <MessageErrorBoundary fallback={<PartErrorFallback partType="subtask" />}>
        <SubtaskPartRenderer part={part} />
      </MessageErrorBoundary>
    );
  }

  // Patch parts -> render patch/commit info
  if (isPatchPart(part)) {
    return (
      <MessageErrorBoundary fallback={<PartErrorFallback partType="patch" />}>
        <PatchPartRenderer part={part} />
      </MessageErrorBoundary>
    );
  }

  // Unknown types -> graceful fallback
  return <UnknownPartRenderer part={part} />;
}
