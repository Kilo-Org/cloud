'use client';

import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyMessageButton } from '@/components/shared/CopyMessageButton';
import { toSafeHttpUrl } from '@/lib/safe-http-url';
import { cn } from '@/lib/utils';

type ToolCodeBlockProps = {
  content: string;
  label: string;
  isStreaming?: boolean;
  compact?: boolean;
  icon?: ReactNode;
  className?: string;
};

export function ToolCodeBlock({
  content,
  label,
  isStreaming = false,
  compact = false,
  icon,
  className,
}: ToolCodeBlockProps) {
  const copyButton = (
    <CopyMessageButton
      getText={() => content}
      label={`Copy ${label.toLowerCase()}`}
      className={compact ? 'mt-1 shrink-0' : undefined}
    />
  );

  return (
    <div
      className={cn(
        'not-prose text-foreground min-w-0',
        compact ? 'flex items-start gap-2' : 'space-y-1',
        className
      )}
    >
      {compact ? (
        icon && (
          <span
            className="text-muted-foreground mt-2 flex h-[1lh] shrink-0 items-center text-xs leading-relaxed"
            aria-hidden="true"
          >
            {icon}
          </span>
        )
      ) : (
        <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
          <span>{label}</span>
          {copyButton}
        </div>
      )}
      <pre
        role="region"
        tabIndex={0}
        aria-label={label}
        aria-busy={isStreaming || undefined}
        className={cn(
          'bg-background focus-visible:ring-ring max-h-80 max-w-full overflow-auto rounded-md p-2 font-mono text-xs leading-relaxed focus-visible:ring-2 focus-visible:outline-none',
          compact && 'min-w-0 flex-1'
        )}
      >
        <code>{content}</code>
      </pre>
      {compact && copyButton}
    </div>
  );
}

function ToolLink({ href, children }: { href?: string; children?: ReactNode }) {
  const safeHref = toSafeHttpUrl(href);
  if (!safeHref) return <>{children}</>;
  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link focus-visible:ring-ring rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
    >
      {children}
    </a>
  );
}

const markdownComponents: Components = {
  a: ToolLink,
  img: ({ src, alt }) => (
    <ToolLink href={typeof src === 'string' ? src : undefined}>{alt || 'Image'}</ToolLink>
  ),
  pre: ({ node, children }) => {
    const code = node?.children[0];
    if (code?.type !== 'element' || code.tagName !== 'code') return <pre>{children}</pre>;
    const content = code.children.map(child => (child.type === 'text' ? child.value : '')).join('');
    return <ToolCodeBlock content={content.replace(/\n$/, '')} label="Code" />;
  },
};

export function ToolMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label="Tool output"
      className={cn(
        'prose prose-sm prose-invert prose-headings:text-foreground prose-strong:text-foreground prose-code:text-foreground prose-th:text-foreground prose-headings:my-2 prose-headings:text-xs prose-headings:font-semibold prose-p:my-1 prose-p:whitespace-pre-wrap prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-li:whitespace-pre-wrap prose-pre:my-2 text-foreground focus-visible:ring-ring max-h-80 min-w-0 max-w-none overflow-auto text-xs leading-relaxed focus-visible:ring-2 focus-visible:outline-none [overflow-wrap:anywhere]',
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={toSafeHttpUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
