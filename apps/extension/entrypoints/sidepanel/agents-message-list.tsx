import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StoredMessage, Part } from '@kilocode/cloud-agent-sdk';

const remarkPlugins = [remarkGfm];

const toolStatusLabel = (status: string): string => {
  if (status === 'pending') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'error') return 'error';
  return status;
};

const toolStatusColor = (status: string): string => {
  if (status === 'error') return 'text-status-red-400';
  if (status === 'completed') return 'text-status-green-500';
  if (status === 'running') return 'text-foreground-muted';
  return 'text-foreground-muted';
};

const ToolPartRow = ({ part }: { part: Extract<Part, { type: 'tool' }> }): JSX.Element => {
  const status = part.state.status;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-foreground-muted">{part.tool}</span>
      <span className={toolStatusColor(status)}>{toolStatusLabel(status)}</span>
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

const MessageRow = ({ message }: { message: StoredMessage }): JSX.Element => {
  const isUser = message.info.role === 'user';
  const isStreaming =
    message.info.role === 'assistant' && !message.info.time.completed && !message.info.error;
  const textParts = message.parts.filter(p => p.type === 'text');
  const nonTextParts = message.parts.filter(p => p.type !== 'text');
  const hasContent = message.parts.length > 0;

  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          isUser
            ? 'max-w-[88%] rounded-lg border border-border bg-surface-raised px-3 py-2'
            : 'max-w-[88%] rounded-lg px-3 py-2'
        }
      >
        {!hasContent ? (
          <div className="flex items-center gap-1.5 text-xs text-foreground-muted">
            <span
              className={`inline-block size-1.5 rounded-full ${isStreaming ? 'animate-pulse bg-foreground-muted' : 'bg-foreground-muted'}`}
            />
            {isStreaming ? 'Thinking…' : 'No content'}
          </div>
        ) : (
          <div className="space-y-1">
            {textParts.map(part => (
              <PartRow key={part.id} part={part} />
            ))}
            {nonTextParts.map(part => (
              <PartRow key={part.id} part={part} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export const AgentsMessageList = ({ messages }: { messages: StoredMessage[] }): JSX.Element => {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-6">
        <p className="type-body text-foreground-muted">No messages yet</p>
      </div>
    );
  }

  return (
    <div className="agent-conversation-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="space-y-3">
        {messages.map(message => (
          <MessageRow key={message.info.id} message={message} />
        ))}
      </div>
    </div>
  );
};
