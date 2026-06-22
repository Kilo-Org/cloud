import type { JSX } from 'react';
import type {
  AgentConversationEvent,
  GroupedConversationItem,
} from '@/src/shared/agent-conversation';

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
        <p>{event.text}</p>
      </div>
    </div>
  );
};

const ToolExchangeEvent = ({
  item,
}: {
  item: Extract<GroupedConversationItem, { readonly type: 'tool-exchange' }>;
}): JSX.Element => (
  <details className="group rounded-md border border-red-500/30 bg-red-950/20 px-3 py-2">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 outline-none transition focus-visible:ring-2 focus-visible:ring-[#EDFF00] focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950">
      <span className="text-xs font-semibold text-red-200">
        eval {item.result.ok ? 'completed' : 'failed'}
      </span>
      <span className="text-[11px] text-red-200/70">tab {item.toolCall.tabId}</span>
    </summary>
    <div className="mt-2 grid gap-2">
      <div>
        <p className="text-[11px] font-medium text-red-200/80">Code</p>
        <pre className="mt-1 max-h-28 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-red-100/90">
          {item.toolCall.code}
        </pre>
      </div>
      <div>
        <p className="text-[11px] font-medium text-zinc-300">
          {item.result.ok ? 'Result' : 'Error'}
        </p>
        <pre className="mt-1 max-h-28 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-zinc-400">
          {item.result.ok ? formatToolValue(item.result.value) : item.result.error}
        </pre>
      </div>
    </div>
  </details>
);

const StandaloneToolEvent = ({
  event,
}: {
  event: Exclude<AgentConversationEvent, { readonly type: 'message' }>;
}): JSX.Element => {
  let title = 'eval error';
  let body = event.type === 'tool-call' ? event.code : event.error;

  if (event.type === 'tool-call') {
    title = 'eval';
  } else if (event.ok) {
    title = 'eval result';
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

  return <StandaloneToolEvent event={event} />;
};
