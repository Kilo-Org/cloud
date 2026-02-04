'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type WriteToolCardProps = {
  toolPart: ToolPart;
};

type WriteInput = {
  filePath: string;
  content: string;
};

function getFilename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function getStatusIndicator(status: 'pending' | 'running' | 'completed' | 'error') {
  switch (status) {
    case 'error':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
    case 'completed':
      return <span className="text-muted-foreground shrink-0 text-xs">wrote</span>;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
  }
}

export function WriteToolCard({ toolPart }: WriteToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const state = toolPart.state;
  const input = state.input as WriteInput;
  const filename = getFilename(input.filePath);
  const error = state.status === 'error' ? state.error : undefined;

  // Calculate content stats
  const lineCount = input.content ? input.content.split('\n').length : 0;
  const byteCount = input.content ? new Blob([input.content]).size : 0;
  const sizeLabel = byteCount > 1024 ? `${(byteCount / 1024).toFixed(1)}KB` : `${byteCount}B`;

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIndicator(state.status)}
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{filename}</span>
        <span className="text-muted-foreground shrink-0 text-xs">
          {lineCount} lines, {sizeLabel}
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <div className="border-muted space-y-2 border-t px-3 py-2">
          {/* Show full path if different from filename */}
          {input.filePath !== filename && (
            <div>
              <div className="text-muted-foreground text-xs">Full path:</div>
              <div className="text-muted-foreground truncate font-mono text-xs">
                {input.filePath}
              </div>
            </div>
          )}

          {/* Content preview */}
          <div>
            <div className="text-muted-foreground mb-1 text-xs">Content:</div>
            <pre className="bg-background max-h-80 overflow-auto rounded-md p-2 text-xs">
              <code>{input.content || '(empty file)'}</code>
            </pre>
          </div>

          {/* Error */}
          {error && (
            <div>
              <div className="text-muted-foreground mb-1 text-xs">Error:</div>
              <pre className="bg-background overflow-auto rounded-md p-2 text-xs text-red-500">
                <code>{error}</code>
              </pre>
            </div>
          )}

          {/* Running state */}
          {state.status === 'running' && (
            <div className="text-muted-foreground text-xs italic">Writing file...</div>
          )}

          {/* Pending state */}
          {state.status === 'pending' && (
            <div className="text-muted-foreground text-xs italic">Waiting to write...</div>
          )}
        </div>
      )}
    </div>
  );
}
