'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, XCircle, Plug } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type McpToolCardProps = {
  toolPart: ToolPart;
};

type McpInput = {
  server_name: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
};

function getStatusIndicator(status: 'pending' | 'running' | 'completed' | 'error') {
  switch (status) {
    case 'error':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
    case 'completed':
      return <Plug className="text-muted-foreground h-4 w-4 shrink-0" />;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
  }
}

export function McpToolCard({ toolPart }: McpToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const state = toolPart.state;
  const input = state.input as McpInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  const displayName = `${input.server_name}/${input.tool_name}`;

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIndicator(state.status)}
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{displayName}</span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <div className="border-muted space-y-2 border-t px-3 py-2">
          {/* Arguments if provided */}
          {input.arguments && Object.keys(input.arguments).length > 0 && (
            <div>
              <div className="text-muted-foreground mb-1 text-xs">Arguments:</div>
              <pre className="bg-background max-h-40 overflow-auto rounded-md p-2 text-xs">
                <code>{JSON.stringify(input.arguments, null, 2)}</code>
              </pre>
            </div>
          )}

          {/* Output */}
          {output !== undefined && (
            <div>
              <div className="text-muted-foreground mb-1 text-xs">Result:</div>
              <pre className="bg-background max-h-60 overflow-auto rounded-md p-2 text-xs">
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
            <div className="text-muted-foreground text-xs italic">Calling MCP tool...</div>
          )}

          {/* Pending state */}
          {state.status === 'pending' && (
            <div className="text-muted-foreground text-xs italic">Waiting to call...</div>
          )}
        </div>
      )}
    </div>
  );
}
