'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, XCircle, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type GlobToolCardProps = {
  toolPart: ToolPart;
};

type GlobInput = {
  pattern: string;
  path?: string;
};

function getStatusIndicator(status: 'pending' | 'running' | 'completed' | 'error') {
  switch (status) {
    case 'error':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
    case 'completed':
      return <Search className="text-muted-foreground h-4 w-4 shrink-0" />;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
  }
}

function parseGlobOutput(output: string | undefined): string[] {
  if (!output) return [];
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function GlobToolCard({ toolPart }: GlobToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const state = toolPart.state;
  const input = state.input as GlobInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  const files = parseGlobOutput(output);
  const fileCount = files.length;

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIndicator(state.status)}
        <code className="min-w-0 flex-1 truncate text-sm">{input.pattern}</code>
        {state.status === 'completed' && (
          <span className="text-muted-foreground shrink-0 text-xs">
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </span>
        )}
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <div className="border-muted space-y-2 border-t px-3 py-2">
          {/* Search path if specified */}
          {input.path && (
            <div className="text-muted-foreground truncate font-mono text-xs">in: {input.path}</div>
          )}

          {/* Results */}
          {files.length > 0 && (
            <div>
              <div className="text-muted-foreground mb-1 text-xs">Matches:</div>
              <div className="bg-background max-h-60 overflow-auto rounded-md p-2">
                {files.map((file, idx) => (
                  <div key={idx} className="truncate font-mono text-xs">
                    {file}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No matches */}
          {state.status === 'completed' && files.length === 0 && (
            <div className="text-muted-foreground text-xs italic">No matches found</div>
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
            <div className="text-muted-foreground text-xs italic">Searching files...</div>
          )}

          {/* Pending state */}
          {state.status === 'pending' && (
            <div className="text-muted-foreground text-xs italic">Waiting to search...</div>
          )}
        </div>
      )}
    </div>
  );
}
