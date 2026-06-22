import type { JSX } from 'react';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';

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

const ToolCallEvent = ({
  event,
}: {
  event: Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;
}): JSX.Element => (
  <div className="rounded-md border border-red-500/30 bg-red-950/20 px-3 py-2">
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs font-semibold text-red-200">eval</p>
      <p className="text-[11px] text-red-200/70">tab {event.tabId}</p>
    </div>
    <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-red-100/90">
      {event.code}
    </pre>
  </div>
);

const ToolResultEvent = ({
  event,
}: {
  event: Extract<AgentConversationEvent, { readonly type: 'tool-result' }>;
}): JSX.Element => (
  <div className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
    <p className="text-xs font-semibold text-zinc-300">{event.ok ? 'eval result' : 'eval error'}</p>
    <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-zinc-400">
      {event.ok ? formatToolValue(event.value) : event.error}
    </pre>
  </div>
);

export const AgentConversationEventView = ({
  event,
}: {
  event: AgentConversationEvent;
}): JSX.Element => {
  if (event.type === 'message') {
    return <MessageEvent event={event} />;
  }

  if (event.type === 'tool-call') {
    return <ToolCallEvent event={event} />;
  }

  return <ToolResultEvent event={event} />;
};
