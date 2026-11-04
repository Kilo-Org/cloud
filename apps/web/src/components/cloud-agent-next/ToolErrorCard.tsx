'use client';

import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { normalizeTerminalOutput } from './normalize-terminal-output';

type ToolErrorCardProps = {
  toolName: string;
  error: string;
  context?: string;
};

export function ToolErrorCard({ toolName, error, context }: ToolErrorCardProps) {
  return (
    <Alert variant="destructive" className="border-destructive/25 rounded-md px-3 py-2">
      <AlertCircle />
      <AlertTitle className="text-xs">
        Failed: <span className="font-mono">{toolName}</span>
      </AlertTitle>
      {context && <code className="col-start-2 min-w-0 text-xs break-all">{context}</code>}
      <AlertDescription
        role="region"
        aria-label={`${toolName} error`}
        tabIndex={0}
        className="focus-visible:ring-ring max-h-60 min-w-0 overflow-auto text-xs whitespace-pre-wrap focus-visible:ring-2 focus-visible:outline-none [overflow-wrap:anywhere]"
      >
        {normalizeTerminalOutput(error).trim() || 'The tool did not complete.'}
      </AlertDescription>
    </Alert>
  );
}
