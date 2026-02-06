'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, XCircle, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type ListToolCardProps = {
  toolPart: ToolPart;
};

type ListInput = {
  path: string;
  recursive?: boolean;
};

function getDirectoryName(path: string): string {
  // Remove trailing slash and get last segment
  const cleaned = path.replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || path || '.';
}

function getStatusIndicator(status: 'pending' | 'running' | 'completed' | 'error') {
  switch (status) {
    case 'error':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
    case 'completed':
      return <FolderOpen className="text-muted-foreground h-4 w-4 shrink-0" />;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
  }
}

function parseListOutput(output: string | undefined): string[] {
  if (!output) return [];
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function ListToolCard({ toolPart }: ListToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const state = toolPart.state;
  const input = state.input as ListInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  const dirName = getDirectoryName(input.path);
  const entries = parseListOutput(output);
  const entryCount = entries.length;

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIndicator(state.status)}
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{dirName}</span>
        {input.recursive && (
          <span className="text-muted-foreground shrink-0 text-xs">(recursive)</span>
        )}
        {state.status === 'completed' && (
          <span className="text-muted-foreground shrink-0 text-xs">
            {entryCount} {entryCount === 1 ? 'entry' : 'entries'}
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
          {/* Full path if different from display name */}
          {input.path !== dirName && (
            <div className="text-muted-foreground truncate font-mono text-xs">{input.path}</div>
          )}

          {/* Directory listing */}
          {entries.length > 0 && (
            <div className="bg-background max-h-60 overflow-auto rounded-md p-2">
              {entries.map((entry, idx) => (
                <div key={idx} className="truncate font-mono text-xs">
                  {entry}
                </div>
              ))}
            </div>
          )}

          {/* Empty directory */}
          {state.status === 'completed' && entries.length === 0 && (
            <div className="text-muted-foreground text-xs italic">Directory is empty</div>
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
            <div className="text-muted-foreground text-xs italic">Listing directory...</div>
          )}

          {/* Pending state */}
          {state.status === 'pending' && (
            <div className="text-muted-foreground text-xs italic">Waiting to list...</div>
          )}
        </div>
      )}
    </div>
  );
}
