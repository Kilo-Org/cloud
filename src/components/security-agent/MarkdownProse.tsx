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
      className="text-blue-400 hover:underline"
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
