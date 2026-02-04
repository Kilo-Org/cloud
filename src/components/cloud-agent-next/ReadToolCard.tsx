'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type ReadToolCardProps = {
  toolPart: ToolPart;
};

type ReadInput = {
  filePath: string;
  offset?: number;
  limit?: number;
};

function getFilename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function getLineRange(input: ReadInput): string | null {
  if (input.offset === undefined && input.limit === undefined) {
    return null;
  }
  const start = (input.offset ?? 0) + 1; // Convert 0-based to 1-based
  if (input.limit !== undefined) {
    const end = start + input.limit - 1;
    return `${start}-${end}`;
  }
  return `${start}+`;
}

function getStatusIndicator(status: 'pending' | 'running' | 'completed' | 'error') {
  switch (status) {
    case 'error':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
    case 'completed':
      return <span className="text-muted-foreground shrink-0 text-xs">read</span>;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
  }
}

export function ReadToolCard({ toolPart }: ReadToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const state = toolPart.state;
  const input = state.input as ReadInput;
  const filename = getFilename(input.filePath);
  const lineRange = getLineRange(input);
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  const displayLabel = lineRange ? `${filename}:${lineRange}` : filename;

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIndicator(state.status)}
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{displayLabel}</span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <div className="border-muted border-t px-3 py-2">
          {/* Show full path if different from filename */}
          {input.filePath !== filename && (
            <div className="mb-2">
              <div className="text-muted-foreground text-xs">Full path:</div>
              <div className="text-muted-foreground truncate font-mono text-xs">
                {input.filePath}
              </div>
            </div>
          )}

          {/* Output content */}
          {output !== undefined && (
            <div>
              <div className="text-muted-foreground mb-1 text-xs">Content:</div>
              <pre className="bg-background max-h-80 overflow-auto rounded-md p-2 text-xs">
                <code>{output || '(empty file)'}</code>
              </pre>
            </div>
          )}

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
            <div className="text-muted-foreground text-xs italic">Reading file...</div>
          )}

          {/* Pending state */}
          {state.status === 'pending' && (
            <div className="text-muted-foreground text-xs italic">Waiting to read...</div>
          )}
        </div>
      )}
    </div>
  );
}
