'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, XCircle, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type BashToolCardProps = {
  toolPart: ToolPart;
};

type BashInput = {
  command: string;
  description?: string;
  workdir?: string;
  timeout?: number;
};

function getCommandPreview(command: string): string {
  // Get first line or first 60 chars, whichever is shorter
  const firstLine = command.split('\n')[0] || command;
  if (firstLine.length > 60) {
    return firstLine.slice(0, 57) + '...';
  }
  return firstLine;
}

function getStatusIndicator(status: 'pending' | 'running' | 'completed' | 'error') {
  switch (status) {
    case 'error':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
    case 'completed':
      return <Terminal className="text-muted-foreground h-4 w-4 shrink-0" />;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
  }
}

export function BashToolCard({ toolPart }: BashToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const state = toolPart.state;
  const input = state.input as BashInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  const commandPreview = getCommandPreview(input.command);

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIndicator(state.status)}
        <code className="min-w-0 flex-1 truncate text-sm">{commandPreview}</code>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <div className="border-muted space-y-2 border-t px-3 py-2">
          {/* Description if provided */}
          {input.description && (
            <div className="text-muted-foreground text-xs">{input.description}</div>
          )}

          {/* Full command if different from preview */}
          {input.command !== commandPreview && (
            <div>
              <div className="text-muted-foreground mb-1 text-xs">Command:</div>
              <pre className="bg-background max-h-40 overflow-auto rounded-md p-2 text-xs">
                <code>{input.command}</code>
              </pre>
            </div>
          )}

          {/* Working directory */}
          {input.workdir && (
            <div className="text-muted-foreground truncate font-mono text-xs">
              cwd: {input.workdir}
            </div>
          )}

          {/* Output */}
          {output !== undefined && (
            <div>
              <div className="text-muted-foreground mb-1 text-xs">Output:</div>
              <pre className="bg-background max-h-80 overflow-auto rounded-md p-2 text-xs">
                <code>{output || '(no output)'}</code>
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
            <div className="text-muted-foreground text-xs italic">Running command...</div>
          )}

          {/* Pending state */}
          {state.status === 'pending' && (
            <div className="text-muted-foreground text-xs italic">Waiting to execute...</div>
          )}
        </div>
      )}
    </div>
  );
}
