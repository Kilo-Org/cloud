import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import type {
  AgentConversationEvent,
  GroupedConversationItem,
} from '@/src/shared/agent-conversation';
import { getViewportScreenshotDataUrl } from '@/src/shared/agent-tool-output';

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
}: {
  event: Extract<AgentConversationEvent, { readonly type: 'message' }>;
}): JSX.Element => {
  const isUser = event.role === 'user';

  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          isUser
            ? 'max-w-[88%] rounded-lg bg-zinc-100 px-3 py-2 text-sm leading-5 text-zinc-950'
            : 'max-w-[88%] rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm leading-5 text-zinc-200'
        }
      >
        <div className="agent-message-markdown">
          <ReactMarkdown>{event.text}</ReactMarkdown>
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
  <details className="group rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
    <summary className="cursor-pointer list-none text-xs font-semibold text-zinc-400 outline-none transition hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-[#EDFF00] focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950">
      thinking
    </summary>
    <div className="agent-message-markdown mt-2 text-xs leading-5 text-zinc-400">
      <ReactMarkdown>{event.text}</ReactMarkdown>
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
    ? 'group min-w-0 rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2'
    : 'group min-w-0 rounded-md border border-red-500/30 bg-red-950/20 px-3 py-2';
  const titleClassName = isSuccessful
    ? 'text-xs font-semibold text-zinc-300'
    : 'text-xs font-semibold text-red-200';
  const tabClassName = isSuccessful ? 'text-[11px] text-zinc-500' : 'text-[11px] text-red-200/70';
  const codeLabelClassName = isSuccessful
    ? 'text-[11px] font-medium text-zinc-300'
    : 'text-[11px] font-medium text-red-200/80';
  const codeBlockClassName = isSuccessful
    ? 'mt-1 max-h-28 min-w-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-zinc-400'
    : 'mt-1 max-h-28 min-w-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-red-100/90';

  return (
    <details className={panelClassName}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 outline-none transition focus-visible:ring-2 focus-visible:ring-[#EDFF00] focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950">
        <span className={titleClassName}>
          {item.toolCall.name} {isSuccessful ? 'completed' : 'failed'}
        </span>
        <span className={tabClassName}>tab {item.toolCall.tabId}</span>
      </summary>
      <div className="mt-2 grid min-w-0 gap-2">
        {item.toolCall.name === 'eval' ? (
          <div className="min-w-0">
            <p className={codeLabelClassName}>Code</p>
            <pre className={codeBlockClassName}>{item.toolCall.code}</pre>
          </div>
        ) : null}
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-zinc-300">
            {isSuccessful ? 'Result' : 'Error'}
          </p>
          {screenshotDataUrl === undefined ? (
            <pre className="mt-1 max-h-28 min-w-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-zinc-400">
              {isSuccessful ? formatToolValue(item.result.value) : item.result.error}
            </pre>
          ) : (
            <img
              alt="Viewport screenshot captured by get_viewport_screenshot"
              className="mt-1 max-h-40 max-w-full rounded border border-zinc-800 object-contain"
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

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
      <p className="text-xs font-semibold text-zinc-300">{title}</p>
      <pre className="mt-2 max-h-28 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-zinc-400">
        {body}
      </pre>
    </div>
  );
};

export const AgentConversationItemView = ({
  item,
}: {
  item: GroupedConversationItem;
}): JSX.Element => {
  if (item.type === 'tool-exchange') {
    return <ToolExchangeEvent item={item} />;
  }

  const { event } = item;

  if (event.type === 'message') {
    return <MessageEvent event={event} />;
  }

  if (event.type === 'thinking') {
    return <ThinkingEvent event={event} />;
  }

  return <StandaloneToolEvent event={event} />;
};
