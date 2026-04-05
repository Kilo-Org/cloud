/**
 * Message Content Renderer
 *
 * Handles different message subtypes from the cloud agent stream.
 * Based on CLI's message routing patterns from cli-message-use.md
 */

'use client';

import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { ToolExecutionCard } from './ToolExecutionCard';
import type { ToolExecution } from './types';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';

function LinkRenderer({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

const markdownComponents = { a: LinkRenderer };

export interface MessageContentProps {
  content: string;
  say?: string;
  ask?: string;
  metadata?: Record<string, unknown>;
  partial?: boolean;
  isStreaming?: boolean;
}

/**
 * Main message content renderer
 * Routes to appropriate subcomponent based on message `say`/`ask` type
 */
export function MessageContent({
  content,
  say,
  ask,
  metadata,
  partial,
  isStreaming,
}: MessageContentProps) {
  if (ask === 'tool' || ask === 'use_mcp_tool' || ask === 'command') {
    return <ToolMessage metadata={metadata} partial={partial} ask={ask} content={content} />;
  }

  if (say === 'api_req_started') {
    return <ApiRequestMessage metadata={metadata} partial={partial} />;
  }

  if (say === 'completion_result') {
    return <CompletionResultMessage content={content} isStreaming={isStreaming} />;
  }

  if (say === 'command_output') {
    return <CommandOutputMessage content={content} />;
  }

  // Default: regular text message
  return <TextMessage content={content} isStreaming={isStreaming} />;
}

/**
 * API Request Message
 * Shows progress/completion of API requests
 */
function ApiRequestMessage({
  metadata,
  partial,
}: {
  metadata?: Record<string, unknown>;
  partial?: boolean;
}) {
  // Check if we have completion metadata (cost, error, or cancel reason)
  const hasCompletionMetadata =
    metadata &&
    (metadata.cost !== undefined ||
      metadata.streamingFailedMessage !== undefined ||
      metadata.cancelReason !== undefined);

  // Still in progress (partial, no metadata, or metadata without completion info)
  if (partial || !hasCompletionMetadata) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>API Request in progress...</span>
      </div>
    );
  }

  if (metadata.streamingFailedMessage) {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex items-center gap-2 text-red-500">
          <XCircle className="h-4 w-4" />
          <span className="font-medium">API Request failed</span>
        </div>
        <p className="text-red-500/80">{String(metadata.streamingFailedMessage)}</p>
      </div>
    );
  }

  if (metadata.cancelReason) {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex items-center gap-2 text-yellow-500">
          <XCircle className="h-4 w-4" />
          <span className="font-medium">API Request cancelled</span>
        </div>
        <p className="text-yellow-500/80">{String(metadata.cancelReason)}</p>
      </div>
    );
  }

  // Completed successfully
  const cost = metadata.cost as number | undefined;
  const tokensIn = metadata.tokensIn as number | undefined;
  const tokensOut = metadata.tokensOut as number | undefined;
  const provider = metadata.inferenceProvider as string | undefined;

  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="flex items-center gap-2 text-green-500">
        <CheckCircle2 className="h-4 w-4" />
        <span className="font-medium">API Request</span>
      </div>
      {cost !== undefined && <span className="text-muted-foreground">${cost.toFixed(4)}</span>}
      {tokensIn !== undefined && tokensOut !== undefined && (
        <span className="text-muted-foreground">
          {tokensIn.toLocaleString()} / {tokensOut.toLocaleString()} tokens
        </span>
      )}
      {provider && <span className="text-muted-foreground text-xs">({provider})</span>}
    </div>
  );
}

/**
 * Completion Result Message
 * Shows the final result from the agent
 */
function CompletionResultMessage({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  return (
    <div
      className={cn(
        'prose prose-sm prose-invert max-w-none overflow-hidden',
        isStreaming && 'animate-pulse'
      )}
    >
      {content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      ) : isStreaming ? (
        'Completing...'
      ) : null}
    </div>
  );
}

/**
 * Regular Text Message
 * Default message renderer
 */
function TextMessage({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  return (
    <div
      className={cn(
        'prose prose-sm prose-invert max-w-none overflow-hidden',
        isStreaming && 'animate-pulse'
      )}
    >
      {content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      ) : isStreaming ? (
        'Thinking...'
      ) : null}
    </div>
  );
}

/**
 * Tool Message
 * Shows tool execution inline with Running/Complete status
 */
export function ToolMessage({
  metadata,
  partial,
  ask,
  content,
}: {
  metadata?: Record<string, unknown>;
  partial?: boolean;
  ask?: string;
  content?: string;
}) {
  const formatToolContent = (rawContent?: string) => {
    if (!rawContent) return '';
    const trimmed = rawContent.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return rawContent;
    try {
      return JSON.stringify(JSON.parse(rawContent), null, 2);
    } catch {
      return rawContent;
    }
  };

  // Handle command messages (with or without content)
  // Should mimic CLI behavior: atm always show command header, show box only if content exists
  if (ask === 'command') {
    // If there's no command content, show header only
    if (!content) {
      return (
        <div className="bg-muted/30 border-muted flex items-center gap-2 rounded-md border px-3 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
          <span className="text-sm">Command executing...</span>
        </div>
      );
    }

    const execution: ToolExecution = {
      toolName: 'bash',
      input: { command: content },
      timestamp: new Date().toISOString(),
      ...(partial === false ? { output: '' } : {}),
    };
    return <ToolExecutionCard execution={execution} />;
  }

  // Handle regular tool messages with metadata
  if (!metadata) {
    const formattedContent = formatToolContent(content);
    if (formattedContent) {
      return (
        <div className="bg-muted/30 border-muted space-y-2 rounded-md border px-3 py-2">
          <div className="text-muted-foreground text-xs font-medium">Tool message</div>
          <pre className="overflow-wrap-anywhere font-mono text-xs break-words whitespace-pre-wrap">
            {formattedContent}
          </pre>
        </div>
      );
    }
    return (
      <div className="bg-muted/30 border-muted text-muted-foreground rounded-md border px-3 py-2 text-sm">
        Tool message
      </div>
    );
  }

  const toolName = (metadata.tool as string) || ask || 'tool';

  // All fields except 'tool' are input parameters
  const input = { ...metadata };
  delete input.tool;

  // Convert to ToolExecution format
  const execution: ToolExecution = {
    toolName,
    input,
    timestamp: new Date().toISOString(),
    // Mark as complete if partial=false, otherwise still running
    ...(partial === false ? { output: '' } : {}),
  };

  return <ToolExecutionCard execution={execution} />;
}

/**
 * Command Output Message
 * Shows command execution output
 */
function CommandOutputMessage({ content }: { content: string }) {
  return (
    <div className="my-2">
      <div className="bg-muted overflow-hidden rounded-md p-3">
        <div className="text-muted-foreground mb-1 text-xs font-medium">Output:</div>
        <pre className="overflow-wrap-anywhere font-mono text-sm break-words whitespace-pre-wrap">
          {content}
        </pre>
      </div>
    </div>
  );
}
