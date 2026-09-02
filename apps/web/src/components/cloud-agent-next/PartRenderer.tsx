'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, Loader2 } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { ReadToolCard } from './ReadToolCard';
import { EditToolCard } from './EditToolCard';
import { WriteToolCard } from './WriteToolCard';
import { BashToolCard } from './BashToolCard';
import { BackgroundProcessToolCard } from './BackgroundProcessToolCard';
import { ApplyPatchToolCard } from './ApplyPatchToolCard';
import { WebFetchToolCard } from './WebFetchToolCard';
import { ToolErrorCard } from './ToolErrorCard';
import { ToolMarkdown } from './ToolOutput';
import { shouldRenderToolPart } from './message-presentation';
import { getReasoningHeader, getReasoningPresentation } from './reasoning-presentation';
import { GlobToolCard } from './GlobToolCard';
import { GrepToolCard } from './GrepToolCard';
import { WebSearchToolCard } from './WebSearchToolCard';
import { ListToolCard } from './ListToolCard';
import { GenericToolCard } from './GenericToolCard';
import { TodoWriteToolCard } from './TodoWriteToolCard';
import { QuestionToolStatus } from './QuestionToolStatus';
import { SuggestToolCard } from './SuggestToolCard';
import { SkillToolCard } from './SkillToolCard';
import { ChildSessionSection, getTaskToolSessionId } from './ChildSessionSection';
import type { OpenChildSession, RenderPartFn } from './ChildSessionSection';
import type { ReactNode } from 'react';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import { toSafeHttpUrl, toSafeImageSrc } from '@/lib/safe-http-url';
import type { Part, StoredMessage } from './types';
import {
  isTextPart,
  isToolPart,
  isFilePart,
  isReasoningPart,
  shouldRenderReasoningPart,
  isStepStartPart,
  isStepFinishPart,
  isSubtaskPart,
  isPatchPart,
  isPartStreaming,
} from './types';

// ============================================================================
// Types
// ============================================================================

export type PartRendererProps = {
  part: Part;
  isStreaming?: boolean;
  /** Messages for child sessions (task tools) - keyed by session ID */
  childSessionMessages?: Map<string, StoredMessage[]>;
  /** Function to get messages for a child session ID (for nested sessions) */
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
};

// ============================================================================
// Shared Components
// ============================================================================

