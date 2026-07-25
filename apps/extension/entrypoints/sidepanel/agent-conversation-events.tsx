import type { JSX, ReactNode } from 'react';
import { isValidElement } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  AgentConversationEvent,
  GroupedConversationItem,
} from '@/src/shared/agent-conversation';
import { getViewportScreenshotDataUrl } from '@/src/shared/agent-tool-output';
// Explicit .tsx: collapsible-code-block.ts (pure helpers) shadows the default resolution.
import { CollapsibleCodeBlock } from './collapsible-code-block.tsx';

// Hoisted so the array reference is stable (react-perf) across renders.
const remarkPlugins = [remarkGfm];

const extractCodeText = (codeChildren: unknown): string | undefined => {
  if (typeof codeChildren === 'string') {
    return codeChildren;
  }

  if (Array.isArray(codeChildren) && codeChildren.every(part => typeof part === 'string')) {
    return codeChildren.join('');
  }

  return undefined;
};

const asNodeList = (children: ReactNode): readonly unknown[] => {
  if (Array.isArray(children)) {
    return children;
  }

  return [children];
};

const extractCodeChild = (
  children: ReactNode
): { readonly className: string | undefined; readonly code: string } | undefined => {
  for (const child of asNodeList(children)) {
    if (child === null || typeof child !== 'object') {
      // Skip non-element children (text nodes, null).
    } else if (
      isValidElement<{ children?: unknown; className?: string }>(child) &&
      child.type === 'code'
    ) {
      const code = extractCodeText(child.props.children);

      if (code === undefined) {
        return undefined;
      }

      return { className: child.props.className, code };
    }
  }

  return undefined;
};

const createAssistantMarkdownComponents = (forceExpanded: boolean): Components => ({
  pre: ({ children }) => {
    const extracted = extractCodeChild(children);

    if (extracted === undefined) {
      return <pre>{children}</pre>;
    }

    return (
      <CollapsibleCodeBlock
        code={extracted.code}
        forceExpanded={forceExpanded}
        languageClassName={extracted.className}
      />
    );
  },
});

// Hoisted so the object reference is stable (react-perf) across renders.
const assistantMarkdownComponentsStreaming = createAssistantMarkdownComponents(true);
const assistantMarkdownComponentsFinalized = createAssistantMarkdownComponents(false);

const formatToolValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value === null
  ) {
    return String(value);
  }

  if (value === undefined) {
    return 'undefined';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Unserializable result';
  }
};

const MessageEvent = ({
  event,
  streamingMessageId,
}: {
  event: Extract<AgentConversationEvent, { readonly type: 'message' }>;
  streamingMessageId?: string | undefined;
}): JSX.Element => {
  const isUser = event.role === 'user';
  // Only assistant messages get collapsible code blocks; user branch keeps default rendering.
  let assistantComponents: Components | undefined = undefined;
  if (!isUser) {
    assistantComponents =
      event.id === streamingMessageId
        ? assistantMarkdownComponentsStreaming
        : assistantMarkdownComponentsFinalized;
  }

  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          isUser
            ? 'max-w-[88%] rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm leading-5 text-foreground'
            : 'max-w-[88%] rounded-lg px-3 py-2 text-sm leading-5 text-foreground'
        }
      >
        <div className="agent-message-markdown">
          <ReactMarkdown components={assistantComponents} remarkPlugins={remarkPlugins}>
            {event.text}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
};

const ThinkingEvent = ({
  event,
}: {
  event: Extract<AgentConversationEvent, { readonly type: 'thinking' }>;
}): JSX.Element => (
  <details className="group rounded-lg border border-border bg-surface-inset px-3 py-2">
    <summary className="cursor-pointer list-none text-xs font-semibold text-foreground-muted outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background">
      thinking
    </summary>
    <div className="agent-message-markdown mt-2 text-xs leading-5 text-foreground-muted">
      <ReactMarkdown remarkPlugins={remarkPlugins}>{event.text}</ReactMarkdown>
    </div>
  </details>
);

