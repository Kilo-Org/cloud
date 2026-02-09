'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type EditToolCardProps = {
  toolPart: ToolPart;
};

type EditInput = {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
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
      return <span className="text-muted-foreground shrink-0 text-xs">edited</span>;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
  }
}

export function EditToolCard({ toolPart }: EditToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const state = toolPart.state;
  const input = state.input as EditInput;
  const filename = getFilename(input.filePath);
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIndicator(state.status)}
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{filename}</span>
        {input.replaceAll && (
          <span className="text-muted-foreground shrink-0 text-xs">(replace all)</span>
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
          {/* Show full path if different from filename */}
          {input.filePath !== filename && (
            <div>
              <div className="text-muted-foreground text-xs">Full path:</div>
              <div className="text-muted-foreground truncate font-mono text-xs">
                {input.filePath}
              </div>
            </div>
          )}

          {/* Old string */}
          <div>
            <div className="text-muted-foreground mb-1 text-xs">Old:</div>
            <pre className="bg-background max-h-40 overflow-auto rounded-md p-2 text-xs text-red-400">
              <code>{input.oldString || '(empty)'}</code>
            </pre>
          </div>

          {/* New string */}
          <div>
            <div className="text-muted-foreground mb-1 text-xs">New:</div>
            <pre className="bg-background max-h-40 overflow-auto rounded-md p-2 text-xs text-green-400">
              <code>{input.newString || '(empty)'}</code>
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
            <div className="text-muted-foreground text-xs italic">Editing file...</div>
          )}

          {/* Pending state */}
          {state.status === 'pending' && (
            <div className="text-muted-foreground text-xs italic">Waiting to edit...</div>
          )}
        </div>
      )}
    </div>
  );
}
