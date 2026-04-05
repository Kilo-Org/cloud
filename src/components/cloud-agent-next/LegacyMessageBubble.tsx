'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CheckCircle2, Wrench, XCircle } from 'lucide-react';
import { TimeAgo } from '@/components/shared/TimeAgo';
import type { CloudMessage } from './legacy-session-types';

type LegacyMessageBubbleProps = {
  message: CloudMessage;
};

const markdownLinkComponent = {
  a: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  ),
};

function ToolSummary({ message }: { message: CloudMessage }) {
  const { ask, metadata } = message;

  let toolName: string | undefined;
  if (ask === 'tool') {
    toolName = metadata?.tool as string | undefined;
  } else if (ask === 'command') {
    toolName = metadata?.command as string | undefined;
  } else if (ask === 'use_mcp_tool') {
    const server = metadata?.server_name as string | undefined;
    const tool = metadata?.tool_name as string | undefined;
    toolName = server && tool ? `${server}/${tool}` : (tool ?? server);
  }

  const approved = metadata?.approved;

  return (
    <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
      <Wrench className="h-3.5 w-3.5 shrink-0" />
      <span>{toolName || 'Tool execution'}</span>
      {approved === true && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
      {approved === false && <XCircle className="h-3.5 w-3.5 text-red-500" />}
    </div>
  );
}

function ApiRequestSummary({ message }: { message: CloudMessage }) {
  const cost = message.metadata?.cost as number | undefined;
  const label =
    cost != null && !message.partial ? `API Request · $${cost.toFixed(4)}` : 'API Request';

  return <div className="text-muted-foreground text-xs">{label}</div>;
}

function CommandOutput({ content }: { content: string }) {
  return (
    <pre className="bg-muted max-h-64 overflow-x-auto overflow-y-auto rounded p-3 text-xs">
      <code>{content}</code>
    </pre>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownLinkComponent}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function AssistantContent({ message }: { message: CloudMessage }) {
  const content = message.text || message.content || '';
  const { ask, say } = message;

  if (ask === 'tool' || ask === 'command' || ask === 'use_mcp_tool') {
    return <ToolSummary message={message} />;
  }

  if (say === 'api_req_started') {
    return <ApiRequestSummary message={message} />;
  }

  if (say === 'command_output') {
    return <CommandOutput content={content} />;
  }

  // completion_result, text, or any other say value
  return <MarkdownContent content={content} />;
}

export function LegacyMessageBubble({ message }: LegacyMessageBubbleProps) {
  if (message.type === 'user') {
    const content = message.text || message.content || '';
    return (
      <div className="group/msg flex flex-col items-end py-2">
        <div className="bg-primary text-primary-foreground rounded-2xl px-4 py-2">
          <p className="whitespace-pre-wrap">{content}</p>
        </div>
        <TimeAgo
          timestamp={message.ts}
          className="text-muted-foreground/50 mt-1 text-xs opacity-0 transition-opacity group-hover/msg:opacity-100"
        />
      </div>
    );
  }

  // assistant or system
  return (
    <div className="group/msg py-2">
      <div className="mb-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
        <TimeAgo timestamp={message.ts} className="text-muted-foreground/50 text-xs" />
      </div>
      <AssistantContent message={message} />
    </div>
  );
}