const ToolExchangeEvent = ({
  item,
}: {
  item: Extract<GroupedConversationItem, { readonly type: 'tool-exchange' }>;
}): JSX.Element => {
  const isSuccessful = item.result.ok;
  const screenshotDataUrl = isSuccessful
    ? getViewportScreenshotDataUrl(item.toolCall.name, item.result.value)
    : undefined;

  const panelClassName = isSuccessful
    ? 'group min-w-0 rounded-lg border border-border bg-surface-inset px-3 py-2'
    : 'group min-w-0 rounded-lg border border-status-red-500 bg-diff-delete-surface px-3 py-2';
  const titleClassName = isSuccessful
    ? 'text-xs font-semibold text-foreground'
    : 'text-xs font-semibold text-status-red-300';
  const tabClassName = isSuccessful
    ? 'text-xs text-foreground-subtle'
    : 'text-xs text-status-red-400';
  const codeLabelClassName = isSuccessful
    ? 'text-xs font-medium text-foreground-muted'
    : 'text-xs font-medium text-status-red-400';
  const codeBlockClassName = isSuccessful
    ? 'mt-1 max-h-28 min-w-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-4 text-foreground-muted'
    : 'mt-1 max-h-28 min-w-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-4 text-status-red-300/80';
  const resultLabelClassName = isSuccessful
    ? 'text-xs font-medium text-foreground-muted'
    : 'text-xs font-medium text-status-red-300';
  const resultBlockClassName = isSuccessful
    ? 'mt-1 max-h-28 min-w-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-4 text-foreground-muted'
    : 'mt-1 max-h-28 min-w-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-4 text-status-red-300/80';

  return (
    <details className={panelClassName}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 outline-none transition focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background">
        <span className={titleClassName}>
          {item.toolCall.name} {isSuccessful ? 'completed' : 'failed'}
        </span>
        <span className={tabClassName}>
          {'serverName' in item.toolCall ? item.toolCall.serverName : `tab ${item.toolCall.tabId}`}
        </span>
      </summary>
      <div className="mt-2 grid min-w-0 gap-2">
        {item.toolCall.name === 'eval' ? (
          <div className="min-w-0">
            <p className={codeLabelClassName}>Code</p>
            <pre className={codeBlockClassName}>{item.toolCall.code}</pre>
          </div>
        ) : null}
        {'arguments' in item.toolCall ? (
          <div className="min-w-0">
            <p className={codeLabelClassName}>Arguments</p>
            <pre className={codeBlockClassName}>{formatToolValue(item.toolCall.arguments)}</pre>
          </div>
        ) : null}
        <div className="min-w-0">
          <p className={resultLabelClassName}>{isSuccessful ? 'Result' : 'Error'}</p>
          {screenshotDataUrl === undefined ? (
            <pre className={resultBlockClassName}>
              {isSuccessful ? formatToolValue(item.result.value) : item.result.error}
            </pre>
          ) : (
            <img
              alt="Viewport screenshot captured by get_viewport_screenshot"
              className="mt-1 max-h-40 max-w-full rounded-md border border-border object-contain"
              src={screenshotDataUrl}
            />
          )}
        </div>
      </div>
    </details>
  );
};

const StandaloneToolEvent = ({
  event,
}: {
  event: Exclude<AgentConversationEvent, { readonly type: 'message' | 'thinking' }>;
}): JSX.Element => {
  let title = 'tool error';
  let body = event.type === 'tool-call' ? event.name : event.error;

  if (event.type === 'tool-call') {
    title = event.name;
  } else if (event.ok) {
    title = 'tool result';
    body = formatToolValue(event.value);
  }

  const isFailure = event.type === 'tool-result' && !event.ok;
  const rootClassName = isFailure
    ? 'rounded-lg border border-status-red-500 bg-diff-delete-surface px-3 py-2'
    : 'rounded-lg border border-border bg-surface-inset px-3 py-2';
  const titleClassName = isFailure
    ? 'text-xs font-semibold text-status-red-300'
    : 'text-xs font-semibold text-foreground';
  const bodyClassName = isFailure
    ? 'mt-2 max-h-28 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-4 text-status-red-300/80'
    : 'mt-2 max-h-28 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-4 text-foreground-muted';

  return (
    <div className={rootClassName}>
      <p className={titleClassName}>{title}</p>
      <pre className={bodyClassName}>{body}</pre>
    </div>
  );
};

export const AgentConversationItemView = ({
  item,
  streamingMessageId,
}: {
  item: GroupedConversationItem;
  streamingMessageId?: string | undefined;
}): JSX.Element => {
  if (item.type === 'tool-exchange') {
    return <ToolExchangeEvent item={item} />;
  }

  const { event } = item;

  if (event.type === 'message') {
    return <MessageEvent event={event} streamingMessageId={streamingMessageId} />;
  }

  if (event.type === 'thinking') {
    return <ThinkingEvent event={event} />;
  }

  return <StandaloneToolEvent event={event} />;
};
