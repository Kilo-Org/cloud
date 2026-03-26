import { Terminal } from 'lucide-react';
import type { ToolPart } from './types';
import { ToolCardShell } from './ToolCardShell';

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

export function BashToolCard({ toolPart }: BashToolCardProps) {
  const state = toolPart.state;
  const input = state.input as BashInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;
  const commandPreview = getCommandPreview(input.command);

  return (
    <ToolCardShell icon={Terminal} title="Shell" subtitle={commandPreview} status={state.status}>
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
        <div className="text-muted-foreground truncate font-mono text-xs">cwd: {input.workdir}</div>
      )}

      {/* Output */}
      {output != null && output !== '' && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Output:</div>
          <pre className="bg-background max-h-80 overflow-auto rounded-md p-2 text-xs">
            <code>{output}</code>
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
    </ToolCardShell>
  );
}
