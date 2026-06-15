'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

function LinkRenderer({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="focus-visible:ring-ring rounded-sm text-blue-400 underline decoration-blue-400/40 underline-offset-4 hover:text-blue-300 focus-visible:ring-2 focus-visible:outline-none"
    >
      {children}
    </a>
  );
}

const components = { a: LinkRenderer };

export function MarkdownProse({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div
      className={cn(
        'prose prose-sm prose-invert text-muted-foreground max-w-none wrap-break-word [&_code]:break-all [&_pre]:overflow-x-auto',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
