import { useCallback, useLayoutEffect, useRef } from 'react';
import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2 } from 'lucide-react';
import type { StoredMessage, Part } from '@kilocode/cloud-agent-sdk';

/** Distance from the bottom (px) still treated as "at the bottom". */
const BOTTOM_PIN_THRESHOLD_PX = 32;

const remarkPlugins = [remarkGfm];

const toolStatusLabel = (status: string): string => {
  if (status === 'pending') {
    return 'pending';
  }
  if (status === 'running') {
    return 'running';
  }
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'error') {
    return 'error';
  }
  return status;
};

const toolStatusColor = (status: string): string => {
  if (status === 'error') {
    return 'text-status-red-400';
  }
  if (status === 'completed') {
    return 'text-status-green-500';
  }
  if (status === 'running') {
    return 'text-foreground-muted';
  }
  return 'text-foreground-muted';
};

/** Longest tool error rendered inline; the rest would swamp the transcript. */
const TOOL_ERROR_MAX_LENGTH = 200;

/**
 * First meaningful line of a tool error, clamped. Tool failures arrive as
 * anything from one line to a stack trace, and the transcript must stay
 * readable in a narrow panel.
 */
export const toolErrorSummary = (error: string): string => {
  const firstLine = error
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '');
  if (firstLine === undefined) {
    return '';
  }
  return firstLine.length > TOOL_ERROR_MAX_LENGTH
    ? `${firstLine.slice(0, TOOL_ERROR_MAX_LENGTH)}…`
    : firstLine;
};

const ToolPartRow = ({ part }: { part: Extract<Part, { type: 'tool' }> }): JSX.Element => {
  const { state } = part;
  const { status } = state;
  const isActive = status === 'running' || status === 'pending';
  // The tool's own summary of the call — a path, a command. Absent while pending.
  const title = 'title' in state ? state.title : undefined;
  const errorSummary = state.status === 'error' ? toolErrorSummary(state.error) : '';

  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5">
        {isActive ? (
          <Loader2
            aria-hidden="true"
            className="size-3 shrink-0 animate-spin text-foreground-muted"
          />
        ) : null}
        <span className="shrink-0 text-foreground-muted">{part.tool}</span>
        {title === undefined || title === '' ? null : (
          <span className="min-w-0 flex-1 truncate text-foreground-subtle">{title}</span>
        )}
        <span className={`shrink-0 ${toolStatusColor(status)}`}>{toolStatusLabel(status)}</span>
      </div>
      {errorSummary === '' ? null : (
        <p className="mt-0.5 break-words text-status-red-400">{errorSummary}</p>
      )}
    </div>
  );
};

const ReasoningPartRow = (): JSX.Element => (
  <div className="text-xs text-foreground-muted italic">Reasoning</div>
);

const TextPartContent = ({ part }: { part: Extract<Part, { type: 'text' }> }): JSX.Element => (
  <div className="agent-message-markdown text-sm leading-5">
    <ReactMarkdown remarkPlugins={remarkPlugins}>{part.text}</ReactMarkdown>
  </div>
);

const PartRow = ({ part }: { part: Part }): JSX.Element | null => {
  if (part.type === 'text') {
    return <TextPartContent part={part} />;
  }
  if (part.type === 'reasoning') {
    return <ReasoningPartRow />;
  }
  if (part.type === 'tool') {
    return <ToolPartRow part={part} />;
  }
  // All other part types render nothing per decision 14.
  return null;
};

/**
 * Real transcripts carry a reasoning part before nearly every step. Keep a
 * single reasoning row only while the message still streams; a completed
 * message shows its tools and text without the noise.
 */
export const visibleParts = (parts: Part[], isStreaming: boolean): Part[] => {
  if (isStreaming) {
    return parts.filter(
      (part, index) => part.type !== 'reasoning' || parts[index + 1] === undefined
    );
  }
  return parts.filter(part => part.type !== 'reasoning');
};

const MessageRow = ({ message }: { message: StoredMessage }): JSX.Element => {
  const isUser = message.info.role === 'user';
  const isStreaming =
    message.info.role === 'assistant' &&
    message.info.time.completed === undefined &&
    !message.info.error;
  const parts = visibleParts(message.parts, isStreaming);
  const hasContent = parts.length > 0;

  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          isUser
            ? 'max-w-[88%] rounded-lg border border-border bg-surface-raised px-3 py-2'
            : 'max-w-[88%] rounded-lg px-3 py-2'
        }
      >
        {hasContent ? (
          <div className="space-y-1">
            {/* Parts render in stored order: tools come before the text they produced. */}
            {parts.map(part => (
              <PartRow key={part.id} part={part} />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-foreground-muted">
            <span
              className={`inline-block size-1.5 rounded-full ${isStreaming ? 'animate-pulse bg-foreground-muted' : 'bg-foreground-muted'}`}
            />
            {isStreaming ? 'Thinking…' : 'No content'}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * True when the agent is running but the newest message shows no live
 * assistant output — the gap between sending a prompt and the first
 * assistant token. The indicator fills that gap.
 */
export const shouldShowWorkingIndicator = (
  isStreaming: boolean,
  messages: StoredMessage[]
): boolean => {
  if (!isStreaming) {
    return false;
  }
  const last = messages.at(-1);
  if (last === undefined) {
    return true;
  }
  return last.info.role !== 'assistant' || last.info.time.completed !== undefined;
};

const WorkingIndicatorRow = (): JSX.Element => (
  <div className="flex justify-start">
    <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-foreground-muted">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-foreground-muted" />
      Working…
    </div>
  </div>
);

export const AgentsMessageList = ({
  messages,
  isStreaming = false,
}: {
  messages: StoredMessage[];
  isStreaming?: boolean;
}): JSX.Element => {
  const showWorking = shouldShowWorkingIndicator(isStreaming, messages);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the bottom until the user scrolls up; re-arm when they return.
  const pinnedRef = useRef(true);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    pinnedRef.current =
      element.scrollTop + element.clientHeight >= element.scrollHeight - BOTTOM_PIN_THRESHOLD_PX;
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  });

  if (messages.length === 0 && !showWorking) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-6">
        <p className="type-body text-foreground-muted">No messages yet</p>
      </div>
    );
  }

  return (
    <div
      className="agent-conversation-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4"
      onScroll={handleScroll}
      ref={scrollRef}
    >
      <div className="space-y-3">
        {messages.map(message => (
          <MessageRow key={message.info.id} message={message} />
        ))}
        {showWorking ? <WorkingIndicatorRow /> : null}
      </div>
    </div>
  );
};