function LinkRenderer({ href, children }: { href?: string; children?: ReactNode }) {
  const safeHref = toSafeHttpUrl(href);
  if (!safeHref) {
    return <>{children}</>;
  }
  return (
    <a href={safeHref} target="_blank" rel="noopener noreferrer">
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
function TextPartRenderer({ part }: { part: Extract<Part, { type: 'text' }> }) {
  return (
    <div className="prose prose-sm prose-invert prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-headings:text-sm prose-headings:font-semibold prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-pre:text-xs max-w-none overflow-hidden px-2 leading-relaxed">
      {part.text ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {part.text}
        </ReactMarkdown>
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
    case 'codesearch':
      return typeof input.query === 'string' && input.query.length > 0;
    case 'webfetch':
      return typeof input.url === 'string' && input.url.length > 0;
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
    case 'todowrite':
    case 'question':
    case 'suggest':
    case 'skill':
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
    <div className="text-muted-foreground flex min-h-6 items-center gap-2 px-2 py-1 text-xs">
      <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      <span>
        {toolName}
        <span className="animate-pulse">...</span>
      </span>
    </div>
  );
}

const renderPartFn: RenderPartFn = props => <PartRenderer {...props} />;

function ToolPartRenderer({
  part,
  childSessionMessages,
  getChildMessages,
  onOpenChildSession,
}: {
  part: Extract<Part, { type: 'tool' }>;
  childSessionMessages?: Map<string, StoredMessage[]>;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
}) {
  if (!shouldRenderToolPart(part)) return null;

  if (
    part.state.status === 'error' &&
    !['question', 'suggest', 'chart', 'permission'].includes(part.tool)
  ) {
    return <ToolErrorCard toolName={part.tool} error={part.state.error} />;
  }

  if (
    (part.state.status === 'pending' || part.state.status === 'running') &&
    !hasRequiredInput(part)
  ) {
    return <StreamingToolPlaceholder toolName={part.tool} />;
  }

  switch (part.tool) {
    case 'task': {
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
          onOpenChildSession={onOpenChildSession}
        />
      );
    }
    case 'read':
      return <ReadToolCard toolPart={part} />;
    case 'edit':
      return <EditToolCard toolPart={part} />;
    case 'write':
      return <WriteToolCard toolPart={part} />;
    case 'apply_patch':
      return <ApplyPatchToolCard toolPart={part} />;
    case 'bash':
      return <BashToolCard toolPart={part} />;
    case 'background_process':
      return <BackgroundProcessToolCard toolPart={part} />;
    case 'glob':
      return <GlobToolCard toolPart={part} />;
    case 'grep':
      return <GrepToolCard toolPart={part} />;
    case 'webfetch':
      return <WebFetchToolCard toolPart={part} />;
    case 'websearch':
    case 'codesearch':
      return <WebSearchToolCard toolPart={part} />;
    case 'list':
      return <ListToolCard toolPart={part} />;
    case 'todowrite':
      return <TodoWriteToolCard toolPart={part} />;
    case 'question':
      return <QuestionToolStatus toolPart={part} />;
    case 'suggest':
      return <SuggestToolCard toolPart={part} />;
    case 'skill':
      return <SkillToolCard toolPart={part} />;
    default:
      return <GenericToolCard toolPart={part} />;
  }
}

/**
 * Renders a FilePart
 * For images, renders an img tag
 * For other files, renders a download link
 * Handles stripped file parts (where url is empty) gracefully
 */
function FilePartRenderer({ part }: { part: Extract<Part, { type: 'file' }> }) {
  const isImage = part.mime.startsWith('image/');
  const imageSrc = isImage ? toSafeImageSrc(part.url) : undefined;
  const fileHref = isImage ? undefined : toSafeHttpUrl(part.url);
  const hasUrl = Boolean(imageSrc ?? fileHref);

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

  if (isImage && imageSrc) {
    return (
      <div className="my-2">
        <img
          src={imageSrc}
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
      {fileHref && (
        <a
          href={fileHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-xs hover:underline"
        >
          Download
        </a>
      )}
      <span className="text-muted-foreground text-xs">({part.mime})</span>
    </div>
  );
}

/**
 * Renders a ReasoningPart as a collapsible card matching tool card visual language
 */
function ReasoningPartRenderer({
  part,
  isStreaming,
}: {
  part: Extract<Part, { type: 'reasoning' }>;
  isStreaming?: boolean;
}) {
  const streaming = (isStreaming ?? true) && isPartStreaming(part);

  if (!shouldRenderReasoningPart(part)) {
    return null;
  }

  const { title, body } = getReasoningPresentation(part.text);
  if (!title && !body) return null;
  const header = getReasoningHeader(title, part.time, streaming);

  if (!body) {
    return (
      <div className="text-muted-foreground flex min-h-6 items-center gap-2 px-2 py-1 text-xs">
        {streaming ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : (
          <Brain className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 truncate" title={header}>
          {header}
        </span>
      </div>
    );
  }

  return (
    <ToolCardShell icon={Brain} title={header} status={streaming ? 'running' : 'completed'}>
      <ToolMarkdown content={body} className="text-muted-foreground max-h-64" />
    </ToolCardShell>
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

export function PartRenderer({
  part,
  isStreaming,
  childSessionMessages,
  getChildMessages,
  onOpenChildSession,
}: PartRendererProps) {
  // Text parts -> render markdown
  if (isTextPart(part)) {
    return (
      <MessageErrorBoundary fallback={<PartErrorFallback partType="text" />}>
        <TextPartRenderer part={part} />
      </MessageErrorBoundary>
    );
  }

  if (isToolPart(part)) {
    return (
      <MessageErrorBoundary fallback={<PartErrorFallback partType="tool" />}>
        <ToolPartRenderer
          part={part}
          childSessionMessages={childSessionMessages}
          getChildMessages={getChildMessages}
          onOpenChildSession={onOpenChildSession}
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
    if (!shouldRenderReasoningPart(part)) {
      return null;
    }
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
